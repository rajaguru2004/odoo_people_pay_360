import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import {
  assertInBranch,
  getEffectiveBranchId,
} from '../common/branch/branch-scope.util';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { CompanyIdentityService } from './company-identity.service';
import {
  DOCUMENT_CONTEXT_RESOLVERS,
  DocumentContextResolver,
  DocumentSubjectRequest,
  subjectKey,
} from './document-context.registry';
import { DocumentRenderService } from './document-render.service';
import { DocumentTemplateService } from './document-template.service';
import { LetterheadService } from './letterhead.service';
import {
  DocumentTypeDef,
  getDocumentType,
  roleMaySeeSensitivity,
} from './document-types';

type Principal = {
  id?: string;
  userId?: string;
  role: string;
  employeeId?: string | null;
  isGlobalBranchAccess?: boolean;
};

export interface GenerateRequest {
  typeKey: string;
  locale?: string;
  employeeId?: string | null;
  subjectId?: string | null;
  params?: Record<string, unknown>;
}

@Injectable()
export class DocumentGenerationService {
  private readonly logger = new Logger(DocumentGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly settings: SystemSettingsService,
    private readonly templates: DocumentTemplateService,
    private readonly render: DocumentRenderService,
    private readonly identity: CompanyIdentityService,
    private readonly letterheads: LetterheadService,
    @Inject(DOCUMENT_CONTEXT_RESOLVERS)
    private readonly resolvers: DocumentContextResolver[],
  ) {}

  private resolverFor(typeKey: string): DocumentContextResolver {
    const r = this.resolvers.find((x) => x.typeKeys.includes(typeKey));
    if (!r) {
      // A type in the catalogue with no resolver behind it is a programming
      // error, not a user error — and the drift guard in document-types.spec.ts
      // exists to make it impossible to ship. Saying so plainly beats a
      // "cannot read property of undefined" three frames deeper.
      throw new ServiceUnavailableException(
        `No data resolver is registered for document type "${typeKey}".`,
      );
    }
    return r;
  }

  /**
   * Role gate for generating a document ABOUT SOMEONE ELSE.
   *
   * Self-service is decided separately, by the resolver, because only the
   * owning domain knows what "self" means for its records.
   */
  private assertRoleMay(type: DocumentTypeDef, user: Principal): void {
    const isSelf = type.selfService && user.role === 'EMPLOYEE';
    if (!isSelf && !type.allowedRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Your role cannot generate a ${type.name.toLowerCase()}.`,
      );
    }
    if (!isSelf && !roleMaySeeSensitivity(user.role, type.sensitivity)) {
      throw new ForbiddenException(
        `A ${type.name.toLowerCase()} contains information your role may not read about another employee.`,
      );
    }
  }

  /**
   * Generate ONE document and persist it.
   *
   * Every piece of I/O — the render and the upload — completes BEFORE the
   * transaction opens. That ordering is what lets the two writes be one
   * transaction at all, and the compensating delete afterwards exists because
   * a rollback cannot reach object storage: the row would vanish and the bytes
   * would stay, orphaned and unreferenced.
   */
  async generateOne(req: GenerateRequest, user: Principal) {
    if ((await this.settings.getSetting('document_engine_enabled', 'false')) !== 'true') {
      throw new NotFoundException(
        'The document engine is turned off on this deployment. An administrator can enable it in Settings (document_engine_enabled).',
      );
    }

    const type = getDocumentType(req.typeKey);
    if (!type) throw new NotFoundException(`Unknown document type "${req.typeKey}"`);
    this.assertRoleMay(type, user);

    if (!(await this.render.isAvailable())) {
      throw new ServiceUnavailableException(
        'PDF rendering is unavailable on this deployment. Either the pdf_enabled setting is off, or no Chromium binary is installed in the image.',
      );
    }

    const subject: DocumentSubjectRequest = {
      employeeId: req.employeeId ?? null,
      subjectId: req.subjectId ?? null,
      params: req.params ?? {},
    };

    // The domain decides. Throws — never returns false — so a resolver that
    // forgets the check cannot silently allow.
    const resolver = this.resolverFor(type.key);
    await resolver.assertMayRead(subject, user);

    const branchId = await this.branchForDocument(subject);
    const locale = req.locale ?? 'en';

    const template = await this.templates.resolveForGeneration(type.key, locale, branchId);
    if (!template?.publishedVersion) {
      throw new NotFoundException(
        `No published ${type.name.toLowerCase()} template is available. An administrator can publish one in Settings → Document templates.`,
      );
    }
    const version = template.publishedVersion;

    const contexts = await resolver.build([subject], user);
    const data = contexts.get(subjectKey(subject));
    if (!data) throw new NotFoundException(`${type.name} not found`);

    const identity = await this.identity.resolve(branchId);
    const serialNumber = type.serialized ? await this.nextSerial(type.key) : null;

    const context = {
      ...identity,
      ...data,
      companyLogoUrl: await this.render.logoDataUri(),
      issueDate: new Date().toLocaleDateString('en-GB'),
      serialNumber: serialNumber ?? '',
      verifyUrl: serialNumber ? `/letters/verify/${serialNumber}` : '',
    };

    // The letterhead PINNED to this published version, not whatever is
    // current: a document reissued next year must look like the one issued
    // today, and swapping stationery is a publish rather than an edit.
    const letterhead = version.letterheadId
      ? await this.letterheads.dataUriFor(version.letterheadId)
      : null;

    const pdf = await this.render.render(
      {
        bodyHtml: version.bodyHtml,
        styleCss: version.styleCss,
        footerHtml: version.footerHtml,
        pageFormat: version.pageFormat,
        orientation: version.orientation,
        locale: template.locale,
        letterhead,
      },
      context,
      // A published version is immutable, so its id is a cache key that can
      // never go stale — the invalidation bug that key-by-updatedAt invites
      // simply cannot arise here.
      { cacheKey: version.id },
    );

    const fileName = `${serialNumber ?? type.key}-${Date.now()}.pdf`;
    const privateRef = await this.storage.uploadPrivateFile(pdf, fileName, 'documents');

    try {
      return await this.prisma.$transaction(async (tx) => {
        let employeeDocumentId: string | null = null;
        if (type.vaultDocumentType && subject.employeeId) {
          const vaultDoc = await tx.employeeDocument.create({
            data: {
              employeeId: subject.employeeId,
              documentType: type.vaultDocumentType,
              fileName: `${type.name}${serialNumber ? ` — ${serialNumber}` : ''}.pdf`,
              // Empty, not the private ref: fileUrl is the LEGACY public-bucket
              // column and anything that reads it treats the value as a URL.
              // The bytes are addressed by privateRef, through the authenticated
              // door only.
              fileUrl: '',
              privateRef,
              mimeType: 'application/pdf',
              fileSize: pdf.length,
              isSystemGenerated: true,
              uploadedBy: user.id ?? user.userId ?? null,
            },
            select: { id: true },
          });
          employeeDocumentId = vaultDoc.id;
        }

        const generated = await tx.generatedDocument.create({
          data: {
            typeKey: type.key,
            locale: template.locale,
            // Stamped EXPLICITLY: PrismaService only auto-fills branchId when
            // effectiveBranchId is non-null, and a global admin who has not
            // narrowed the picker has null — which would violate NOT NULL.
            branchId,
            templateVersionId: version.id,
            templateContentHash: version.contentHash,
            employeeId: subject.employeeId,
            subjectType: type.subjectType,
            subjectId: subject.subjectId,
            params: (req.params ?? {}) as object,
            serialNumber,
            privateRef,
            fileName,
            fileSize: pdf.length,
            employeeDocumentId,
            generatedById: (user.id ?? user.userId)!,
          },
        });

        await this.audit.log({
          userId: user.id ?? user.userId,
          action: 'DOCUMENT_GENERATED',
          resourceType: 'GeneratedDocument',
          resourceId: generated.id,
          newData: { typeKey: type.key, versionId: version.id, employeeId: subject.employeeId },
          branchId,
        });

        return {
          documentId: generated.id,
          fileName,
          serialNumber,
          downloadPath: `/secure-files/generated-document/${generated.id}`,
        };
      });
    } catch (err) {
      // The bytes are already in object storage and a transaction rollback
      // cannot reach them. Hand-delete, or the bucket accumulates files no row
      // points at and nothing will ever clean up.
      await this.storage.deletePrivateFile(privateRef).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Which branch ISSUED the document.
   *
   * The subject's branch when there is one, else the caller's current branch.
   * Deliberately not "the employee's branch at download time": a transfer
   * afterwards must not retroactively move a document already sent to a bank.
   */
  private async branchForDocument(subject: DocumentSubjectRequest): Promise<string> {
    if (subject.employeeId) {
      const employee = await runWithBranchBypass(() =>
        this.prisma.employee.findUnique({
          where: { id: subject.employeeId! },
          select: { branchId: true },
        }),
      );
      if (employee?.branchId) return employee.branchId;
    }
    const effective = getEffectiveBranchId();
    if (effective) return effective;
    throw new BadRequestException(
      'Select a branch before generating a company-wide document.',
    );
  }

  /** Serial from the database sequence, never MAX()+1 — concurrent issues collide. */
  private async nextSerial(typeKey: string): Promise<string> {
    const rows = await this.prisma.$queryRawUnsafe<{ nextval: bigint }[]>(
      `SELECT nextval('document_serial_seq') AS nextval`,
    );
    const n = Number(rows[0].nextval);
    const prefix = typeKey.split('_')[0].slice(0, 6).toUpperCase();
    return `${prefix}-${new Date().getFullYear()}-${String(n).padStart(5, '0')}`;
  }

  /**
   * Documents generated about one employee.
   *
   * Takes the employee id from the CALLER's token at the controller, never
   * from a parameter — the one shape of this query that cannot be pointed at
   * somebody else.
   */
  async listForEmployee(employeeId: string | null, typeKey?: string) {
    if (!employeeId) return [];
    const rows = await this.prisma.generatedDocument.findMany({
      where: { employeeId, ...(typeKey ? { typeKey } : {}) },
      orderBy: { generatedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        typeKey: true,
        locale: true,
        fileName: true,
        serialNumber: true,
        generatedAt: true,
      },
    });
    return rows.map((r) => ({
      ...r,
      typeName: getDocumentType(r.typeKey)?.name ?? r.typeKey,
      downloadPath: `/secure-files/generated-document/${r.id}`,
    }));
  }

  /** A generated document the caller is allowed to download. */
  async fileFor(id: string, user: Principal) {
    const doc = await this.prisma.generatedDocument.findUnique({
      where: { id },
      select: {
        id: true,
        typeKey: true,
        employeeId: true,
        branchId: true,
        privateRef: true,
        fileName: true,
      },
    });
    // NotFound rather than Forbidden throughout: a 403 would confirm the
    // document exists, which is itself a disclosure.
    if (!doc) throw new NotFoundException('Document not found');
    await assertInBranch(doc.branchId);

    const type = getDocumentType(doc.typeKey);
    if (!type) throw new NotFoundException('Document not found');

    const isOwner = Boolean(user.employeeId && user.employeeId === doc.employeeId);
    if (!isOwner) {
      if (!roleMaySeeSensitivity(user.role, type.sensitivity)) {
        throw new NotFoundException('Document not found');
      }
      if (!type.allowedRoles.includes(user.role)) {
        throw new NotFoundException('Document not found');
      }
    }

    return { privateRef: doc.privateRef, fileName: doc.fileName, mimeType: 'application/pdf' };
  }
}
