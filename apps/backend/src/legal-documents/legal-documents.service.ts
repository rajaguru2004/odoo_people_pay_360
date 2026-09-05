import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import {
  CompanyCronGate,
  COMPANY_CRON_TICK,
} from '../common/timezone/company-cron.gate';
import { CreateLegalDocumentDto } from './dto/create-legal-document.dto';
import {
  UpdateLegalDocumentDto,
  RenewLegalDocumentDto,
  CancelLegalDocumentDto,
} from './dto/update-legal-document.dto';
import {
  LegalDocumentStatus,
  LEGAL_DOC_ALERT_RECIPIENT_ROLES,
  VISA_EXPIRY_ALERT_DAYS_KEY,
  VISA_EXPIRY_ALERT_DAYS_DEFAULT,
} from './legal-document.constants';

const DAY_MS = 1000 * 60 * 60 * 24;

@Injectable()
export class LegalDocumentsService {
  /** Auto-expire fires at 00:30 in the COMPANY timezone, not the server's. */
  private readonly expireGate: CompanyCronGate;

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private notificationsService: NotificationsService,
    private settingsService: SystemSettingsService,
    private tzSvc: TimezoneService,
  ) {
    this.expireGate = new CompanyCronGate(this.tzSvc, '00:30');
  }

  private employeeInclude = {
    employee: {
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        avatarUrl: true,
        branchId: true,
        department: { select: { id: true, name: true } },
      },
    },
  };

  private attachmentInclude = {
    attachments: {
      orderBy: { uploadedAt: 'desc' as const },
      include: {
        uploadedBy: {
          select: {
            id: true,
            email: true,
            employee: { select: { fullName: true } },
          },
        },
      },
    },
  };

  /** Days until expiry (negative = already expired), against today midnight. */
  private daysUntil(expiryDate: Date): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.ceil((new Date(expiryDate).getTime() - today.getTime()) / DAY_MS);
  }

  /** Attach derived fields: daysUntilExpiry + isExpiringSoon (within alert window). */
  private async decorate<T extends { expiryDate: Date; status: string }>(
    docs: T[],
  ): Promise<(T & { daysUntilExpiry: number; isExpiringSoon: boolean })[]> {
    const alertDays = await this.getAlertDays();
    return docs.map((doc) => {
      const daysUntilExpiry = this.daysUntil(doc.expiryDate);
      return {
        ...this.serialize(doc),
        daysUntilExpiry,
        isExpiringSoon:
          doc.status === LegalDocumentStatus.ACTIVE &&
          daysUntilExpiry >= 0 &&
          daysUntilExpiry <= alertDays,
      };
    });
  }

  /** BigInt attachment sizes -> number for JSON. */
  private serialize(doc: any): any {
    if (!doc) return doc;
    if (Array.isArray(doc.attachments)) {
      return {
        ...doc,
        attachments: doc.attachments.map((a: any) => ({
          ...a,
          fileSize: a.fileSize != null ? Number(a.fileSize) : null,
        })),
      };
    }
    return doc;
  }

  async getAlertDays(): Promise<number> {
    const raw = await this.settingsService.getSetting(
      VISA_EXPIRY_ALERT_DAYS_KEY,
      VISA_EXPIRY_ALERT_DAYS_DEFAULT,
    );
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  }

  async findAll(query: {
    employeeId?: string;
    category?: string;
    status?: string;
    country?: string;
    documentType?: string;
    expiringInDays?: string;
    isCurrent?: string;
    search?: string;
    page?: string;
    limit?: string;
  }) {
    const page = Math.max(parseInt(query.page || '1', 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(query.limit || '20', 10) || 20, 1), 100);

    const where: any = { category: query.category || 'VISA' };
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.status) where.status = query.status;
    if (query.country) where.country = { contains: query.country, mode: 'insensitive' };
    if (query.documentType) where.documentType = query.documentType;
    if (query.isCurrent !== undefined) where.isCurrent = query.isCurrent === 'true';
    if (query.expiringInDays) {
      const days = parseInt(query.expiringInDays, 10);
      if (Number.isFinite(days) && days > 0) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const horizon = new Date(today);
        horizon.setDate(horizon.getDate() + days);
        where.status = LegalDocumentStatus.ACTIVE;
        where.expiryDate = { gte: today, lte: horizon };
      }
    }
    if (query.search) {
      where.OR = [
        { documentNumber: { contains: query.search, mode: 'insensitive' } },
        { country: { contains: query.search, mode: 'insensitive' } },
        { employee: { fullName: { contains: query.search, mode: 'insensitive' } } },
        { employee: { employeeCode: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.employeeLegalDocument.findMany({
        where,
        include: this.employeeInclude,
        orderBy: { expiryDate: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.employeeLegalDocument.count({ where }),
    ]);

    return {
      success: true,
      data: await this.decorate(items),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getExpiring(days = 30, category = 'VISA') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + days);

    const docs = await this.prisma.employeeLegalDocument.findMany({
      where: {
        category: category as any,
        status: LegalDocumentStatus.ACTIVE,
        isCurrent: true,
        expiryDate: { gte: today, lte: horizon },
      },
      include: this.employeeInclude,
      orderBy: { expiryDate: 'asc' },
    });

    return {
      success: true,
      data: await this.decorate(docs),
      meta: { total: docs.length, days },
    };
  }

  async getSummary(category = 'VISA') {
    const alertDays = await this.getAlertDays();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + alertDays);
    const yearStart = new Date(today.getFullYear(), 0, 1);

    const cat = category as any;
    const [active, expiringSoon, expired, cancelled, renewedThisYear] =
      await Promise.all([
        this.prisma.employeeLegalDocument.count({
          where: { category: cat, status: LegalDocumentStatus.ACTIVE, isCurrent: true },
        }),
        this.prisma.employeeLegalDocument.count({
          where: {
            category: cat,
            status: LegalDocumentStatus.ACTIVE,
            isCurrent: true,
            expiryDate: { gte: today, lte: horizon },
          },
        }),
        this.prisma.employeeLegalDocument.count({
          where: { category: cat, status: LegalDocumentStatus.EXPIRED, isCurrent: true },
        }),
        this.prisma.employeeLegalDocument.count({
          where: { category: cat, status: LegalDocumentStatus.CANCELLED },
        }),
        this.prisma.employeeLegalDocument.count({
          where: {
            category: cat,
            status: LegalDocumentStatus.RENEWED,
            updatedAt: { gte: yearStart },
          },
        }),
      ]);

    return {
      success: true,
      data: { active, expiringSoon, expired, cancelled, renewedThisYear, alertDays },
    };
  }

  async findByEmployee(employeeId: string, category = 'VISA') {
    const docs = await this.prisma.employeeLegalDocument.findMany({
      where: { employeeId, category: category as any },
      include: { ...this.employeeInclude, ...this.attachmentInclude },
      orderBy: [{ isCurrent: 'desc' }, { expiryDate: 'desc' }],
    });
    return { success: true, data: await this.decorate(docs) };
  }

  async findOne(id: string) {
    const doc = await this.prisma.employeeLegalDocument.findUnique({
      where: { id },
      include: {
        ...this.employeeInclude,
        ...this.attachmentInclude,
        renewedFrom: true,
        renewals: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!doc) throw new NotFoundException('Legal document not found');
    const [decorated] = await this.decorate([doc]);
    return { success: true, data: decorated };
  }

  async create(dto: CreateLegalDocumentDto, userId?: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { id: true, branchId: true, status: true, fullName: true },
    });
    if (!employee) throw new BadRequestException('Employee not found');
    assertInBranch(employee.branchId);

    const issueDate = new Date(dto.issueDate);
    const expiryDate = new Date(dto.expiryDate);
    if (issueDate >= expiryDate) {
      throw new BadRequestException('Issue date must be before expiry date');
    }

    const category = (dto.category || 'VISA') as any;

    const duplicateNumber = await this.prisma.employeeLegalDocument.findFirst({
      where: { category, documentNumber: dto.documentNumber },
    });
    if (duplicateNumber) {
      throw new ConflictException(
        `A ${category} record with number "${dto.documentNumber}" already exists`,
      );
    }

    const existingCurrent = await this.prisma.employeeLegalDocument.findFirst({
      where: { employeeId: dto.employeeId, category, country: dto.country, isCurrent: true },
    });
    if (existingCurrent) {
      throw new ConflictException(
        `Employee already has a current ${category} for ${dto.country}. Renew or cancel it first.`,
      );
    }

    // Back-dated records already past expiry start life as EXPIRED.
    const status =
      this.daysUntil(expiryDate) < 0
        ? LegalDocumentStatus.EXPIRED
        : LegalDocumentStatus.ACTIVE;

    const doc = await this.prisma.employeeLegalDocument.create({
      data: {
        employeeId: dto.employeeId,
        category,
        documentNumber: dto.documentNumber,
        documentType: dto.documentType,
        country: dto.country,
        nationality: dto.nationality,
        issueDate,
        expiryDate,
        issuingAuthority: dto.issuingAuthority,
        placeOfIssue: dto.placeOfIssue,
        sponsor: dto.sponsor,
        remarks: dto.remarks,
        status,
        isCurrent: true,
        createdById: userId ?? null,
      },
      include: this.employeeInclude,
    });

    const [decorated] = await this.decorate([doc]);
    return { success: true, message: 'Legal document created', data: decorated };
  }

  async update(id: string, dto: UpdateLegalDocumentDto) {
    const doc = await this.getForWrite(id);

    if (doc.status === LegalDocumentStatus.RENEWED) {
      throw new BadRequestException(
        'Renewed records are historical and cannot be edited',
      );
    }

    const issueDate = dto.issueDate ? new Date(dto.issueDate) : doc.issueDate;
    const expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : doc.expiryDate;
    if (issueDate >= expiryDate) {
      throw new BadRequestException('Issue date must be before expiry date');
    }

    if (dto.documentNumber && dto.documentNumber !== doc.documentNumber) {
      const duplicate = await this.prisma.employeeLegalDocument.findFirst({
        where: {
          category: doc.category,
          documentNumber: dto.documentNumber,
          id: { not: id },
        },
      });
      if (duplicate) {
        throw new ConflictException(
          `A ${doc.category} record with number "${dto.documentNumber}" already exists`,
        );
      }
    }

    // Corrected dates may resurrect an expired record (or expire an active one).
    let status = doc.status;
    if (
      doc.status === LegalDocumentStatus.ACTIVE ||
      doc.status === LegalDocumentStatus.EXPIRED
    ) {
      status =
        this.daysUntil(expiryDate) < 0
          ? LegalDocumentStatus.EXPIRED
          : LegalDocumentStatus.ACTIVE;
    }

    const updated = await this.prisma.employeeLegalDocument.update({
      where: { id },
      data: {
        documentNumber: dto.documentNumber,
        documentType: dto.documentType,
        country: dto.country,
        nationality: dto.nationality,
        issueDate: dto.issueDate ? issueDate : undefined,
        expiryDate: dto.expiryDate ? expiryDate : undefined,
        issuingAuthority: dto.issuingAuthority,
        placeOfIssue: dto.placeOfIssue,
        sponsor: dto.sponsor,
        remarks: dto.remarks,
        status,
        // Expiry moved -> allow the alert cron to re-evaluate.
        expiryAlertSentAt: dto.expiryDate ? null : undefined,
      },
      include: this.employeeInclude,
    });

    const [decorated] = await this.decorate([updated]);
    return { success: true, message: 'Legal document updated', data: decorated };
  }

  /**
   * Renewal: transactionally create a new record chained via renewedFromId and
   * retire the old one (status=RENEWED, isCurrent=false). History preserved.
   */
  async renew(id: string, dto: RenewLegalDocumentDto, userId?: string) {
    const doc = await this.getForWrite(id);

    if (!doc.isCurrent) {
      throw new BadRequestException('Only the current record can be renewed');
    }
    if (doc.status === LegalDocumentStatus.CANCELLED) {
      throw new BadRequestException('Cancelled records cannot be renewed — create a new record');
    }

    const issueDate = new Date(dto.issueDate);
    const expiryDate = new Date(dto.expiryDate);
    if (issueDate >= expiryDate) {
      throw new BadRequestException('Issue date must be before expiry date');
    }
    if (expiryDate <= doc.expiryDate) {
      throw new BadRequestException(
        'New expiry date must be after the previous expiry date',
      );
    }

    const duplicate = await this.prisma.employeeLegalDocument.findFirst({
      where: { category: doc.category, documentNumber: dto.documentNumber },
    });
    if (duplicate) {
      throw new ConflictException(
        `A ${doc.category} record with number "${dto.documentNumber}" already exists`,
      );
    }

    const [, renewed] = await this.prisma.$transaction([
      this.prisma.employeeLegalDocument.update({
        where: { id },
        data: { status: LegalDocumentStatus.RENEWED, isCurrent: false },
      }),
      this.prisma.employeeLegalDocument.create({
        data: {
          employeeId: doc.employeeId,
          category: doc.category,
          documentNumber: dto.documentNumber,
          documentType: dto.documentType || doc.documentType,
          country: doc.country,
          nationality: doc.nationality,
          issueDate,
          expiryDate,
          issuingAuthority: dto.issuingAuthority ?? doc.issuingAuthority,
          placeOfIssue: dto.placeOfIssue ?? doc.placeOfIssue,
          sponsor: dto.sponsor ?? doc.sponsor,
          remarks: dto.remarks,
          status: LegalDocumentStatus.ACTIVE,
          isCurrent: true,
          renewedFromId: id,
          createdById: userId ?? null,
        },
        include: this.employeeInclude,
      }),
    ]);

    // Notify the employee their document was renewed (best-effort).
    this.notifyRenewal(renewed).catch(() => undefined);

    const [decorated] = await this.decorate([renewed]);
    return { success: true, message: 'Legal document renewed', data: decorated };
  }

  async cancel(id: string, dto: CancelLegalDocumentDto) {
    const doc = await this.getForWrite(id);
    if (doc.status === LegalDocumentStatus.CANCELLED) {
      throw new BadRequestException('Record is already cancelled');
    }
    if (doc.status === LegalDocumentStatus.RENEWED) {
      throw new BadRequestException('Renewed records are historical and cannot be cancelled');
    }

    const updated = await this.prisma.employeeLegalDocument.update({
      where: { id },
      data: {
        status: LegalDocumentStatus.CANCELLED,
        isCurrent: false,
        remarks: dto.reason
          ? `${doc.remarks ? doc.remarks + ' | ' : ''}Cancelled: ${dto.reason}`
          : doc.remarks,
      },
      include: this.employeeInclude,
    });

    const [decorated] = await this.decorate([updated]);
    return { success: true, message: 'Legal document cancelled', data: decorated };
  }

  async remove(id: string) {
    await this.getForWrite(id);
    await this.prisma.employeeLegalDocument.delete({ where: { id } });
    return { success: true, message: 'Legal document deleted' };
  }

  /** Load + branch-guard a record for mutation. */
  private async getForWrite(id: string) {
    const doc = await this.prisma.employeeLegalDocument.findUnique({
      where: { id },
      include: { employee: { select: { id: true, branchId: true, fullName: true } } },
    });
    if (!doc) throw new NotFoundException('Legal document not found');
    assertInBranch(doc.employee.branchId);
    return doc;
  }

  private async notifyRenewal(doc: any) {
    const account = await this.prisma.user.findFirst({
      where: { employeeId: doc.employeeId, isActive: true },
      select: { id: true },
    });
    if (!account) return;
    await this.notificationsService.create({
      userId: account.id,
      title: 'Visa Renewed',
      message: `Your ${doc.documentType} for ${doc.country} has been renewed. New expiry: ${new Date(doc.expiryDate).toLocaleDateString('en-US')}.`,
      type: NotificationType.VISA_RENEWED,
      link: `/dashboard/employees/${doc.employeeId}?section=visa`,
    });
  }

  // ── Lifecycle automation ────────────────────────────────────────────────

  // Daily 00:30 COMPANY-LOCAL — flip past-expiry ACTIVE records to EXPIRED.
  @Cron(COMPANY_CRON_TICK, { name: 'auto-expire-legal-documents' })
  async autoExpireLegalDocumentsTick() {
    if (!(await this.expireGate.due())) return;
    return this.autoExpireLegalDocuments();
  }

  async autoExpireLegalDocuments() {
    // `expiryDate` is a @db.Date — compare against the company's calendar day.
    const today = await this.tzSvc.nowDateKeyCompany();
    return runWithBranchBypass(async () => {
      const expired = await this.prisma.employeeLegalDocument.updateMany({
        where: { status: LegalDocumentStatus.ACTIVE, expiryDate: { lt: today } },
        data: { status: LegalDocumentStatus.EXPIRED },
      });

      if (expired.count > 0) {
        console.log(`[Cron] Auto-expired ${expired.count} legal documents`);
      }
      return { success: true, count: expired.count };
    });
  }

  /**
   * Superseded by `RemindersModule` (see `sources/legal-document-reminder.source.ts`),
   * which alerts at configurable tiers instead of once per record. Kept as a
   * plain method — no longer scheduled — because the visa e2e suite drives it
   * directly and its single-shot `expiryAlertSentAt` semantics are what the
   * reminder backfill was derived from.
   *
   * @deprecated Use `RemindersService.runAll()`.
   */
  async sendExpiryAlerts() {
    return runWithBranchBypass(async () => {
      const alertDays = await this.getAlertDays();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const horizon = new Date(today);
      horizon.setDate(horizon.getDate() + alertDays);

      const expiring = await this.prisma.employeeLegalDocument.findMany({
        where: {
          status: LegalDocumentStatus.ACTIVE,
          isCurrent: true,
          expiryAlertSentAt: null,
          expiryDate: { gte: today, lte: horizon },
        },
        include: {
          employee: {
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
              department: { select: { name: true } },
              user: { select: { id: true, email: true, isActive: true } },
            },
          },
        },
      });

      if (expiring.length === 0) {
        return { success: true, message: 'No legal documents due for expiry alert', count: 0 };
      }

      const recipients = await this.prisma.user.findMany({
        where: { role: { in: LEGAL_DOC_ALERT_RECIPIENT_ROLES }, isActive: true },
        select: { id: true, email: true, employee: { select: { fullName: true } } },
      });

      let alerted = 0;
      for (const doc of expiring) {
        const daysRemaining = this.daysUntil(doc.expiryDate);
        const expiryDateStr = new Date(doc.expiryDate).toLocaleDateString('en-US');
        const profileLink = `/dashboard/employees/${doc.employeeId}?section=visa`;

        // HR / admin recipients
        for (const recipient of recipients) {
          try {
            await this.mailService.sendVisaExpiringAdminAlert(recipient.email, {
              recipientName: recipient.employee?.fullName || 'there',
              employeeName: doc.employee.fullName,
              employeeCode: doc.employee.employeeCode,
              department: doc.employee.department?.name,
              visaNumber: doc.documentNumber,
              visaType: doc.documentType,
              country: doc.country,
              expiryDate: expiryDateStr,
              daysRemaining,
            });
            await this.notificationsService.create({
              userId: recipient.id,
              title: 'Visa Expiring Soon',
              message: `${doc.employee.fullName}'s ${doc.documentType} (${doc.country}) expires in ${daysRemaining} day(s) on ${expiryDateStr}.`,
              type: NotificationType.VISA_EXPIRING,
              link: profileLink,
            });
          } catch (err) {
            console.error(
              `[Cron] Failed visa expiry alert to ${recipient.email}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        // The employee themselves (if they have an active account)
        const empUser = doc.employee.user;
        if (empUser?.isActive) {
          try {
            await this.mailService.sendVisaExpiringAlert(empUser.email, {
              employeeName: doc.employee.fullName,
              visaNumber: doc.documentNumber,
              visaType: doc.documentType,
              country: doc.country,
              expiryDate: expiryDateStr,
              daysRemaining,
            });
            await this.notificationsService.create({
              userId: empUser.id,
              title: 'Your Visa Is Expiring Soon',
              message: `Your ${doc.documentType} (${doc.country}) expires in ${daysRemaining} day(s) on ${expiryDateStr}. Please contact HR to start the renewal.`,
              type: NotificationType.VISA_EXPIRING,
              link: profileLink,
              // Explicit rather than type-based: VISA_EXPIRING is also raised
              // for the HR recipients above, and only the employee's own copy
              // belongs on their handset.
              waTemplate: 'expiry_reminder',
              waData: {
                entityLabel: doc.documentType,
                subjectName: doc.employee.fullName,
                expiryDate: doc.expiryDate,
                daysRemaining,
                fields: [
                  { label: 'Country', value: doc.country },
                  { label: 'Number', value: doc.documentNumber },
                ],
              },
              // The cron re-runs; one message per document per expiry window.
              waDedupeKey: `legal-doc-expiry:${doc.id}:${expiryDateStr}`,
            });
          } catch (err) {
            console.error(
              `[Cron] Failed visa expiry alert to employee ${empUser.email}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        await this.prisma.employeeLegalDocument.update({
          where: { id: doc.id },
          data: { expiryAlertSentAt: new Date() },
        });
        alerted++;
      }

      console.log(`[Cron] Sent visa expiry alerts for ${alerted} document(s)`);
      return { success: true, count: alerted };
    });
  }
}
