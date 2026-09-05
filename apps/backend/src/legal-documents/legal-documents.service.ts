import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  LegalDocumentCategory,
  LegalDocumentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import { addDays, daysUntil, startOfUtcDay } from '../common/utils/expiry.util';
import { CreateLegalDocumentDto } from './dto/create-legal-document.dto';
import { UpdateLegalDocumentDto } from './dto/update-legal-document.dto';
import { ListLegalDocumentsDto } from './dto/list-legal-documents.dto';
import { RenewLegalDocumentDto } from './dto/renew-legal-document.dto';

const ALERT_DAYS_KEY = 'visa_expiry_alert_days';
const ALERT_DAYS_FALLBACK = 30;

const DOCUMENT_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: true,
      nationality: true,
      department: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.EmployeeLegalDocumentInclude;

/** The subset every derived field is computed from. */
interface ExpiringRow {
  expiryDate: Date;
}

@Injectable()
export class LegalDocumentsService {
  private readonly logger = new Logger(LegalDocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
  ) {}

  async findAll(query: ListLegalDocumentsDto) {
    const { page, limit, skip, take } = resolvePagination(query);
    const insensitive = Prisma.QueryMode.insensitive;
    const alertDays = await this.alertDays();
    const today = startOfUtcDay(new Date());
    const currentOnly = query.currentOnly ?? true;

    const where: Prisma.EmployeeLegalDocumentWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(currentOnly ? { isCurrent: true } : {}),
      ...(query.expiringWithinDays !== undefined
        ? {
            expiryDate: {
              gte: today,
              lte: addDays(today, query.expiringWithinDays),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { documentNumber: { contains: query.search, mode: insensitive } },
              {
                employee: {
                  employeeCode: { contains: query.search, mode: insensitive },
                },
              },
              {
                employee: {
                  firstName: { contains: query.search, mode: insensitive },
                },
              },
              {
                employee: {
                  lastName: { contains: query.search, mode: insensitive },
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.employeeLegalDocument.findMany({
        where,
        include: DOCUMENT_INCLUDE,
        skip,
        take,
        orderBy: { expiryDate: 'asc' },
      }),
      this.prisma.employeeLegalDocument.count({ where }),
    ]);

    return paginated(
      rows.map((row) => this.decorate(row, alertDays)),
      total,
      page,
      limit,
    );
  }

  /**
   * The counters above the visa report.
   *
   * `expired` deliberately also catches ACTIVE rows whose date has already
   * passed. The nightly job is what flips those, and between an expiry at
   * midnight and the job running the screen would otherwise report a lapsed
   * visa as active — which is the one thing this report exists to prevent.
   */
  async summary() {
    const alertDays = await this.alertDays();
    const today = startOfUtcDay(new Date());
    const horizon = addDays(today, alertDays);
    const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));

    const [active, expiringSoon, expired, cancelled, renewedThisYear] =
      await this.prisma.$transaction([
        this.prisma.employeeLegalDocument.count({
          where: {
            status: LegalDocumentStatus.ACTIVE,
            isCurrent: true,
            expiryDate: { gte: today },
          },
        }),
        this.prisma.employeeLegalDocument.count({
          where: {
            status: LegalDocumentStatus.ACTIVE,
            isCurrent: true,
            expiryDate: { gte: today, lte: horizon },
          },
        }),
        this.prisma.employeeLegalDocument.count({
          where: {
            OR: [
              { status: LegalDocumentStatus.EXPIRED },
              {
                status: LegalDocumentStatus.ACTIVE,
                expiryDate: { lt: today },
              },
            ],
          },
        }),
        this.prisma.employeeLegalDocument.count({
          where: { status: LegalDocumentStatus.CANCELLED },
        }),
        // Renewals PERFORMED this year, counted from the new rows rather than
        // from the superseded ones: a document renewed in January and again in
        // July is two renewals, and the old rows carry the dates of the terms
        // they replaced, not of the renewal.
        this.prisma.employeeLegalDocument.count({
          where: {
            renewedFromId: { not: null },
            createdAt: { gte: yearStart },
          },
        }),
      ]);

    return {
      active,
      expiringSoon,
      expired,
      cancelled,
      renewedThisYear,
      alertDays,
    };
  }

  /** The list the People hub reads. */
  async expiring(days?: number) {
    const alertDays = await this.alertDays();
    const window = days ?? alertDays;
    const today = startOfUtcDay(new Date());

    const rows = await this.prisma.employeeLegalDocument.findMany({
      where: {
        status: LegalDocumentStatus.ACTIVE,
        isCurrent: true,
        expiryDate: { gte: today, lte: addDays(today, window) },
      },
      include: DOCUMENT_INCLUDE,
      orderBy: { expiryDate: 'asc' },
    });

    return rows.map((row) => this.decorate(row, alertDays));
  }

  async findOne(id: string) {
    const document = await this.prisma.employeeLegalDocument.findUnique({
      where: { id },
      include: DOCUMENT_INCLUDE,
    });
    if (!document) throw new NotFoundException('Legal document not found');

    const alertDays = await this.alertDays();

    // The whole history for this category in one query, linked in memory. A
    // recursive fetch would be one round trip per renewal and could not detect
    // a `renewedFromId` loop written by an import — it would simply hang.
    const related = await this.prisma.employeeLegalDocument.findMany({
      where: { employeeId: document.employeeId, category: document.category },
      orderBy: { issueDate: 'asc' },
    });

    return {
      ...this.decorate(document, alertDays),
      chain: this.buildChain(document.id, related).map((row) =>
        this.decorate(row, alertDays),
      ),
    };
  }

  async create(dto: CreateLegalDocumentDto) {
    await this.assertEmployeeExists(dto.employeeId);

    const issueDate = new Date(dto.issueDate);
    const expiryDate = new Date(dto.expiryDate);
    if (expiryDate <= issueDate) {
      throw new BadRequestException(
        'The expiry date must fall after the issue date',
      );
    }

    const category = dto.category ?? LegalDocumentCategory.VISA;
    const isCurrent = dto.isCurrent ?? true;
    if (isCurrent) {
      await this.assertNoCurrentDocument(dto.employeeId, category);
    }

    const alertDays = await this.alertDays();
    const created = await this.prisma.employeeLegalDocument.create({
      data: { ...dto, category, isCurrent, issueDate, expiryDate },
      include: DOCUMENT_INCLUDE,
    });
    return this.decorate(created, alertDays);
  }

  async update(id: string, dto: UpdateLegalDocumentDto) {
    const current = await this.prisma.employeeLegalDocument.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException('Legal document not found');

    const issueDate = dto.issueDate
      ? new Date(dto.issueDate)
      : current.issueDate;
    const expiryDate = dto.expiryDate
      ? new Date(dto.expiryDate)
      : current.expiryDate;
    if (expiryDate <= issueDate) {
      throw new BadRequestException(
        'The expiry date must fall after the issue date',
      );
    }

    const category = dto.category ?? current.category;
    // Promoting a superseded row back to current, or moving it to a category
    // that already has one, would leave two documents claiming to be the live
    // one and the report would pick whichever sorted first.
    if (
      (dto.isCurrent === true && !current.isCurrent) ||
      (current.isCurrent && category !== current.category)
    ) {
      await this.assertNoCurrentDocument(current.employeeId, category, id);
    }

    const alertDays = await this.alertDays();
    const updated = await this.prisma.employeeLegalDocument.update({
      where: { id },
      data: {
        ...dto,
        issueDate: dto.issueDate ? issueDate : undefined,
        expiryDate: dto.expiryDate ? expiryDate : undefined,
      },
      include: DOCUMENT_INCLUDE,
    });
    return this.decorate(updated, alertDays);
  }

  /**
   * Supersede rather than overwrite.
   *
   * The old row keeps its own dates and becomes RENEWED; the replacement is a
   * new row pointing back at it. Editing the dates in place would be simpler
   * and would destroy the only record of when the previous document actually
   * lapsed — which is the question an auditor asks, about a date that has
   * already passed and can no longer be reconstructed from anywhere else.
   */
  async renew(id: string, dto: RenewLegalDocumentDto) {
    const current = await this.prisma.employeeLegalDocument.findUnique({
      where: { id },
    });
    if (!current) throw new NotFoundException('Legal document not found');
    if (current.status === LegalDocumentStatus.RENEWED) {
      throw new BadRequestException('This document has already been renewed');
    }
    if (current.status === LegalDocumentStatus.CANCELLED) {
      throw new BadRequestException('A cancelled document cannot be renewed');
    }

    const issueDate = new Date(dto.issueDate);
    const expiryDate = new Date(dto.expiryDate);
    if (expiryDate <= issueDate) {
      throw new BadRequestException(
        'The expiry date must fall after the issue date',
      );
    }

    // Both writes or neither: the old row demoted with no replacement leaves
    // the employee with no current document, and a replacement created while
    // the old one is still current leaves two.
    const [, replacement] = await this.prisma.$transaction([
      this.prisma.employeeLegalDocument.update({
        where: { id },
        data: { status: LegalDocumentStatus.RENEWED, isCurrent: false },
      }),
      this.prisma.employeeLegalDocument.create({
        data: {
          employeeId: current.employeeId,
          category: current.category,
          status: LegalDocumentStatus.ACTIVE,
          documentNumber: dto.documentNumber ?? current.documentNumber,
          documentType: dto.documentType ?? current.documentType,
          country: dto.country ?? current.country,
          nationality: dto.nationality ?? current.nationality,
          issuingAuthority: dto.issuingAuthority ?? current.issuingAuthority,
          placeOfIssue: dto.placeOfIssue ?? current.placeOfIssue,
          sponsor: dto.sponsor ?? current.sponsor,
          remarks: dto.remarks ?? null,
          documentUrl: dto.documentUrl ?? null,
          issueDate,
          expiryDate,
          isCurrent: true,
          renewedFromId: current.id,
        },
        include: DOCUMENT_INCLUDE,
      }),
    ]);

    const alertDays = await this.alertDays();
    return this.decorate(replacement, alertDays);
  }

  async cancel(id: string) {
    const current = await this.prisma.employeeLegalDocument.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!current) throw new NotFoundException('Legal document not found');
    if (current.status === LegalDocumentStatus.CANCELLED) {
      throw new BadRequestException('This document is already cancelled');
    }

    const alertDays = await this.alertDays();
    const updated = await this.prisma.employeeLegalDocument.update({
      where: { id },
      data: { status: LegalDocumentStatus.CANCELLED, isCurrent: false },
      include: DOCUMENT_INCLUDE,
    });
    return this.decorate(updated, alertDays);
  }

  /**
   * Nightly sweep of documents that have lapsed since the last run.
   *
   * Idempotent by construction: the filter only matches rows still marked
   * ACTIVE with a date in the past, so a second run the same day updates
   * nothing and a missed run catches up on the next one.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async expireLapsedDocuments() {
    const today = startOfUtcDay(new Date());
    const { count } = await this.prisma.employeeLegalDocument.updateMany({
      where: {
        status: LegalDocumentStatus.ACTIVE,
        expiryDate: { lt: today },
      },
      data: { status: LegalDocumentStatus.EXPIRED },
    });
    if (count > 0) {
      this.logger.log(`Marked ${count} legal document(s) expired`);
    }
    return { expired: count };
  }

  /**
   * The alert window, in days.
   *
   * Configurable because the notice period a PRO needs to renew a visa differs
   * per jurisdiction. A database that has never had the settings screen opened
   * has no row for the key at all, and a row somebody has emptied parses to
   * nothing — either way the report falls back to thirty days rather than
   * rendering with a window of zero.
   */
  private async alertDays(): Promise<number> {
    const configured = await this.settings.getNumber(
      ALERT_DAYS_KEY,
      ALERT_DAYS_FALLBACK,
    );
    return configured > 0 ? Math.trunc(configured) : ALERT_DAYS_FALLBACK;
  }

  private decorate<T extends ExpiringRow>(row: T, alertDays: number) {
    const daysUntilExpiry = daysUntil(row.expiryDate);
    return {
      ...row,
      daysUntilExpiry,
      isExpiringSoon: daysUntilExpiry >= 0 && daysUntilExpiry <= alertDays,
    };
  }

  /**
   * The renewal chain containing `id`, oldest first, following `renewedFromId`
   * back to the original document and then forward through its replacements.
   */
  private buildChain<T extends { id: string; renewedFromId: string | null }>(
    id: string,
    rows: T[],
  ): T[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const successorOf = new Map<string, string>();
    for (const row of rows) {
      if (row.renewedFromId) successorOf.set(row.renewedFromId, row.id);
    }

    // The `seen` sets are cycle guards. A loop cannot be created through this
    // service, but a row written by hand or by an import can carry one, and
    // walking it unguarded hangs the request instead of returning a short chain.
    let rootId = id;
    const behind = new Set<string>([id]);
    for (;;) {
      const previous = byId.get(rootId)?.renewedFromId;
      if (!previous || behind.has(previous)) break;
      behind.add(previous);
      rootId = previous;
    }

    const chain: T[] = [];
    const ahead = new Set<string>();
    let cursor: string | undefined = rootId;
    while (cursor && !ahead.has(cursor)) {
      ahead.add(cursor);
      const row = byId.get(cursor);
      if (!row) break;
      chain.push(row);
      cursor = successorOf.get(cursor);
    }
    return chain;
  }

  private async assertNoCurrentDocument(
    employeeId: string,
    category: LegalDocumentCategory,
    exceptId?: string,
  ) {
    const existing = await this.prisma.employeeLegalDocument.findFirst({
      where: {
        employeeId,
        category,
        isCurrent: true,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true, documentNumber: true },
    });
    if (existing) {
      throw new ConflictException(
        `This employee already has a current ${category.toLowerCase().replace(/_/g, ' ')} (${existing.documentNumber}). Renew it instead.`,
      );
    }
  }

  private async assertEmployeeExists(id: string) {
    const found = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Employee not found');
  }
}
