import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import {
  assertInBranch,
  getEffectiveBranchId,
} from '../common/branch/branch-scope.util';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { compileDocument } from './document-compiler';
import { compileAnyDocument } from './compile-dispatch';
import { AnyTemplateDoc } from './document-doc.model';
import { shippedTemplates } from './document-defaults';
import { DocumentTemplateDoc } from './document-doc.model';
import { getDocumentType } from './document-types';
import { sanitizeTemplateHtml } from './html-sanitizer';

type Principal = { id?: string; userId?: string; role: string; isGlobalBranchAccess?: boolean };

/** AuditService takes `userId?: string`, so absent must be undefined, not null. */
const userId = (u: Principal): string | undefined => u.id ?? u.userId ?? undefined;

@Injectable()
export class DocumentTemplateService implements OnModuleInit {
  private readonly logger = new Logger(DocumentTemplateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * Seed the shipped templates, once per (type, locale), as COMPANY scope.
   *
   * `create`-only, never update: this runs on every boot, so writing the body
   * here would overwrite an admin's wording on every restart. The same contract
   * the letters seeder uses (`update: {}`), and the reason
   * `DocumentTemplate.isCustomized` exists.
   *
   * Runs under branch bypass because seeding is configuration, not tenant data,
   * and there is no request branch context at boot.
   */
  async onModuleInit(): Promise<void> {
    try {
      await runWithBranchBypass(async () => {
        for (const shipped of shippedTemplates()) {
          const existing = await this.prisma.documentTemplate.findFirst({
            where: {
              typeKey: shipped.typeKey,
              locale: shipped.locale,
              branchId: null,
              isActive: true,
            },
            select: { id: true },
          });
          if (existing) continue;

          const compiled = compileDocument(shipped.doc);
          const sanitized = sanitizeTemplateHtml(compiled.bodyHtml);

          const template = await this.prisma.documentTemplate.create({
            data: {
              typeKey: shipped.typeKey,
              locale: shipped.locale,
              scope: 'COMPANY',
              branchId: null,
              name: shipped.name,
              description: shipped.description,
              origin: 'SYSTEM',
            },
          });

          // Seeded templates arrive PUBLISHED. A shipped template that landed
          // as a draft would mean a brand-new deployment could not generate a
          // single document until somebody opened the builder and pressed
          // Publish twenty-seven times.
          const version = await this.prisma.documentTemplateVersion.create({
            data: {
              templateId: template.id,
              versionNo: 1,
              status: 'PUBLISHED',
              docJson: shipped.doc as unknown as object,
              bodyHtml: sanitized.html,
              styleCss: compiled.styleCss,
              footerHtml: compiled.footerHtml,
              pageFormat: shipped.doc.page.size,
              orientation: shipped.doc.page.orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT',
              marginsMm: shipped.doc.page.margin as unknown as object,
              contentHash: hashContent(sanitized.html, compiled.styleCss, compiled.footerHtml),
              changeNote: 'Shipped default',
              publishedAt: new Date(),
            },
          });

          await this.prisma.documentTemplate.update({
            where: { id: template.id },
            data: { publishedVersionId: version.id },
          });
        }
      });
    } catch (err) {
      // A seeding failure must not stop the app booting — every other module
      // still works, and the templates are visibly absent rather than the
      // process being absent.
      this.logger.error(
        `Document template seeding failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async assertEnabled(): Promise<void> {
    const on = await this.settings.getSetting('document_engine_enabled', 'false');
    if (on !== 'true') {
      throw new NotFoundException(
        'The document template engine is turned off on this deployment. An administrator can enable it in Settings (document_engine_enabled).',
      );
    }
  }

  /**
   * Templates visible to the caller.
   *
   * Branch scoping is applied by the Prisma middleware via the
   * 'direct-or-global' rule, so a branch sees its own rows AND the company-wide
   * ones. Nothing here re-filters, because two filters that disagree is how a
   * template becomes invisible.
   */
  async list(user: Principal, filters: { typeKey?: string; locale?: string } = {}) {
    await this.assertEnabled();
    const rows = await this.prisma.documentTemplate.findMany({
      where: {
        isActive: true,
        ...(filters.typeKey ? { typeKey: filters.typeKey } : {}),
        ...(filters.locale ? { locale: filters.locale } : {}),
      },
      include: {
        publishedVersion: { select: { id: true, versionNo: true, publishedAt: true } },
        versions: { select: { id: true, status: true }, where: { status: 'DRAFT' } },
        branch: { select: { id: true, name: true } },
        _count: { select: { versions: true } },
      },
      orderBy: [{ typeKey: 'asc' }, { locale: 'asc' }],
    });

    return rows.map((t) => ({
      id: t.id,
      typeKey: t.typeKey,
      typeName: getDocumentType(t.typeKey)?.name ?? t.typeKey,
      locale: t.locale,
      name: t.name,
      description: t.description,
      scope: t.scope,
      branchId: t.branchId,
      branchName: t.branch?.name ?? null,
      origin: t.origin,
      isCustomized: t.isCustomized,
      publishedVersionId: t.publishedVersionId,
      publishedVersionNo: t.publishedVersion?.versionNo ?? null,
      publishedAt: t.publishedVersion?.publishedAt ?? null,
      hasDraft: t.versions.length > 0,
      draftVersionId: t.versions[0]?.id ?? null,
      versionCount: t._count.versions,
      updatedAt: t.updatedAt,
    }));
  }

  /**
   * Read-side branch check for template rows (D-26).
   *
   * Templates are scoped `direct-or-global`: `list()` shows a COMPANY row
   * (branchId NULL) to every branch-scoped caller, so the by-id READS must
   * agree — a card the gallery shows that 404s on click is exactly how the
   * browser suite failed for a branch-scoped HR (`assertInBranch(null)` is
   * fail-closed for non-global callers, which is right for payroll rows and
   * wrong for company stationery). Write paths keep the plain assertInBranch:
   * a scoped caller may SEE company-wide stationery, not change it.
   */
  private async assertTemplateReadable(branchId: string | null): Promise<void> {
    if (branchId !== null) await assertInBranch(branchId);
  }

  async get(id: string, _user: Principal) {
    await this.assertEnabled();
    const t = await this.prisma.documentTemplate.findUnique({
      where: { id },
      include: {
        versions: { orderBy: { versionNo: 'desc' } },
        branch: { select: { id: true, name: true } },
      },
    });
    if (!t) throw new NotFoundException('Template not found');
    await this.assertTemplateReadable(t.branchId);

    return {
      id: t.id,
      typeKey: t.typeKey,
      typeName: getDocumentType(t.typeKey)?.name ?? t.typeKey,
      locale: t.locale,
      name: t.name,
      description: t.description,
      scope: t.scope,
      branchId: t.branchId,
      branchName: t.branch?.name ?? null,
      origin: t.origin,
      isCustomized: t.isCustomized,
      publishedVersionId: t.publishedVersionId,
      versions: t.versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        status: v.status,
        changeNote: v.changeNote,
        contentHash: v.contentHash,
        publishedAt: v.publishedAt,
        archivedAt: v.archivedAt,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
      draft: t.versions.find((v) => v.status === 'DRAFT')
        ? this.versionPayload(t.versions.find((v) => v.status === 'DRAFT')!)
        : null,
      published: t.versions.find((v) => v.status === 'PUBLISHED')
        ? this.versionPayload(t.versions.find((v) => v.status === 'PUBLISHED')!)
        : null,
    };
  }

  private versionPayload(v: {
    id: string;
    versionNo: number;
    status: string;
    docJson: unknown;
    bodyHtml: string;
    styleCss: string | null;
    footerHtml: string | null;
    pageFormat: string;
    orientation: string;
    letterheadId?: string | null;
    contentHash: string;
    updatedAt: Date;
  }) {
    return {
      id: v.id,
      versionNo: v.versionNo,
      status: v.status,
      doc: v.docJson,
      bodyHtml: v.bodyHtml,
      styleCss: v.styleCss,
      footerHtml: v.footerHtml,
      pageFormat: v.pageFormat,
      orientation: v.orientation,
      // Returned so the builder can show which letter pad this draft is pinned
      // to, rather than resetting the picker to "none" every time it loads.
      letterheadId: v.letterheadId ?? null,
      contentHash: v.contentHash,
      updatedAt: v.updatedAt,
    };
  }

  /**
   * Duplicate a template into a new scope — the "customize this for my branch"
   * action.
   */
  async duplicate(
    sourceId: string,
    dto: { scope: 'COMPANY' | 'BRANCH'; branchId?: string | null; name?: string; locale?: string },
    user: Principal,
  ) {
    await this.assertEnabled();
    const source = await this.prisma.documentTemplate.findUnique({
      where: { id: sourceId },
      include: { versions: { where: { status: 'PUBLISHED' }, take: 1 } },
    });
    if (!source) throw new NotFoundException('Template not found');
    await assertInBranch(source.branchId);

    const branchId = dto.scope === 'BRANCH' ? dto.branchId ?? getEffectiveBranchId() : null;
    if (dto.scope === 'BRANCH') {
      if (!branchId) {
        throw new BadRequestException(
          'Select a branch before creating a branch-specific template.',
        );
      }
      // A single-branch admin may not create a template for a branch they
      // cannot see.
      await assertInBranch(branchId);
    } else if (!user.isGlobalBranchAccess) {
      // A company-scoped template changes every branch's stationery. An admin
      // confined to one branch must not be able to do that.
      throw new ForbiddenException(
        'Only an administrator with access to all branches can create a company-wide template.',
      );
    }

    const base = source.versions[0];
    const locale = dto.locale ?? source.locale;

    let created;
    try {
      created = await this.prisma.documentTemplate.create({
        data: {
          typeKey: source.typeKey,
          locale,
          scope: dto.scope,
          branchId,
          name: dto.name ?? `${source.name} (copy)`,
          description: source.description,
          origin: 'CUSTOM',
          isCustomized: true,
        },
      });
    } catch (err) {
      // Two partial unique indexes stand behind this: one active template per
      // (type, locale) per branch, and one company-wide fallback. Hitting
      // either is a legitimate thing for an admin to try, so it must read as an
      // explanation rather than as "Internal server error" — which is what it
      // did until this case was written.
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          dto.scope === 'COMPANY'
            ? `There is already a company-wide ${source.typeKey} template for locale "${locale}". Edit that one, or duplicate this into a branch instead.`
            : `That branch already has a ${source.typeKey} template for locale "${locale}". Edit that one instead of adding a second.`,
        );
      }
      throw err;
    }

    if (base) {
      await this.prisma.documentTemplateVersion.create({
        data: {
          templateId: created.id,
          versionNo: 1,
          status: 'DRAFT',
          docJson: base.docJson as object,
          bodyHtml: base.bodyHtml,
          styleCss: base.styleCss,
          footerHtml: base.footerHtml,
          pageFormat: base.pageFormat,
          orientation: base.orientation,
          marginsMm: base.marginsMm as object,
          letterheadId: base.letterheadId,
          contentHash: base.contentHash,
          changeNote: `Copied from ${source.name}`,
          createdById: userId(user),
        },
      });
    }

    await this.audit.log({
      userId: userId(user),
      action: 'DOCUMENT_TEMPLATE_DUPLICATED',
      resourceType: 'DocumentTemplate',
      resourceId: created.id,
      newData: { sourceId, scope: dto.scope, branchId },
    });

    return this.get(created.id, user);
  }

  /**
   * Open a new draft, optionally cloned from an archived version.
   *
   * Rollback is this operation, not a separate one: restoring never un-archives
   * a version, it clones an old one forward into a new draft. History stays
   * append-only, and no generated document's pin is ever invalidated.
   */
  async createDraft(templateId: string, fromVersionId: string | null, user: Principal) {
    await this.assertEnabled();
    const template = await this.prisma.documentTemplate.findUnique({
      where: { id: templateId },
      include: { versions: { orderBy: { versionNo: 'desc' } } },
    });
    if (!template) throw new NotFoundException('Template not found');
    await assertInBranch(template.branchId);

    if (template.versions.some((v) => v.status === 'DRAFT')) {
      throw new ConflictException(
        'This template already has a draft. Edit or discard it before starting another.',
      );
    }

    const source = fromVersionId
      ? template.versions.find((v) => v.id === fromVersionId)
      : template.versions.find((v) => v.status === 'PUBLISHED') ?? template.versions[0];
    if (fromVersionId && !source) {
      throw new NotFoundException('That version does not belong to this template.');
    }

    const nextNo = (template.versions[0]?.versionNo ?? 0) + 1;
    const draft = await this.prisma.documentTemplateVersion.create({
      data: {
        templateId,
        versionNo: nextNo,
        status: 'DRAFT',
        docJson: (source?.docJson ?? null) as object,
        bodyHtml: source?.bodyHtml ?? '',
        styleCss: source?.styleCss ?? null,
        footerHtml: source?.footerHtml ?? null,
        pageFormat: source?.pageFormat ?? 'A4',
        orientation: source?.orientation ?? 'PORTRAIT',
        marginsMm: (source?.marginsMm ?? null) as object,
        letterheadId: source?.letterheadId ?? null,
        contentHash: source?.contentHash ?? '',
        changeNote: fromVersionId ? `Restored from v${source?.versionNo}` : null,
        createdById: userId(user),
      },
    });

    if (fromVersionId) {
      await this.audit.log({
        userId: userId(user),
        action: 'DOCUMENT_TEMPLATE_ROLLED_BACK',
        resourceType: 'DocumentTemplate',
        resourceId: templateId,
        newData: { fromVersionNo: source?.versionNo, newDraftVersionNo: nextNo },
      });
    }

    return this.versionPayload(draft);
  }

  /**
   * Save a draft.
   *
   * Compiles the block document, sanitizes the result, and stores BOTH — the
   * JSON is what the builder reads back, the HTML is what renders. Sanitizing
   * before the write is deliberate: what is stored is what was approved, so no
   * later code path that reads bodyHtml can inherit unreviewed markup.
   */
  async saveDraft(
    versionId: string,
    dto: { doc: AnyTemplateDoc; expectedUpdatedAt?: string; changeNote?: string; letterheadId?: string | null },
    user: Principal,
  ) {
    await this.assertEnabled();
    const version = await this.prisma.documentTemplateVersion.findUnique({
      where: { id: versionId },
      include: { template: true },
    });
    if (!version) throw new NotFoundException('Version not found');
    // Path-scoped models are NOT auto-scoped on updateMany (PrismaService says
    // so), so the branch check has to be explicit before the write below.
    await assertInBranch(version.template.branchId);

    if (version.status !== 'DRAFT') {
      throw new ConflictException(
        'This version is published and cannot be edited. Create a new draft to make changes.',
      );
    }

    // Dialect dispatch: v1 block docs → compileDocument, v2 grapes docs →
    // compileGrapesDocument. Everything after this line is dialect-blind.
    const compiled = compileAnyDocument(dto.doc);
    const sanitized = sanitizeTemplateHtml(compiled.bodyHtml);
    const contentHash = hashContent(sanitized.html, compiled.styleCss, compiled.footerHtml);

    // Conditional write. `updateMany` rather than `update` so a stale
    // updatedAt returns a count of 0 instead of silently overwriting whatever
    // the other editor saved thirty seconds ago.
    const result = await this.prisma.documentTemplateVersion.updateMany({
      where: {
        id: versionId,
        status: 'DRAFT',
        ...(dto.expectedUpdatedAt ? { updatedAt: new Date(dto.expectedUpdatedAt) } : {}),
      },
      data: {
        docJson: dto.doc as unknown as object,
        bodyHtml: sanitized.html,
        styleCss: compiled.styleCss,
        footerHtml: compiled.footerHtml,
        pageFormat: dto.doc.page.size,
        orientation: dto.doc.page.orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT',
        marginsMm: dto.doc.page.margin as unknown as object,
        ...(dto.letterheadId !== undefined ? { letterheadId: dto.letterheadId } : {}),
        contentHash,
        changeNote: dto.changeNote ?? version.changeNote,
      },
    });

    if (result.count === 0) {
      throw new ConflictException(
        'This draft was changed by someone else since you opened it. Reload to see their edits before saving.',
      );
    }

    if (!version.template.isCustomized) {
      // From here the boot seeder leaves this template alone forever.
      await this.prisma.documentTemplate.update({
        where: { id: version.templateId },
        data: { isCustomized: true },
      });
    }

    const saved = await this.prisma.documentTemplateVersion.findUnique({ where: { id: versionId } });
    // Merge what the GRAPES TRANSFORM removed (remote images) with what the
    // SANITIZER removed — the UI's one "removed for safety" message covers both.
    return {
      ...this.versionPayload(saved!),
      removed: [...(compiled.removed ?? []), ...sanitized.removed],
    };
  }

  /**
   * Publish a draft.
   *
   * One transaction: archive the current published row, flip the draft, point
   * the template at it. The two partial unique indexes mean a concurrent second
   * publish fails AT THE DATABASE rather than racing here — a check-then-write
   * in this method could not promise that.
   */
  async publish(versionId: string, expectedContentHash: string | undefined, user: Principal) {
    await this.assertEnabled();
    const version = await this.prisma.documentTemplateVersion.findUnique({
      where: { id: versionId },
      include: { template: true },
    });
    if (!version) throw new NotFoundException('Version not found');
    await assertInBranch(version.template.branchId);

    if (version.status !== 'DRAFT') {
      throw new ConflictException('Only a draft can be published.');
    }
    if (expectedContentHash && expectedContentHash !== version.contentHash) {
      throw new ConflictException(
        'This draft changed since you reviewed it. Reload and check the changes before publishing.',
      );
    }
    if (!version.bodyHtml?.trim()) {
      throw new BadRequestException('This template is empty. Add some content before publishing.');
    }

    try {
      // BYPASS, deliberately, and only after assertInBranch above has already
      // authorised the caller against the template's own branch.
      //
      // A version is scoped through its template (`{ path: ['template'] }`), so
      // a scoped read AND-composes `template.branchId IN (...)`. A COMPANY
      // template carries branchId NULL, and NULL never matches an IN list — so
      // with a branch selected in the header, the "find the currently published
      // version" read below came back EMPTY, the archive step was skipped, and
      // flipping the draft to PUBLISHED hit the one-published partial index.
      // Every publish then failed with "Someone else published a version of
      // this template a moment ago" while nobody else had published anything.
      //
      // This is the same NULL-never-matches trap that `direct-or-global` exists
      // to solve for the template row itself; a path-scoped child cannot use
      // that rule, so the guard is explicit instead — which is exactly what the
      // middleware's own warning tells callers to do.
      await runWithBranchBypass(() =>
        this.prisma.$transaction(async (tx) => {
          const current = await tx.documentTemplateVersion.findFirst({
            where: { templateId: version.templateId, status: 'PUBLISHED' },
          });
          if (current) {
            await tx.documentTemplateVersion.update({
              where: { id: current.id },
              data: { status: 'ARCHIVED', archivedAt: new Date() },
            });
          }
          await tx.documentTemplateVersion.update({
            where: { id: versionId },
            data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: userId(user) },
          });
          await tx.documentTemplate.update({
            where: { id: version.templateId },
            data: { publishedVersionId: versionId },
          });
        }),
      );
    } catch (err) {
      // The partial unique index is what fires here when two admins publish at
      // the same instant. Translated rather than surfaced raw, because
      // "unique constraint violated" tells the second admin nothing.
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'Someone else published a version of this template a moment ago. Reload to see it.',
        );
      }
      throw err;
    }

    await this.audit.log({
      userId: userId(user),
      action: 'DOCUMENT_TEMPLATE_PUBLISHED',
      resourceType: 'DocumentTemplate',
      resourceId: version.templateId,
      newData: { versionId, versionNo: version.versionNo, contentHash: version.contentHash },
    });

    return this.get(version.templateId, user);
  }

  /** Discard a draft. Published history is untouched. */
  async discardDraft(versionId: string, user: Principal) {
    await this.assertEnabled();
    const version = await this.prisma.documentTemplateVersion.findUnique({
      where: { id: versionId },
      include: { template: true },
    });
    if (!version) throw new NotFoundException('Version not found');
    await assertInBranch(version.template.branchId);
    if (version.status !== 'DRAFT') {
      throw new ConflictException('Only a draft can be discarded.');
    }
    await this.prisma.documentTemplateVersion.delete({ where: { id: versionId } });
    await this.audit.log({
      userId: userId(user),
      action: 'DOCUMENT_TEMPLATE_DRAFT_DISCARDED',
      resourceType: 'DocumentTemplate',
      resourceId: version.templateId,
      oldData: { versionId, versionNo: version.versionNo },
    });
    return { success: true };
  }

  /**
   * A version plus its type key, for the preview routes.
   *
   * Branch-checked here rather than in the controller, because a version is
   * path-scoped through its template and the Prisma middleware does not scope
   * a findUnique by id.
   */
  async getVersionForPreview(versionId: string, _user: Principal) {
    await this.assertEnabled();
    const version = await this.prisma.documentTemplateVersion.findUnique({
      where: { id: versionId },
      include: { template: { select: { branchId: true, typeKey: true } } },
    });
    if (!version) throw new NotFoundException('Version not found');
    await this.assertTemplateReadable(version.template.branchId);
    return { ...version, typeKey: version.template.typeKey };
  }

  /**
   * The template that a given (type, locale, branch) actually resolves to.
   *
   * Branch override first, then the company row, then the same type in the
   * default locale. The last step matters: a request for an Arabic letter when
   * only an English template exists must produce an English letter rather than
   * nothing at all.
   */
  async resolveForGeneration(typeKey: string, locale: string, branchId: string | null) {
    return runWithBranchBypass(async () => {
      const candidates = await this.prisma.documentTemplate.findMany({
        where: { typeKey, isActive: true, publishedVersionId: { not: null } },
        include: { publishedVersion: true },
      });
      const pick =
        candidates.find((c) => c.branchId === branchId && c.locale === locale) ??
        candidates.find((c) => c.branchId === null && c.locale === locale) ??
        candidates.find((c) => c.branchId === branchId) ??
        candidates.find((c) => c.branchId === null);
      return pick ?? null;
    });
  }
}

function hashContent(body: string, css: string | null, footer: string | null): string {
  return createHash('sha256').update(`${body} ${css ?? ''} ${footer ?? ''}`).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'P2002');
}
