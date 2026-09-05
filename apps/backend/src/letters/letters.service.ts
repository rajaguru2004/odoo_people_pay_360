import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { StorageService } from '../storage/storage.service';
import { PdfService } from '../pdf/pdf.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { getBranchContext } from '../common/branch/branch-context';
import { LETTER_TEMPLATE_DEFAULTS } from './letter-defaults';
import { RequestLetterDto } from './dto/request-letter.dto';
import { UpsertLetterTemplateDto } from './dto/upsert-letter-template.dto';
import { ProfileTemplateResolverService } from '../profile-templates/profile-template-resolver.service';
import { readFormatted } from '../profile-templates/employee-field-values';
import { BrandAssetService } from '../documents/brand-asset.service';

@Injectable()
export class LettersService implements OnModuleInit {
  private readonly logger = new Logger(LettersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SystemSettingsService,
    private readonly storage: StorageService,
    private readonly pdf: PdfService,
    private readonly templates: ProfileTemplateResolverService,
    private readonly brandAssets: BrandAssetService,
  ) {}

  /**
   * Seed the shipped templates. `update: {}` on purpose — this runs on every
   * boot, so writing the body here would overwrite HR's wording every restart.
   */
  async onModuleInit() {
    try {
      for (const t of LETTER_TEMPLATE_DEFAULTS) {
        await this.prisma.letterTemplate.upsert({
          where: { key_locale: { key: t.key, locale: t.locale } },
          update: {},
          create: {
            key: t.key,
            name: t.name,
            locale: t.locale,
            bodyHtml: t.bodyHtml,
            requiresApproval: t.requiresApproval,
            isActive: true,
          },
        });
      }
    } catch (e: any) {
      this.logger.warn(`Letter template seeding skipped: ${e?.message ?? e}`);
    }
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  async listTemplates(activeOnly = false) {
    const data = await this.prisma.letterTemplate.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: [{ key: 'asc' }, { locale: 'asc' }],
    });
    return { success: true, data };
  }

  async upsertTemplate(dto: UpsertLetterTemplateDto, userId: string) {
    const template = await this.prisma.letterTemplate.upsert({
      where: { key_locale: { key: dto.key, locale: dto.locale ?? 'en' } },
      update: {
        name: dto.name,
        bodyHtml: dto.bodyHtml,
        ...(dto.requiresApproval !== undefined && {
          requiresApproval: dto.requiresApproval,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
      create: {
        key: dto.key,
        name: dto.name,
        locale: dto.locale ?? 'en',
        bodyHtml: dto.bodyHtml,
        requiresApproval: dto.requiresApproval ?? true,
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit.log({
      userId,
      action: 'LETTER_TEMPLATE_UPSERT',
      resourceType: 'LetterTemplate',
      resourceId: template.id,
      newData: { key: dto.key, locale: dto.locale ?? 'en' },
    });
    return { success: true, data: template };
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  async request(employeeId: string, dto: RequestLetterDto, user: any) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, fullName: true, branchId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertInBranch(employee.branchId);

    const template = await this.prisma.letterTemplate.findUnique({
      where: { key_locale: { key: dto.templateKey, locale: dto.locale ?? 'en' } },
    });
    if (!template || !template.isActive) {
      throw new NotFoundException(
        `No active "${dto.templateKey}" template for locale "${dto.locale ?? 'en'}"`,
      );
    }

    const request = await this.prisma.letterRequest.create({
      data: {
        employeeId,
        templateKey: dto.templateKey,
        locale: dto.locale ?? 'en',
        purpose: dto.purpose ?? null,
        addressedTo: dto.addressedTo ?? null,
        status: 'PENDING',
      },
    });

    await this.audit.log({
      userId: user?.id,
      action: 'LETTER_REQUESTED',
      resourceType: 'LetterRequest',
      resourceId: request.id,
      newData: { templateKey: dto.templateKey, locale: dto.locale ?? 'en' },
      branchId: employee.branchId,
    });

    // Low-risk letters issue straight away; anything stating pay waits for HR.
    //
    // The create above and the issue below must succeed or fail together, but a
    // database transaction cannot span them: `issue()` renders a PDF through
    // headless Chromium and uploads the result to object storage — I/O measured
    // in seconds, which would pin a pool connection for its duration, and which
    // a `ROLLBACK` could not take back anyway. So the pair is made atomic by
    // COMPENSATION instead: if the inline issue fails, the request row and its
    // `LETTER_REQUESTED` audit row are undone before the error is rethrown.
    //
    // This matters more here than on the approval path: a `requiresApproval:
    // false` template has no HR queue behind it, so a PENDING row left by a
    // failed auto-issue would sit in the employee's `my-requests` for ever with
    // nobody to settle it — beside an audit row claiming a request the API
    // answered 400 to.
    if (!template.requiresApproval) {
      try {
        return await this.issue(request.id, user);
      } catch (err) {
        await this.undoRequest(request.id);
        throw err;
      }
    }

    await this.notifyHr(
      'Letter request awaiting issue',
      `${employee.fullName} requested a ${template.name}.`,
    );

    return {
      success: true,
      message: 'Letter requested. HR will review and issue it.',
      data: request,
    };
  }

  /**
   * Render, store and record the letter.
   *
   * Output goes to the PRIVATE bucket and is registered as an EmployeeDocument
   * so it shows up in the vault — a salary certificate must never be readable by
   * link alone.
   */
  async issue(id: string, user: any) {
    const request = await this.prisma.letterRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            status: true,
            position: true,
            startDate: true,
            endDate: true,
            baseSalary: true,
            branchId: true,
            customFields: true,
            department: { select: { name: true } },
            user: { select: { id: true } },
          },
        },
      },
    });
    if (!request) throw new NotFoundException('Letter request not found');
    assertInBranch(request.employee.branchId);

    if (request.status === 'ISSUED') {
      throw new BadRequestException('This letter has already been issued');
    }
    if (request.status === 'REJECTED') {
      throw new BadRequestException('This request was rejected');
    }

    // R66: a termination does not delete the employee, so this request may
    // well belong to someone who has left. That is allowed — it is stated,
    // below and in the audit row, and gates nothing.
    const isFormerEmployee = LettersService.isFormerEmployee(
      request.employee.status,
    );

    if (!(await this.pdf.isAvailable())) {
      throw new BadRequestException(
        'PDF generation is unavailable on this deployment. Enable pdf_enabled and install Chromium.',
      );
    }

    const template = await this.prisma.letterTemplate.findUnique({
      where: { key_locale: { key: request.templateKey, locale: request.locale } },
    });
    if (!template) throw new NotFoundException('Letter template not found');

    const serialNumber = await this.nextSerial(request.templateKey);
    const issueDate = new Date();

    const [companyName, companyLogoUrl, currency] = await Promise.all([
      this.settings.getSetting('company_name', 'The Company'),
      // NOT the raw company_logo_url. That is an http URL into the public
      // bucket, and PdfService renders on a page with no network — so the
      // <img> in every shipped template had no opportunity to load, and no
      // issued letter has ever carried the company logo. Inlined bytes are the
      // only form that can paint here.
      this.brandAssets.logoDataUri(),
      this.settings.getSetting('currency_code', 'OMR'),
    ]);

    // Whitelisted context — the template is admin-editable, so it must not be
    // able to reach anything that was not deliberately handed to it.
    const context = {
      companyName,
      companyLogoUrl,
      currency,
      serialNumber,
      issueDate: issueDate.toLocaleDateString('en-GB'),
      employeeName: request.employee.fullName,
      employeeCode: request.employee.employeeCode,
      position: request.employee.position ?? '—',
      department: request.employee.department?.name ?? '—',
      startDate: request.employee.startDate?.toLocaleDateString('en-GB') ?? '—',
      endDate: request.employee.endDate?.toLocaleDateString('en-GB') ?? '',
      baseSalary: Number(request.employee.baseSalary ?? 0).toLocaleString(undefined, {
        minimumFractionDigits: 3,
      }),
      purpose: request.purpose ?? '',
      addressedTo: request.addressedTo ?? '',
      // Template-driven custom fields, namespaced so `{{custom.jobGrade}}` can
      // never collide with — or shadow — a whitelisted key above.
      custom: await this.customLetterFields(request.employee),
    };

    const buffer = await this.pdf.renderHandlebars(template.bodyHtml, context, {
      format: 'A4',
      cacheKey: `${template.id}:${template.updatedAt.getTime()}`,
    });

    const fileName = `${serialNumber}.pdf`;
    const fileRef = await this.storage.uploadPrivateFile(buffer, fileName, 'letters');

    // Every piece of I/O — the render and the upload — is behind us before the
    // transaction opens, which is the whole reason these two writes CAN be one
    // transaction. They have to be: the vault document and the ISSUED row are
    // two halves of one fact, and a half-applied issue leaves either a
    // system-generated letter in the employee's vault that no request points
    // at, or an ISSUED row citing a `documentId` that was rolled back.
    const updated = await this.prisma
      .$transaction(async (tx) => {
        // Register in the vault, marked system-generated so it is
        // distinguishable from what the employee uploaded themselves.
        const document = await tx.employeeDocument.create({
          data: {
            employeeId: request.employeeId,
            documentType: 'Letter',
            fileName: `${template.name} — ${serialNumber}.pdf`,
            // fileUrl is NOT a reachable URL for a private file; privateRef is
            // the real handle and the download route is the only way through.
            fileUrl: fileRef,
            privateRef: fileRef,
            fileSize: BigInt(buffer.length),
            mimeType: 'application/pdf',
            description: template.name,
            issueDate,
            isSystemGenerated: true,
            uploadedBy: user?.id ?? null,
          },
        });

        return tx.letterRequest.update({
          where: { id },
          data: {
            status: 'ISSUED',
            serialNumber,
            fileRef,
            documentId: document.id,
            issuedById: user?.id ?? null,
            issuedAt: issueDate,
          },
        });
      })
      .catch(async (err) => {
        // The uploaded object is the one thing the rollback cannot reach, so it
        // is removed by hand rather than left as an unreferenced private blob.
        await this.storage.deletePrivateFile(fileRef).catch(() => undefined);
        throw err;
      });

    // R66: the subject's status at ISSUE TIME goes in the trail. A letter can
    // legitimately be minted for a leaver, but a SALARY_CERTIFICATE stating pay
    // that is no longer paid is a decision someone made about a former
    // employee, and the row has to say so long after the person, the queue and
    // the reason have all gone. Never read back as a gate — recorded only.
    await this.audit.log({
      userId: user?.id,
      action: 'LETTER_ISSUED',
      resourceType: 'LetterRequest',
      resourceId: id,
      newData: {
        serialNumber,
        templateKey: request.templateKey,
        employeeStatus: request.employee.status,
        isFormerEmployee,
      },
      branchId: request.employee.branchId,
    });

    if (request.employee.user?.id) {
      await this.notifications
        .create({
          userId: request.employee.user.id,
          title: 'Your letter is ready',
          message: `Your ${template.name} (${serialNumber}) has been issued and is in your documents.`,
          type: 'SUCCESS' as any,
          link: '/dashboard/my-letters',
        })
        .catch(() => undefined);
    }

    return {
      success: true,
      message: 'Letter issued.',
      data: updated,
      // Said in the response as well as the trail: the issuing HR user is the
      // one person who can still stop and check, and they see this, not the
      // audit table. `warning` and not an error — it is a fact about the
      // subject, never a refusal.
      ...(isFormerEmployee && {
        warning: `${request.employee.fullName} is no longer an active employee (status ${request.employee.status}). The letter was issued anyway.`,
      }),
    };
  }

  async reject(id: string, reason: string, user: any) {
    const request = await this.prisma.letterRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            fullName: true,
            status: true,
            branchId: true,
            user: { select: { id: true } },
          },
        },
      },
    });
    if (!request) throw new NotFoundException('Letter request not found');
    assertInBranch(request.employee.branchId);
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Only a pending request can be rejected');
    }

    const isFormerEmployee = LettersService.isFormerEmployee(
      request.employee.status,
    );

    const updated = await this.prisma.letterRequest.update({
      where: { id },
      data: { status: 'REJECTED', rejectedReason: reason },
    });

    // Recorded on the refusal for the same reason as on the issue (R66):
    // turning down a leaver's experience letter is the half of this decision
    // that someone is most likely to be asked about later.
    await this.audit.log({
      userId: user?.id,
      action: 'LETTER_REJECTED',
      resourceType: 'LetterRequest',
      resourceId: id,
      newData: {
        reason,
        employeeStatus: request.employee.status,
        isFormerEmployee,
      },
      branchId: request.employee.branchId,
    });

    if (request.employee.user?.id) {
      await this.notifications
        .create({
          userId: request.employee.user.id,
          title: 'Letter request rejected',
          message: reason,
          type: 'ERROR' as any,
          link: '/dashboard/my-letters',
        })
        .catch(() => undefined);
    }
    return {
      success: true,
      message: 'Request rejected.',
      data: updated,
      ...(isFormerEmployee && {
        warning: `${request.employee.fullName} is no longer an active employee (status ${request.employee.status}).`,
      }),
    };
  }

  /**
   * The employee card every letter list carries.
   *
   * `status` is on it because of R66. A termination writes
   * `Employee.status = 'INACTIVE'` rather than deleting the row, so
   * `LetterRequest.employeeId`'s `Cascade` never fires: an open request
   * survives its subject's exit and sits PENDING in `GET /letters?status=PENDING`
   * — the queue screen's default filter — for someone who no longer works
   * here. Nothing in this module read `Employee.status`, so HR could neither
   * see that nor find out. Issuing after an exit is LEGITIMATE (an experience
   * or service letter is most often asked for precisely then), so the status is
   * never a gate — it is projected so the queue says whose request it is.
   *
   * Selected in the same query as the name it sits beside: one round trip for
   * the whole list, not one per row.
   */
  private static readonly EMPLOYEE_CARD = {
    id: true,
    employeeCode: true,
    fullName: true,
    status: true,
    department: { select: { name: true } },
  } satisfies Prisma.EmployeeSelect;

  /**
   * R72: all three exits — `approveTermination`, `ContractsService.terminate`
   * and `EmployeesService.delete` — write `INACTIVE`, and `TERMINATED` is a
   * CONTRACT status. So "not ACTIVE" is the honest predicate for "no longer
   * with us"; keying on the string `TERMINATED` would miss every leaver.
   */
  private static isFormerEmployee(status: string | null | undefined): boolean {
    return (status ?? 'ACTIVE') !== 'ACTIVE';
  }

  /** Derive the leaver flag in memory — no extra query, per row or otherwise. */
  private withLeaverFlag<E extends { status: string }, T extends { employee: E }>(
    row: T,
  ) {
    return {
      ...row,
      employee: {
        ...row.employee,
        isFormerEmployee: LettersService.isFormerEmployee(row.employee.status),
      },
    };
  }

  async findAll(params: { status?: string } = {}) {
    const where: Prisma.LetterRequestWhereInput = {};
    if (params.status) where.status = params.status;
    const rows = await this.prisma.letterRequest.findMany({
      where,
      include: { employee: { select: LettersService.EMPLOYEE_CARD } },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: rows.map((r) => this.withLeaverFlag(r)) };
  }

  async findByEmployee(employeeId: string) {
    // The same card as `findAll`, on purpose: `my-requests` is the other half
    // of the same screen pair, and a leaver's own request is exactly the one
    // still worth chasing after an exit.
    const rows = await this.prisma.letterRequest.findMany({
      where: { employeeId },
      include: { employee: { select: LettersService.EMPLOYEE_CARD } },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: rows.map((r) => this.withLeaverFlag(r)) };
  }

  /**
   * Public verification: confirms a serial was issued, and nothing else. No
   * salary, no name — a verification endpoint that leaked the letter's contents
   * would defeat storing it privately in the first place.
   */
  async verify(serialNumber: string) {
    const request = await this.prisma.letterRequest.findUnique({
      where: { serialNumber },
      select: { serialNumber: true, templateKey: true, issuedAt: true, status: true },
    });
    if (!request || request.status !== 'ISSUED') {
      return { success: true, data: { valid: false } };
    }
    return {
      success: true,
      data: {
        valid: true,
        serialNumber: request.serialNumber,
        letterType: request.templateKey,
        issuedAt: request.issuedAt,
      },
    };
  }

  /** Resolve a letter for the secure-download route. */
  async fileFor(id: string, user: any) {
    const request = await this.prisma.letterRequest.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, branchId: true, departmentId: true } },
      },
    });
    if (!request || !request.fileRef) return null;
    assertInBranch(request.employee.branchId);

    const isOwner = request.employeeId === user?.employeeId;
    const isHr = ['ADMIN', 'HR_MANAGER'].includes(user?.role);
    if (!isOwner && !isHr) {
      // A manager has no business reading a subordinate's salary certificate.
      throw new ForbiddenException('Not permitted to download this letter');
    }

    return {
      ref: request.fileRef,
      fileName: `${request.serialNumber ?? request.id}.pdf`,
      ownerEmployeeId: request.employeeId,
    };
  }

  /**
   * `{KEY}-{YEAR}-{00001}` from a Postgres sequence.
   *
   * A sequence rather than MAX()+1: serials are printed on the letter and used
   * for verification, so two concurrent issues must not be able to collide.
   */
  /**
   * Custom template fields exposed to a letter, keyed by fieldKey.
   *
   * SENSITIVE fields are excluded outright rather than masked: a letter goes to
   * a bank, a landlord or an embassy, and "••••1234" in an employment letter is
   * both useless and a disclosure. An admin who genuinely needs a national ID on
   * a letter must un-flag the field deliberately.
   *
   * Missing keys resolve to '' so a template referencing a field the admin later
   * removed renders a blank rather than the literal placeholder text.
   */
  private async customLetterFields(employee: {
    branchId: string | null;
    customFields?: unknown;
  }): Promise<Record<string, string>> {
    const template = await this.templates.resolve(employee.branchId);
    if (!template.enabled) return {};

    const out: Record<string, string> = {};
    for (const field of template.fields) {
      if (field.storage !== 'JSONB' || !field.isActive || field.isSensitive) continue;
      out[field.fieldKey] = readFormatted(
        { employee: employee as Record<string, any> },
        field,
        { locale: 'en-GB' },
      );
    }
    return out;
  }

  /**
   * Undo a just-created letter request whose inline auto-issue failed.
   *
   * Safe to delete outright rather than mark: the row is seconds old, still
   * PENDING, and nothing references it — a failed `issue()` never reaches the
   * vault write, because the document and the ISSUED update are one
   * transaction. The audit row goes with it: `LETTER_REQUESTED` describes a
   * request the API then answered 400 to, so leaving it behind would put a
   * letter in the trail that no employee ever successfully asked for.
   *
   * Failures here are logged rather than thrown — the caller is about to
   * rethrow the ORIGINAL error, which is the one that explains what happened.
   */
  private async undoRequest(id: string): Promise<void> {
    try {
      await this.prisma.letterRequest.delete({ where: { id } });
      await this.prisma.auditLog.deleteMany({
        where: {
          action: 'LETTER_REQUESTED',
          resourceType: 'LetterRequest',
          resourceId: id,
        },
      });
    } catch (e: any) {
      this.logger.error(
        `Failed to roll back letter request ${id} after a failed auto-issue: ${
          e?.message ?? e
        }`,
      );
    }
  }

  private async nextSerial(templateKey: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('letter_serial_seq') AS nextval
    `;
    const seq = Number(rows[0]?.nextval ?? Date.now() % 100000);
    const prefix = templateKey.split('_')[0].slice(0, 6).toUpperCase();
    return `${prefix}-${new Date().getFullYear()}-${String(seq).padStart(5, '0')}`;
  }

  private async notifyHr(title: string, message: string) {
    const recipients = await this.prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'HR_MANAGER'] }, isActive: true },
      select: { id: true },
    });
    await Promise.all(
      recipients.map((r) =>
        this.notifications
          .create({
            userId: r.id,
            title,
            message,
            type: 'INFO' as any,
            link: '/dashboard/letters',
          })
          .catch(() => undefined),
      ),
    );
  }

  /** The letter desk: what is queued, and what went out this month. */
  async stats() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [byStatus, issuedThisMonth, oldestPending] = await Promise.all([
      this.prisma.letterRequest.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.letterRequest.count({
        where: { status: 'ISSUED', updatedAt: { gte: monthStart } },
      }),
      this.prisma.letterRequest.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));

    return {
      success: true,
      data: {
        pending: counts['PENDING'] ?? 0,
        byStatus: counts,
        issuedThisMonth,
        oldestPendingAt: oldestPending?.createdAt ?? null,
      },
    };
  }
}
