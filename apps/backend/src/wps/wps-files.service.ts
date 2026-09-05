import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { SecureFile } from '../storage/secure-download.registry';
import { WpsFormatRegistry } from './formats/wps-format.registry';
import { minorToFixed } from './wps-money.util';

/** Roles allowed to see or download a wage file. Salary data for a whole branch. */
const WPS_READ_ROLES = ['ADMIN', 'HR_MANAGER'];

@Injectable()
export class WpsFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly registry: WpsFormatRegistry,
  ) {}

  async list(filters: { payrollId?: string; branchId?: string; status?: string }) {
    // Auto branch-scoped: WpsFile is registered 'direct' in BRANCH_SCOPE.
    const files = await this.prisma.wpsFile.findMany({
      where: {
        ...(filters.payrollId ? { payrollId: filters.payrollId } : {}),
        ...(filters.branchId ? { branchId: filters.branchId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      orderBy: [{ generatedAt: 'desc' }],
      include: {
        branch: { select: { code: true, name: true } },
        payroll: { select: { month: true, year: true, version: true } },
      },
    });
    return { success: true, data: files.map((f) => this.summary(f)) };
  }

  async get(id: string) {
    const file = await this.prisma.wpsFile.findUnique({
      where: { id },
      include: {
        branch: { select: { code: true, name: true } },
        payroll: { select: { month: true, year: true, version: true } },
        rows: { orderBy: { sequence: 'asc' } },
        previousVersion: { select: { id: true, version: true, status: true } },
        nextVersions: { select: { id: true, version: true, status: true } },
      },
    });
    if (!file) throw new NotFoundException('WPS file not found');
    assertInBranch(file.branchId); // findUnique bypasses auto-scoping

    return {
      success: true,
      data: {
        ...this.summary(file),
        employerSnapshot: file.employerSnapshot,
        preflightSnapshot: file.preflightSnapshot,
        runOptions: file.runOptions,
        generationError: file.generationError,
        previousVersion: file.previousVersion,
        nextVersions: file.nextVersions,
        // accountMasked is already last-4 only; identifierSnapshot is masked here.
        rows: file.rows.map((r) => ({
          id: r.id,
          sequence: r.sequence,
          employeeId: r.employeeId,
          employeeCode: r.employeeCodeSnapshot,
          employeeName: r.employeeNameSnapshot,
          bankCode: r.bankCodeSnapshot,
          account: r.accountMasked,
          identifiers: maskIdentifiers(r.identifierSnapshot),
          basic: fmt(r.basicMinor, file.currencyExponent),
          allowances: fmt(r.allowancesMinor, file.currencyExponent),
          deductions: fmt(r.deductionsMinor, file.currencyExponent),
          net: fmt(r.netMinor, file.currencyExponent),
          currency: r.currency,
          status: r.status,
          rejectionCode: r.rejectionCode,
          rejectionReason: r.rejectionReason,
        })),
      },
    };
  }

  /**
   * Resolve + authorize for the generic secure-download route.
   *
   * The route's own @Roles list includes MANAGER and EMPLOYEE — it deliberately
   * delegates authorization to the resolver, so this MUST re-check the role. A
   * resolver that forgets hands every employee the whole branch's payroll.
   *
   * Throws NotFound rather than Forbidden so existence is not leaked, matching
   * assertInBranch.
   */
  async fileFor(id: string, user: any): Promise<SecureFile> {
    if (!WPS_READ_ROLES.includes(user?.role)) {
      throw new NotFoundException('WPS file not found');
    }

    const file = await this.prisma.wpsFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('WPS file not found');
    assertInBranch(file.branchId);

    if (!file.privateRef || !StorageService.isPrivateRef(file.privateRef)) {
      throw new NotFoundException(
        file.status === 'GENERATED' || file.status === 'SUBMITTED'
          ? 'This wage file has no stored artifact.'
          : `This wage file is ${file.status} and has nothing to download.`,
      );
    }

    await this.prisma.wpsFile.update({
      where: { id },
      data: { downloadCount: { increment: 1 } },
    });

    return {
      ref: file.privateRef,
      fileName: file.fileName ?? `wps-${file.id}.txt`,
      ownerEmployeeId: null,
    };
  }

  /** Recompute the stored fingerprint from the bytes actually in storage. */
  async verify(id: string) {
    const file = await this.prisma.wpsFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('WPS file not found');
    assertInBranch(file.branchId);
    if (!file.privateRef) throw new BadRequestException('No stored artifact to verify');

    const stored = await this.storage.readPrivateFile(file.privateRef);
    if (!stored?.buffer) throw new NotFoundException('Stored artifact is missing');

    const computed = createHash('sha256').update(stored.buffer).digest('hex');
    return {
      success: true,
      data: {
        matches: computed === file.sha256,
        storedSha256: file.sha256,
        computedSha256: computed,
        byteSize: stored.buffer.length,
      },
    };
  }

  /** GENERATED → SUBMITTED. Records that the operator sent it to the bank. */
  async markSubmitted(
    id: string,
    dto: { submittedAt?: string; reference?: string },
    user: any,
  ) {
    const file = await this.requireFile(id);
    if (file.status !== 'GENERATED') {
      throw new BadRequestException(
        `Only a GENERATED file can be marked submitted (this one is ${file.status}).`,
      );
    }

    // Compare-and-set so two operators cannot both claim the transition.
    const { count } = await this.prisma.wpsFile.updateMany({
      where: { id, status: 'GENERATED' },
      data: {
        status: 'SUBMITTED',
        submittedAt: dto.submittedAt ? new Date(dto.submittedAt) : new Date(),
        submittedBy: user.id,
        submissionReference: dto.reference ?? null,
      },
    });
    if (count === 0) {
      throw new BadRequestException('The file changed state — reload and try again.');
    }

    await this.audit.log({
      userId: user.id,
      action: 'WPS_FILE_SUBMITTED',
      resourceType: 'WpsFile',
      resourceId: id,
      branchId: file.branchId,
      newData: { reference: dto.reference ?? null },
    });
    return this.get(id);
  }

  /**
   * SUBMITTED → ACKNOWLEDGED | PARTIALLY_REJECTED | REJECTED.
   *
   * On a partial rejection the named rows go REJECTED and the rest ACCEPTED, which
   * is what makes a corrected v2 diffable against v1 and lets the bank-edit freeze
   * release exactly the employees who need to fix their details.
   */
  async recordBankResponse(
    id: string,
    dto: {
      outcome: 'ACKNOWLEDGED' | 'PARTIALLY_REJECTED' | 'REJECTED';
      reference?: string;
      notes?: string;
      rejectedRows?: { employeeId: string; code?: string; reason?: string }[];
    },
    user: any,
  ) {
    const file = await this.requireFile(id);
    if (file.status !== 'SUBMITTED') {
      throw new BadRequestException(
        `A bank response can only be recorded against a SUBMITTED file (this one is ${file.status}).`,
      );
    }

    const rejected = dto.rejectedRows ?? [];
    if (dto.outcome === 'PARTIALLY_REJECTED' && rejected.length === 0) {
      throw new BadRequestException(
        'A partial rejection needs at least one rejected employee.',
      );
    }
    if (dto.outcome === 'ACKNOWLEDGED' && rejected.length > 0) {
      throw new BadRequestException(
        'An accepted file cannot also list rejected employees.',
      );
    }

    const rows = await this.prisma.wpsFileRow.findMany({
      where: { wpsFileId: id },
      select: { id: true, employeeId: true },
    });
    const byEmployee = new Map(rows.map((r) => [r.employeeId, r.id]));
    const unknown = rejected.filter((r) => !byEmployee.has(r.employeeId));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `These employees are not in this file: ${unknown.map((u) => u.employeeId).join(', ')}`,
      );
    }

    const rejectedIds = new Set(rejected.map((r) => byEmployee.get(r.employeeId)!));
    const ops: any[] = [
      this.prisma.wpsFile.update({
        where: { id },
        data: {
          status: dto.outcome,
          bankResponseAt: new Date(),
          bankResponseRef: dto.reference ?? null,
          bankResponseNotes: dto.notes ?? null,
          rejectedCount: dto.outcome === 'REJECTED' ? rows.length : rejected.length,
          recordedBy: user.id,
        },
      }),
    ];

    if (dto.outcome === 'REJECTED') {
      ops.push(
        this.prisma.wpsFileRow.updateMany({
          where: { wpsFileId: id },
          data: { status: 'REJECTED' },
        }),
      );
    } else {
      ops.push(
        this.prisma.wpsFileRow.updateMany({
          where: { wpsFileId: id, id: { notIn: [...rejectedIds] } },
          data: { status: 'ACCEPTED' },
        }),
      );
      for (const r of rejected) {
        ops.push(
          this.prisma.wpsFileRow.update({
            where: { id: byEmployee.get(r.employeeId)! },
            data: {
              status: 'REJECTED',
              rejectionCode: r.code ?? null,
              rejectionReason: r.reason ?? null,
            },
          }),
        );
      }
    }

    await this.prisma.$transaction(ops);

    await this.audit.log({
      userId: user.id,
      action: 'WPS_BANK_RESPONSE_RECORDED',
      resourceType: 'WpsFile',
      resourceId: id,
      branchId: file.branchId,
      newData: { outcome: dto.outcome, rejectedCount: rejected.length },
    });
    return this.get(id);
  }

  /** GENERATED → CANCELLED, for a file that was never sent. */
  async cancel(id: string, reason: string | undefined, user: any) {
    const file = await this.requireFile(id);
    if (file.status !== 'GENERATED') {
      throw new BadRequestException(
        `Only a GENERATED file can be cancelled (this one is ${file.status}).`,
      );
    }
    const { count } = await this.prisma.wpsFile.updateMany({
      where: { id, status: 'GENERATED' },
      data: {
        status: 'CANCELLED',
        bankResponseNotes: reason ?? null,
        recordedBy: user.id,
      },
    });
    if (count === 0) {
      throw new BadRequestException('The file changed state — reload and try again.');
    }
    await this.audit.log({
      userId: user.id,
      action: 'WPS_FILE_CANCELLED',
      resourceType: 'WpsFile',
      resourceId: id,
      branchId: file.branchId,
      newData: { reason: reason ?? null },
    });
    return this.get(id);
  }

  private async requireFile(id: string) {
    const file = await this.prisma.wpsFile.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('WPS file not found');
    assertInBranch(file.branchId);
    return file;
  }

  private summary(file: any) {
    let formatName = file.format;
    try {
      formatName = this.registry.get(file.format).displayName;
    } catch {
      // A file generated by a format this build no longer registers still has to
      // be listable — show the raw key rather than 500.
    }
    return {
      id: file.id,
      branchId: file.branchId,
      branchCode: file.branch?.code,
      payrollId: file.payrollId,
      period: file.payroll
        ? { month: file.payroll.month, year: file.payroll.year }
        : { month: file.periodMonth, year: file.periodYear },
      format: file.format,
      formatName,
      specVersion: file.specVersion,
      status: file.status,
      version: file.version,
      previousVersionId: file.previousVersionId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      byteSize: file.byteSize,
      sha256: file.sha256,
      employeeCount: file.employeeCount,
      total: fmt(file.totalMinor, file.currencyExponent),
      currency: file.currency,
      paymentDate: file.paymentDate,
      generatedAt: file.generatedAt,
      generatedBy: file.generatedBy,
      submittedAt: file.submittedAt,
      submissionReference: file.submissionReference,
      bankResponseAt: file.bankResponseAt,
      bankResponseRef: file.bankResponseRef,
      bankResponseNotes: file.bankResponseNotes,
      rejectedCount: file.rejectedCount,
      downloadCount: file.downloadCount,
      /** Only a stored artifact is downloadable. */
      downloadable: Boolean(file.privateRef),
    };
  }

  /**
   * The state of wage-file submission, for the payroll hub.
   *
   * `lastFileAt` is the question behind the question: a bank that has not seen
   * a file this month is the failure this summary exists to make visible, and
   * a count by status alone never surfaces it.
   */
  async statusSummary() {
    const [byStatus, latest, totals] = await Promise.all([
      this.prisma.wpsFile.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.wpsFile.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, status: true, fileName: true },
      }),
      this.prisma.wpsFile.aggregate({
        // `ACCEPTED` is a WpsFileRow status, not a WpsFile one — the file-level
        // enum says ACKNOWLEDGED. Matching on it silently excluded every file
        // the bank had actually acknowledged, so the figure only ever counted
        // files still awaiting a response and under-reported what was sent.
        // PARTIALLY_REJECTED counts too: the bank took the file, and the rows
        // it refused are reported separately by `rejected`.
        where: {
          status: { in: ['SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_REJECTED'] },
        },
        _sum: { totalMinor: true },
      }),
    ]);

    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));

    return {
      success: true,
      data: {
        byStatus: counts,
        rejected: counts['REJECTED'] ?? 0,
        lastFileAt: latest?.createdAt ?? null,
        lastFileStatus: latest?.status ?? null,
        lastFileName: latest?.fileName ?? null,
        // Minor units, as everywhere else in WPS — the caller formats it.
        submittedTotalMinor: String(totals._sum.totalMinor ?? 0),
      },
    };
  }

}

/** Minor units are a Decimal in the DB and must not become a JS float. */
function fmt(minor: any, exponent: number) {
  const raw = BigInt(String(minor ?? '0'));
  return {
    minor: raw.toString(),
    formatted: minorToFixed({ minor: raw, currency: '', exponent }),
  };
}

/** Government identifiers keep only their last 4 in any read projection. */
function maskIdentifiers(snapshot: any): Record<string, string> {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot as Record<string, unknown>)) {
    const s = String(v ?? '');
    out[k] = s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
  }
  return out;
}
