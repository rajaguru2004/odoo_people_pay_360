import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { withFullName } from '../common/utils/employee-name.util';
import { LETTER_TEMPLATE_DEFAULTS } from './letter-defaults';
import { renderLetterTemplate } from './letter-template.util';
import { RequestLetterDto } from './dto/request-letter.dto';
import { UpsertLetterTemplateDto } from './dto/upsert-letter-template.dto';
import type { Principal } from '../auth/auth.service';

/**
 * Where issued letters live.
 *
 * Deliberately NOT under `uploads/`, which `main.ts` serves statically: a
 * salary certificate states somebody's pay, and a file reachable by guessing a
 * URL is readable by anybody who guesses it. Everything here is served through
 * `GET /secure-files/letter/:id`, which checks the caller first.
 */
const LETTER_STORE = join(process.cwd(), 'storage');

/** The two roles that may download somebody else's letter. */
const HR_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.HR_MANAGER];

/** Draws the serial numbers printed on issued letters. */
const SERIAL_SEQUENCE = 'letter_serial_seq';

const EMPLOYEE_CARD = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  status: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

type LetterRow = Prisma.LetterRequestGetPayload<{
  include: { employee: { select: typeof EMPLOYEE_CARD } };
}>;

/**
 * A termination writes a status, it does not delete the row, so `TERMINATED`
 * would miss every other way somebody leaves. "Not ACTIVE" is the honest
 * predicate for "no longer with us".
 */
function isFormerEmployee(status: string | null | undefined): boolean {
  return (status ?? 'ACTIVE') !== 'ACTIVE';
}

@Injectable()
export class LettersService implements OnModuleInit {
  private readonly logger = new Logger(LettersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  /**
   * Seed the shipped templates and make sure the serial sequence exists.
   *
   * `update: {}` on purpose — this runs on every boot, so writing the body here
   * would overwrite HR's own wording on every restart.
   */
  async onModuleInit() {
    try {
      await this.prisma.$executeRawUnsafe(
        `CREATE SEQUENCE IF NOT EXISTS ${SERIAL_SEQUENCE}`,
      );
      for (const template of LETTER_TEMPLATE_DEFAULTS) {
        await this.prisma.letterTemplate.upsert({
          where: {
            key_locale: { key: template.key, locale: template.locale },
          },
          update: {},
          create: {
            key: template.key,
            name: template.name,
            locale: template.locale,
            bodyHtml: template.bodyHtml,
            requiresApproval: template.requiresApproval,
            isActive: true,
          },
        });
      }
    } catch (error) {
      // A boot-time convenience must never stop the app coming up.
      this.logger.warn(
        `Letter template seeding skipped: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  // ── Templates ──────────────────────────────────────────────────────────────

  async listTemplates(activeOnly = false) {
    return this.prisma.letterTemplate.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: [{ key: 'asc' }, { locale: 'asc' }],
    });
  }

  async upsertTemplate(dto: UpsertLetterTemplateDto, userId: string) {
    const locale = dto.locale ?? 'en';
    const template = await this.prisma.letterTemplate.upsert({
      where: { key_locale: { key: dto.key, locale } },
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
        locale,
        bodyHtml: dto.bodyHtml,
        requiresApproval: dto.requiresApproval ?? true,
        isActive: dto.isActive ?? true,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'LETTER_TEMPLATE_UPSERT',
        entityType: 'LetterTemplate',
        entityId: template.id,
        metadata: { key: dto.key, locale },
      },
    });
    return template;
  }

  // ── Requests ───────────────────────────────────────────────────────────────

  async request(
    employeeId: string | null | undefined,
    dto: RequestLetterDto,
    user: Principal,
  ) {
    if (!employeeId) {
      throw new BadRequestException(
        'Only a user attached to an employee record can request a letter',
      );
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const locale = dto.locale ?? 'en';
    const template = await this.prisma.letterTemplate.findUnique({
      where: { key_locale: { key: dto.templateKey, locale } },
    });
    if (!template?.isActive) {
      throw new NotFoundException(
        `No active "${dto.templateKey}" template for locale "${locale}"`,
      );
    }

    const request = await this.prisma.letterRequest.create({
      data: {
        employeeId,
        templateKey: dto.templateKey,
        locale,
        purpose: dto.purpose ?? null,
        addressedTo: dto.addressedTo ?? null,
        status: 'PENDING',
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: 'LETTER_REQUESTED',
        entityType: 'LetterRequest',
        entityId: request.id,
        metadata: { templateKey: dto.templateKey, locale },
      },
    });

    // A low-risk letter issues straight away; anything stating pay waits.
    //
    // The create above and the issue below have to succeed or fail together,
    // and a database transaction cannot span them because issuing writes a file
    // outside the database. So the pair is made atomic by COMPENSATION: a
    // failed inline issue undoes the request row before rethrowing. It matters
    // here more than on the approval path — a `requiresApproval: false`
    // template has no HR queue behind it, so a PENDING row left by a failed
    // auto-issue would sit in the employee's list for ever with nobody to
    // settle it.
    if (!template.requiresApproval) {
      try {
        return await this.issue(request.id, user);
      } catch (error) {
        await this.undoRequest(request.id);
        throw error;
      }
    }

    return request;
  }

  /**
   * Render, number and file the letter.
   *
   * The rendered document is written to the private store and registered as an
   * `EmployeeDocument`, so it appears in the employee's vault the moment it is
   * issued and is downloadable only through the authenticated route.
   */
  async issue(id: string, user: Principal) {
    const request = await this.prisma.letterRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            status: true,
            position: true,
            hireDate: true,
            exitDate: true,
            department: { select: { name: true } },
            salaryStructure: {
              select: {
                currency: true,
                lines: {
                  select: {
                    amount: true,
                    component: { select: { type: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!request) throw new NotFoundException('Letter request not found');
    if (request.status === 'ISSUED') {
      throw new BadRequestException('This letter has already been issued');
    }
    if (request.status === 'REJECTED') {
      throw new BadRequestException('This request was rejected');
    }

    const template = await this.prisma.letterTemplate.findUnique({
      where: {
        key_locale: { key: request.templateKey, locale: request.locale },
      },
    });
    if (!template) throw new NotFoundException('Letter template not found');

    // A termination does not delete the employee, so this request may well
    // belong to somebody who has left. That is allowed — an experience letter
    // is most often asked for precisely then — and is stated rather than
    // blocked.
    const formerEmployee = isFormerEmployee(request.employee.status);

    const serialNumber = await this.nextSerial(request.templateKey);
    const issueDate = new Date();

    const [companyName, logoUrl, fallbackCurrency] = await Promise.all([
      this.settings.get('company_name'),
      this.settings.get('company_logo_url'),
      this.settings.get('default_currency'),
    ]);

    const structure = request.employee.salaryStructure;
    const currency = structure?.currency ?? fallbackCurrency ?? 'OMR';
    const gross = (structure?.lines ?? [])
      .filter((line) => line.component.type === 'EARNING')
      .reduce((sum, line) => sum + Number(line.amount), 0);

    // A whitelisted context. The template is editable through the API, so it
    // must not be able to reach anything it was not deliberately handed.
    const context = {
      companyName: companyName ?? 'The Company',
      companyLogoUrl: logoUrl ?? '',
      currency,
      serialNumber,
      issueDate: formatLetterDate(issueDate),
      employeeName: [request.employee.firstName, request.employee.lastName]
        .filter(Boolean)
        .join(' '),
      employeeCode: request.employee.employeeCode,
      position: request.employee.position ?? '—',
      department: request.employee.department?.name ?? '—',
      startDate: formatLetterDate(request.employee.hireDate),
      endDate: formatLetterDate(request.employee.exitDate),
      // Thousandths, because the currencies this runs on are — a certificate
      // rounding OMR to hundredths states a different salary.
      baseSalary: gross.toLocaleString('en-GB', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      }),
      purpose: request.purpose ?? '',
      addressedTo: request.addressedTo ?? '',
    };

    const document = renderLetterTemplate(template.bodyHtml, context);
    const fileRef = `letters/${serialNumber}.html`;
    const absolutePath = join(LETTER_STORE, fileRef);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, document, 'utf8');

    // Every write outside the database is behind us, which is the whole reason
    // these two rows CAN be one transaction. They have to be: the vault entry
    // and the ISSUED row are two halves of one fact, and a half-applied issue
    // leaves either a letter in the vault no request points at, or an ISSUED
    // row citing a document that was rolled back.
    const updated = await this.prisma
      .$transaction(async (tx) => {
        const vaultEntry = await tx.employeeDocument.create({
          data: {
            employeeId: request.employeeId,
            documentType: 'Letter',
            fileName: `${template.name} — ${serialNumber}.html`,
            fileUrl: fileRef,
            // The real handle. Its presence is what marks the file private, so
            // the vault serves it through the authenticated route only.
            privateRef: fileRef,
            fileSize: BigInt(Buffer.byteLength(document, 'utf8')),
            mimeType: 'text/html',
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
            documentId: vaultEntry.id,
            issuedById: user?.id ?? null,
            issuedAt: issueDate,
          },
        });
      })
      .catch(async (error) => {
        // The written file is the one thing a rollback cannot reach.
        await unlink(absolutePath).catch(() => undefined);
        throw error;
      });

    await this.prisma.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: 'LETTER_ISSUED',
        entityType: 'LetterRequest',
        entityId: id,
        // The subject's status AT ISSUE TIME. A certificate stating pay that is
        // no longer paid is a decision somebody made about a former employee,
        // and the row has to say so long after the queue and the reason have
        // gone. Recorded, never read back as a gate.
        metadata: {
          serialNumber,
          templateKey: request.templateKey,
          employeeStatus: request.employee.status,
          formerEmployee,
        },
      },
    });

    return {
      ...updated,
      // Said in the response as well as the trail: the issuing user is the one
      // person who can still stop and check, and they see this rather than the
      // audit table. A warning, never a refusal.
      ...(formerEmployee && {
        warning: `${context.employeeName} is no longer an active employee (status ${request.employee.status}). The letter was issued anyway.`,
      }),
    };
  }

  async reject(id: string, reason: string, user: Principal) {
    const request = await this.prisma.letterRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: { firstName: true, lastName: true, status: true },
        },
      },
    });
    if (!request) throw new NotFoundException('Letter request not found');
    if (request.status !== 'PENDING') {
      throw new BadRequestException('Only a pending request can be rejected');
    }

    const formerEmployee = isFormerEmployee(request.employee.status);
    const updated = await this.prisma.letterRequest.update({
      where: { id },
      data: { status: 'REJECTED', rejectedReason: reason },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: 'LETTER_REJECTED',
        entityType: 'LetterRequest',
        entityId: id,
        // Recorded on the refusal for the same reason as on the issue: turning
        // down a leaver's experience letter is the half of this decision
        // somebody is most likely to be asked about later.
        metadata: {
          reason,
          employeeStatus: request.employee.status,
          formerEmployee,
        },
      },
    });

    const name = [request.employee.firstName, request.employee.lastName]
      .filter(Boolean)
      .join(' ');
    return {
      ...updated,
      ...(formerEmployee && {
        warning: `${name} is no longer an active employee (status ${request.employee.status}).`,
      }),
    };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * The card every letter list carries.
   *
   * `status` is on it because a request survives its subject's exit: the
   * cascade never fires on a termination, so an open request sits PENDING in
   * the queue's default filter for somebody who no longer works here. Issuing
   * after an exit is legitimate, so the status is never a gate — it is
   * projected so the queue can say whose request it is.
   */
  private card(row: LetterRow) {
    return {
      ...row,
      employee: {
        ...withFullName(row.employee),
        isFormerEmployee: isFormerEmployee(row.employee.status),
      },
    };
  }

  async findAll(params: { status?: string }) {
    const where: Prisma.LetterRequestWhereInput = {};
    if (params.status) where.status = params.status;
    const rows = await this.prisma.letterRequest.findMany({
      where,
      include: { employee: { select: EMPLOYEE_CARD } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.card(row));
  }

  async findByEmployee(employeeId: string) {
    const rows = await this.prisma.letterRequest.findMany({
      where: { employeeId },
      include: { employee: { select: EMPLOYEE_CARD } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.card(row));
  }

  /**
   * Public verification: confirms a serial was issued, and nothing else.
   *
   * A bank checking a certificate has no account here. Returning the name or
   * the salary would defeat storing the letter privately in the first place.
   */
  async verify(serialNumber: string) {
    const request = await this.prisma.letterRequest.findUnique({
      where: { serialNumber },
      select: {
        serialNumber: true,
        templateKey: true,
        issuedAt: true,
        status: true,
      },
    });
    if (!request || request.status !== 'ISSUED') return { valid: false };
    return {
      valid: true,
      serialNumber: request.serialNumber,
      letterType: request.templateKey,
      issuedAt: request.issuedAt,
    };
  }

  /** Resolve a letter for the authenticated download route. */
  async fileFor(id: string, user: Principal) {
    const request = await this.prisma.letterRequest.findUnique({
      where: { id },
      select: { id: true, employeeId: true, fileRef: true, serialNumber: true },
    });
    if (!request?.fileRef) return null;

    const isOwner = request.employeeId === user?.employeeId;
    const isHr = HR_ROLES.includes(user?.role);
    if (!isOwner && !isHr) {
      // A line manager has no business reading a subordinate's salary
      // certificate.
      throw new ForbiddenException('Not permitted to download this letter');
    }

    return {
      ref: request.fileRef,
      absolutePath: join(LETTER_STORE, request.fileRef),
      fileName: `${request.serialNumber ?? request.id}.html`,
      mimeType: 'text/html',
    };
  }

  /** The letter desk: what is queued, and what has gone out this month. */
  async stats() {
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    const [byStatus, issuedThisMonth, oldestPending] = await Promise.all([
      this.prisma.letterRequest.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.letterRequest.count({
        where: { status: 'ISSUED', updatedAt: { gte: monthStart } },
      }),
      this.prisma.letterRequest.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const counts = Object.fromEntries(
      byStatus.map((row) => [row.status, row._count._all]),
    );
    return {
      pending: counts['PENDING'] ?? 0,
      byStatus: counts,
      issuedThisMonth,
      oldestPendingAt: oldestPending?.createdAt ?? null,
    };
  }

  /**
   * Undo a just-created request whose inline auto-issue failed.
   *
   * Safe to delete rather than mark: the row is seconds old, still PENDING, and
   * nothing references it — a failed issue never reaches the vault write. The
   * audit row goes with it, because `LETTER_REQUESTED` would otherwise describe
   * a request the API answered an error to.
   *
   * Failures here are logged rather than thrown: the caller is about to rethrow
   * the ORIGINAL error, which is the one that explains what happened.
   */
  private async undoRequest(id: string): Promise<void> {
    try {
      await this.prisma.letterRequest.delete({ where: { id } });
      await this.prisma.auditLog.deleteMany({
        where: {
          action: 'LETTER_REQUESTED',
          entityType: 'LetterRequest',
          entityId: id,
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not roll back letter request ${id} after a failed auto-issue: ${
          (error as Error)?.message ?? error
        }`,
      );
    }
  }

  /**
   * `{KEY}-{YEAR}-{00001}`, drawn from a Postgres sequence.
   *
   * A sequence rather than `MAX() + 1`: the serial is printed on the letter and
   * used to verify it, so two concurrent issues must not be able to collide.
   */
  private async nextSerial(templateKey: string): Promise<string> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ nextval: bigint }>>(
      `SELECT nextval('${SERIAL_SEQUENCE}') AS nextval`,
    );
    const seq = Number(rows[0]?.nextval ?? Date.now() % 100000);
    const prefix = templateKey.split('_')[0].slice(0, 6).toUpperCase();
    return `${prefix}-${new Date().getFullYear()}-${String(seq).padStart(5, '0')}`;
  }
}

/** `15/01/2026` — a date on a letter, never zone-converted. */
function formatLetterDate(value: Date | null | undefined): string {
  if (!value) return '';
  const iso = value.toISOString().slice(0, 10);
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}
