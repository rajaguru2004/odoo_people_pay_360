import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { join } from 'path';
import { PayrollRunStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';

export type VaultKind =
  | 'PERSONAL'
  | 'LETTER'
  | 'LEGAL'
  | 'CONTRACT'
  | 'PAYSLIP'
  | 'CERTIFICATE';

export interface VaultItem {
  id: string;
  kind: VaultKind;
  title: string;
  category: string;
  issueDate: string | null;
  expiryDate: string | null;
  /** Days until it lapses; negative once it has. Null when it never expires. */
  daysUntilExpiry: number | null;
  /** A URL anyone may open, or null when the file needs the download route. */
  fileUrl: string | null;
  /** The authenticated route: /secure-files/{secureKind}/{secureId}. */
  secureKind: string | null;
  secureId: string | null;
  source: string;
}

/** The two roles entitled to read somebody else's vault. */
const HR_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.HR_MANAGER];

/** How far ahead the vault calls a document "expiring soon". */
const EXPIRY_HORIZON_DAYS = 90;

/** A payroll run that has not been approved is still being edited. */
const ISSUED_RUN_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.PAID,
];

/** Mirrors the letters store — see the note there on why it is not `uploads/`. */
const PRIVATE_STORE = join(process.cwd(), 'storage');

/**
 * One screen for everything an employee holds.
 *
 * Deliberately no new table. Personal uploads, generated letters, visa records,
 * contracts, payslips and training certificates already exist and are already
 * the source of truth for what they say; a vault table would be a sixth copy
 * that could only drift. This aggregates the read paths into one shape.
 */
@Injectable()
export class DocumentVaultService {
  constructor(private readonly prisma: PrismaService) {}

  private daysUntil(value: Date | null | undefined): number | null {
    if (!value) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.ceil((new Date(value).getTime() - today.getTime()) / 86_400_000);
  }

  /**
   * An employee reads their own vault; HR reads anyone's.
   *
   * A MANAGER is deliberately NOT given departmental access: a vault holds
   * salary certificates and passport scans, which a line manager has no
   * business reading about the people who report to them.
   */
  private assertMayRead(employeeId: string, user: Principal) {
    if (employeeId === user?.employeeId) return;
    if (HR_ROLES.includes(user?.role)) return;
    throw new ForbiddenException('You can only view your own documents');
  }

  async forEmployee(employeeId: string, user: Principal) {
    this.assertMayRead(employeeId, user);

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');

    const [documents, legalDocuments, contracts, payslips, certificates] =
      await Promise.all([
        this.prisma.employeeDocument.findMany({
          where: { employeeId },
          orderBy: { uploadedAt: 'desc' },
        }),
        this.prisma.employeeLegalDocument.findMany({
          where: { employeeId },
          orderBy: { expiryDate: 'desc' },
        }),
        this.prisma.contract.findMany({
          where: { employeeId },
          select: {
            id: true,
            contractNumber: true,
            contractType: true,
            startDate: true,
            endDate: true,
            status: true,
          },
          orderBy: { startDate: 'desc' },
        }),
        this.prisma.payslip.findMany({
          where: { employeeId },
          select: {
            id: true,
            payrollRun: {
              select: { periodStart: true, periodEnd: true, status: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 24,
        }),
        this.prisma.trainingNomination.findMany({
          where: {
            employeeId,
            status: 'ATTENDED',
            certificateUrl: { not: null },
          },
          include: {
            session: { select: { course: { select: { title: true } } } },
          },
        }),
      ]);

    const items: VaultItem[] = [];

    for (const doc of documents) {
      // The presence of a private reference is what makes a file private: it is
      // written by the letter issuer and by anything else that must not be
      // readable by link alone.
      const isPrivate = Boolean(doc.privateRef);
      items.push({
        id: doc.id,
        kind: doc.isSystemGenerated ? 'LETTER' : 'PERSONAL',
        title: doc.fileName,
        category: doc.documentType,
        issueDate: (doc.issueDate ?? doc.uploadedAt).toISOString(),
        expiryDate: doc.expiryDate?.toISOString() ?? null,
        daysUntilExpiry: this.daysUntil(doc.expiryDate),
        fileUrl: isPrivate ? null : doc.fileUrl,
        secureKind: isPrivate ? 'employee-document' : null,
        secureId: isPrivate ? doc.id : null,
        source: doc.isSystemGenerated ? 'Generated by HR' : 'Uploaded',
      });
    }

    for (const doc of legalDocuments) {
      items.push({
        id: doc.id,
        kind: 'LEGAL',
        title: `${doc.documentType ?? doc.category} — ${doc.documentNumber}`,
        category: doc.category,
        issueDate: doc.issueDate.toISOString(),
        expiryDate: doc.expiryDate.toISOString(),
        daysUntilExpiry: this.daysUntil(doc.expiryDate),
        fileUrl: doc.documentUrl,
        secureKind: null,
        secureId: null,
        source: `Visa / legal (${doc.status})`,
      });
    }

    for (const contract of contracts) {
      items.push({
        id: contract.id,
        kind: 'CONTRACT',
        title: `Contract ${contract.contractNumber}`,
        category: contract.contractType,
        issueDate: contract.startDate.toISOString(),
        expiryDate: contract.endDate?.toISOString() ?? null,
        daysUntilExpiry: this.daysUntil(contract.endDate),
        fileUrl: null,
        secureKind: null,
        secureId: null,
        source: `Employment contract (${contract.status})`,
      });
    }

    for (const payslip of payslips) {
      if (!ISSUED_RUN_STATUSES.includes(payslip.payrollRun.status)) continue;
      const period = payslip.payrollRun.periodStart.toISOString().slice(0, 7);
      items.push({
        id: payslip.id,
        kind: 'PAYSLIP',
        title: `Payslip ${period}`,
        category: 'Payslip',
        issueDate: payslip.payrollRun.periodStart.toISOString(),
        expiryDate: null,
        daysUntilExpiry: null,
        fileUrl: null,
        secureKind: null,
        secureId: null,
        source: 'Payroll',
      });
    }

    for (const certificate of certificates) {
      items.push({
        id: certificate.id,
        kind: 'CERTIFICATE',
        title: `Certificate — ${certificate.session.course.title}`,
        category: 'Training certificate',
        issueDate: certificate.attendedAt?.toISOString() ?? null,
        expiryDate: certificate.certificateExpiry?.toISOString() ?? null,
        daysUntilExpiry: this.daysUntil(certificate.certificateExpiry),
        fileUrl: certificate.certificateUrl,
        secureKind: null,
        secureId: null,
        source: 'Training',
      });
    }

    items.sort((a, b) => (b.issueDate ?? '').localeCompare(a.issueDate ?? ''));

    const expiringSoon = items.filter(
      (item) =>
        item.daysUntilExpiry !== null &&
        item.daysUntilExpiry >= 0 &&
        item.daysUntilExpiry <= EXPIRY_HORIZON_DAYS,
    ).length;
    const expired = items.filter(
      (item) => item.daysUntilExpiry !== null && item.daysUntilExpiry < 0,
    ).length;

    return {
      items,
      summary: {
        total: items.length,
        byKind: items.reduce<Record<string, number>>((acc, item) => {
          acc[item.kind] = (acc[item.kind] ?? 0) + 1;
          return acc;
        }, {}),
        expiringSoon,
        expired,
      },
    };
  }

  /** Resolve a private employee document for the authenticated download route. */
  async fileFor(documentId: string, user: Principal) {
    const doc = await this.prisma.employeeDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        employeeId: true,
        fileName: true,
        mimeType: true,
        privateRef: true,
      },
    });
    if (!doc?.privateRef) return null;
    this.assertMayRead(doc.employeeId, user);

    return {
      ref: doc.privateRef,
      absolutePath: join(PRIVATE_STORE, doc.privateRef),
      fileName: doc.fileName,
      mimeType: doc.mimeType ?? 'application/octet-stream',
    };
  }
}
