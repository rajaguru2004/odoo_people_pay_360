import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import { assertBranchAssignable } from '../common/branch/branch-scope.util';
import {
  carryForwardFor,
  encashableDays,
  quoteEncashment,
  resolvePolicy,
  type LeaveTypePolicyLike,
} from './encashment-calculator';

const toPolicyLike = (p: {
  leaveTypeKey: string;
  branchId: string | null;
  encashable: boolean;
  maxEncashDaysPerYear: number | null;
  encashBasis: string;
  monthDays: unknown;
  accruedOnly: boolean;
  allowInService: boolean;
  allowOnExit: boolean;
  carryForwardEnabled: boolean;
  carryForwardMaxDays: number | null;
  carryForwardExpiryMonths: number | null;
  isActive: boolean;
}): LeaveTypePolicyLike => ({ ...p, monthDays: Number(p.monthDays) });

@Injectable()
export class LeaveEncashmentService {
  private readonly logger = new Logger(LeaveEncashmentService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private features: PayrollFeaturesService,
  ) {}

  private async assertEnabled() {
    const f = await this.features.resolve();
    if (!f.leaveEncashmentEnabled) {
      throw new NotFoundException('Leave encashment is not enabled');
    }
    return f;
  }

  // ── Policy ───────────────────────────────────────────────────────────────

  async listPolicies() {
    const data = await this.prisma.leaveTypePolicy.findMany({
      orderBy: [{ leaveTypeKey: 'asc' }, { branchId: 'asc' }],
    });
    return { success: true, data };
  }

  /**
   * Write the policy for one leave type, globally or for one branch.
   *
   * Upsert on the partial unique indexes rather than create-or-update in code:
   * two concurrent saves of the same policy would otherwise race, and the loser
   * would get a constraint error that says nothing useful.
   */
  async setPolicy(dto: Record<string, unknown>, userId?: string) {
    const leaveTypeKey = String(dto.leaveTypeKey ?? '').trim();
    if (!leaveTypeKey) throw new BadRequestException('leaveTypeKey is required');
    const branchId = (dto.branchId as string | undefined) ?? null;
    if (branchId) assertBranchAssignable(branchId);

    const fields = {
      encashable: dto.encashable as boolean | undefined,
      maxEncashDaysPerYear: dto.maxEncashDaysPerYear as number | null | undefined,
      encashBasis: dto.encashBasis as string | undefined,
      monthDays: dto.monthDays as number | undefined,
      accruedOnly: dto.accruedOnly as boolean | undefined,
      allowInService: dto.allowInService as boolean | undefined,
      allowOnExit: dto.allowOnExit as boolean | undefined,
      carryForwardEnabled: dto.carryForwardEnabled as boolean | undefined,
      carryForwardMaxDays: dto.carryForwardMaxDays as number | null | undefined,
      carryForwardExpiryMonths: dto.carryForwardExpiryMonths as number | null | undefined,
      isActive: dto.isActive as boolean | undefined,
    };
    const clean = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    );

    const existing = await this.prisma.leaveTypePolicy.findFirst({
      where: { leaveTypeKey, branchId },
    });

    const data = existing
      ? await this.prisma.leaveTypePolicy.update({
          where: { id: existing.id },
          data: clean as never,
        })
      : await this.prisma.leaveTypePolicy.create({
          data: { leaveTypeKey, branchId, ...clean } as never,
        });

    await this.audit.log({
      userId,
      action: 'LEAVE_ENCASHMENT_RULE_UPDATED',
      resourceType: 'LeaveTypePolicy',
      resourceId: data.id,
      branchId,
      newData: { leaveTypeKey, fields: Object.keys(clean) },
    });
    return { success: true, data };
  }

  // ── Requests ─────────────────────────────────────────────────────────────

  /**
   * What an employee could encash right now, and what limits it.
   *
   * Read-only, and answerable before anybody commits to anything — which is the
   * difference between a form that refuses after submission and one that tells
   * you the number up front.
   */
  async quote(
    employeeId: string,
    leaveTypeKey: string,
    year: number,
    user: unknown,
    requestedDays?: number,
  ) {
    await this.assertEnabled();
    const employee = await this.loadEmployee(employeeId, user, 'quote leave encashment for');

    const { policy, balanceRow, alreadyEncashed, basic, gross } =
      await this.encashmentInputs(employee, leaveTypeKey, year);
    if (!policy) {
      throw new BadRequestException(
        `No encashment policy is configured for ${leaveTypeKey}.`,
      );
    }

    const input = {
      balance: {
        leaveTypeKey,
        allocated: balanceRow?.allocated ?? 0,
        used: balanceRow?.used ?? 0,
        carriedOver: balanceRow?.carriedOver ?? 0,
      },
      policy,
      alreadyEncashed,
      onExit: false,
    };

    if (requestedDays === undefined) {
      const limit = encashableDays(input);
      return { success: true, data: { ...limit, leaveTypeKey, year } };
    }
    const q = quoteEncashment({
      ...input,
      requestedDays,
      monthlyBasic: basic,
      monthlyGross: gross,
    });
    return { success: true, data: { ...q, leaveTypeKey, year } };
  }

  async request(dto: Record<string, unknown>, user: any) {
    await this.assertEnabled();

    // An explicit employeeId that HR may set, derived from the token when it is
    // absent, and refused on mismatch for anyone who is not HR. This is what
    // lets HR file for a leaver — the thing the reimbursement DTO cannot do.
    const requestedFor = (dto.employeeId as string | undefined) ?? user?.employeeId;
    if (!requestedFor) {
      throw new BadRequestException('employeeId is required');
    }
    const isHr = ['ADMIN', 'HR_MANAGER'].includes(String(user?.role));
    if (!isHr && requestedFor !== user?.employeeId) {
      throw new ForbiddenException(
        'You can only request encashment of your own leave.',
      );
    }

    const employee = await this.loadEmployee(
      requestedFor,
      user,
      'request leave encashment for',
    );
    if (!employee.branchId) {
      throw new BadRequestException(
        'This employee has no branch, so encashment cannot be costed to one.',
      );
    }
    if (isHr) assertBranchAssignable(employee.branchId);

    const leaveTypeKey = String(dto.leaveTypeKey ?? '').trim();
    const year = Number(dto.year ?? new Date().getUTCFullYear());
    const days = Number(dto.days ?? 0);

    const { policy, balanceRow, alreadyEncashed, basic, gross } =
      await this.encashmentInputs(employee, leaveTypeKey, year);
    if (!policy) {
      throw new BadRequestException(
        `No encashment policy is configured for ${leaveTypeKey}.`,
      );
    }

    const quote = quoteEncashment({
      balance: {
        leaveTypeKey,
        allocated: balanceRow?.allocated ?? 0,
        used: balanceRow?.used ?? 0,
        carriedOver: balanceRow?.carriedOver ?? 0,
      },
      policy,
      alreadyEncashed,
      onExit: false,
      requestedDays: days,
      monthlyBasic: basic,
      monthlyGross: gross,
    });
    if (quote.refusal) throw new BadRequestException(quote.refusal);

    const created = await this.prisma.leaveEncashmentRequest
      .create({
        data: {
          employeeId: employee.id,
          branchId: employee.branchId,
          leaveTypeKey,
          year,
          days: new Prisma.Decimal(quote.days.toFixed(2)),
          reason: (dto.reason as string) ?? null,
          requestedBy: user?.id ?? null,
          status: 'PENDING',
        },
      })
      .catch((e) => {
        throw this.explainWriteFailure(e, leaveTypeKey, year);
      });

    await this.audit.log({
      userId: user?.id,
      action: 'LEAVE_ENCASHMENT_REQUESTED',
      resourceType: 'LeaveEncashmentRequest',
      resourceId: created.id,
      branchId: employee.branchId,
      newData: { leaveTypeKey, year, days: quote.days },
    });
    return { success: true, data: { ...created, quote } };
  }

  /**
   * Approve, snapshotting the rate.
   *
   * The rate is fixed here and never recomputed at payment: an employee whose
   * salary rises between approval and payday should be paid what was approved,
   * and one whose salary falls should not be paid less than they were told.
   */
  async approve(id: string, user: any) {
    await this.assertEnabled();
    const req = await this.prisma.leaveEncashmentRequest.findUnique({
      where: { id },
      include: {
        employee: {
          select: { id: true, departmentId: true, branchId: true, fullName: true, employeeCode: true, baseSalary: true },
        },
      },
    });
    if (!req) throw new NotFoundException('Encashment request not found');
    assertCanAccessEmployeeRecord(user, req.employee, 'approve leave encashment for');
    assertBranchAssignable(req.branchId);
    if (req.status !== 'PENDING') {
      throw new ConflictException(
        `This request is ${req.status}, so it cannot be approved.`,
      );
    }

    const { policy, balanceRow, alreadyEncashed, basic, gross } =
      await this.encashmentInputs(req.employee, req.leaveTypeKey, req.year, id);
    if (!policy) {
      throw new BadRequestException(
        `No encashment policy is configured for ${req.leaveTypeKey}.`,
      );
    }
    const quote = quoteEncashment({
      balance: {
        leaveTypeKey: req.leaveTypeKey,
        allocated: balanceRow?.allocated ?? 0,
        used: balanceRow?.used ?? 0,
        carriedOver: balanceRow?.carriedOver ?? 0,
      },
      policy,
      alreadyEncashed,
      onExit: false,
      requestedDays: Number(req.days),
      monthlyBasic: basic,
      monthlyGross: gross,
    });
    // Re-checked at approval, not only at request: the balance may have moved
    // since, and approving more than is available is how a balance goes negative.
    if (quote.refusal) throw new BadRequestException(quote.refusal);

    const data = await this.prisma.leaveEncashmentRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        ratePerDay: new Prisma.Decimal(quote.ratePerDay.toFixed(2)),
        amount: new Prisma.Decimal(quote.amount.toFixed(2)),
        approvedBy: user?.id ?? null,
        approvedAt: new Date(),
      },
    });

    await this.audit.log({
      userId: user?.id,
      action: 'LEAVE_ENCASHMENT_APPROVED',
      resourceType: 'LeaveEncashmentRequest',
      resourceId: id,
      branchId: req.branchId,
      oldData: { status: 'PENDING' },
      newData: { status: 'APPROVED', amount: quote.amount, ratePerDay: quote.ratePerDay },
    });
    return { success: true, data };
  }

  async reject(id: string, reason: string, user: any) {
    await this.assertEnabled();
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to reject a request.');
    }
    const req = await this.prisma.leaveEncashmentRequest.findUnique({
      where: { id },
      include: { employee: { select: { id: true, departmentId: true, branchId: true } } },
    });
    if (!req) throw new NotFoundException('Encashment request not found');
    assertCanAccessEmployeeRecord(user, req.employee, 'reject leave encashment for');
    if (req.status !== 'PENDING') {
      throw new ConflictException(`This request is ${req.status}.`);
    }
    const data = await this.prisma.leaveEncashmentRequest.update({
      where: { id },
      data: { status: 'REJECTED', rejectedReason: reason },
    });
    await this.audit.log({
      userId: user?.id,
      action: 'LEAVE_ENCASHMENT_REJECTED',
      resourceType: 'LeaveEncashmentRequest',
      resourceId: id,
      branchId: req.branchId,
      newData: { reason },
    });
    return { success: true, data };
  }

  async listFor(employeeId: string, user: unknown) {
    const employee = await this.loadEmployee(employeeId, user, 'view leave encashment for');
    const data = await this.prisma.leaveEncashmentRequest.findMany({
      where: { employeeId: employee.id },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data };
  }

  // ── The payroll seam ─────────────────────────────────────────────────────

  /**
   * Approved requests the next run should pay.
   *
   * `payrollItemId: null` is the double-inclusion guard, exactly as it is for
   * reimbursements: a request already carried by a run is invisible to the next.
   */
  async loadForPayroll(
    employeeIds: string[],
    branchId: string,
  ): Promise<Map<string, { total: number; ids: string[] }>> {
    const out = new Map<string, { total: number; ids: string[] }>();
    for (const id of employeeIds) out.set(id, { total: 0, ids: [] });
    if (employeeIds.length === 0) return out;

    const rows = await this.prisma.leaveEncashmentRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        branchId,
        status: 'APPROVED',
        payrollItemId: null,
      },
      select: { id: true, employeeId: true, amount: true },
    });
    for (const r of rows) {
      const entry = out.get(r.employeeId);
      if (!entry) continue;
      entry.total += Number(r.amount ?? 0);
      entry.ids.push(r.id);
    }
    return out;
  }

  /** Link the requests a run paid to the item that paid them. */
  async linkToItem(
    tx: Prisma.TransactionClient,
    payrollItemId: string,
    requestIds: string[],
  ): Promise<void> {
    if (requestIds.length === 0) return;
    await tx.leaveEncashmentRequest.updateMany({
      where: { id: { in: requestIds }, status: 'APPROVED', payrollItemId: null },
      data: { payrollItemId },
    });
  }

  /**
   * At lock: mark them paid, and consume the days.
   *
   * The days move to `used` because they have been paid for. Without this an
   * employee is paid for a day and still holds it, and the carry-forward then
   * carries a day that was already money.
   */
  async settleForPayroll(
    tx: Prisma.TransactionClient,
    payrollId: string,
  ): Promise<number> {
    const rows = await tx.leaveEncashmentRequest.findMany({
      where: { payrollItem: { payrollId }, status: 'APPROVED' },
      select: { id: true, employeeId: true, leaveTypeKey: true, year: true, days: true },
    });
    if (rows.length === 0) return 0;

    await tx.leaveEncashmentRequest.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: 'PAID', paidAt: new Date() },
    });
    for (const r of rows) {
      await tx.leaveTypeBalance.updateMany({
        where: {
          employeeId: r.employeeId,
          year: r.year,
          leaveTypeKey: r.leaveTypeKey,
        },
        data: { used: { increment: Math.round(Number(r.days)) } },
      });
    }
    return rows.length;
  }

  /** At unlock: put them back, and release the days. */
  async reverseForPayroll(
    tx: Prisma.TransactionClient,
    payrollId: string,
  ): Promise<number> {
    const rows = await tx.leaveEncashmentRequest.findMany({
      where: { payrollItem: { payrollId }, status: 'PAID' },
      select: { id: true, employeeId: true, leaveTypeKey: true, year: true, days: true },
    });
    if (rows.length === 0) return 0;

    await tx.leaveEncashmentRequest.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: 'APPROVED', paidAt: null },
    });
    for (const r of rows) {
      await tx.leaveTypeBalance.updateMany({
        where: {
          employeeId: r.employeeId,
          year: r.year,
          leaveTypeKey: r.leaveTypeKey,
        },
        data: { used: { decrement: Math.round(Number(r.days)) } },
      });
    }
    return rows.length;
  }

  // ── Carry-forward ────────────────────────────────────────────────────────

  /**
   * Move unused balance into the next year, capped and stamped.
   *
   * The most dangerous operation here — it rewrites every employee's balance —
   * so: one branch and one year at a time, never a sweep; the whole thing in one
   * transaction; every row it touches stamped with the run id; and the unique
   * key on (branch, fromYear, toYear) means a second execution is refused rather
   * than silently doubling everyone's balance.
   */
  async runCarryForward(
    dto: { branchId: string; fromYear: number; toYear?: number },
    user: any,
  ) {
    const f = await this.features.resolve();
    if (!f.leaveCarryForwardEnabled) {
      throw new NotFoundException('Leave carry-forward is not enabled');
    }
    const branchId = dto.branchId;
    if (!branchId) throw new BadRequestException('branchId is required');
    assertBranchAssignable(branchId);

    const fromYear = Number(dto.fromYear);
    const toYear = Number(dto.toYear ?? fromYear + 1);
    if (!Number.isInteger(fromYear) || toYear <= fromYear) {
      throw new BadRequestException(
        '`toYear` must be a later year than `fromYear`.',
      );
    }

    const already = await this.prisma.leaveCarryForwardRun.findFirst({
      where: { branchId, fromYear, toYear, status: 'APPLIED' },
    });
    if (already) {
      throw new ConflictException(
        `Carry-forward from ${fromYear} to ${toYear} has already been run for ` +
          `this branch on ${already.executedAt.toISOString().slice(0, 10)}. ` +
          `Running it again would double every carried balance. Reverse that run first.`,
      );
    }

    const policies = (await this.prisma.leaveTypePolicy.findMany()).map(toPolicyLike);
    const balances = await this.prisma.leaveTypeBalance.findMany({
      where: { year: fromYear, employee: { branchId } },
      select: {
        id: true,
        employeeId: true,
        leaveTypeKey: true,
        allocated: true,
        used: true,
        carriedOver: true,
      },
    });

    const encashed = await this.prisma.leaveEncashmentRequest.groupBy({
      by: ['employeeId', 'leaveTypeKey'],
      where: { branchId, year: fromYear, status: 'PAID' },
      _sum: { days: true },
    });
    const encashedBy = new Map(
      encashed.map((e) => [
        `${e.employeeId}:${e.leaveTypeKey}`,
        Number(e._sum.days ?? 0),
      ]),
    );

    const working: unknown[] = [];
    let carriedTotal = 0;
    let lapsedTotal = 0;
    const touched = new Set<string>();

    const result = await this.prisma.$transaction(async (tx) => {
      const run = await tx.leaveCarryForwardRun.create({
        data: {
          branchId,
          fromYear,
          toYear,
          leaveTypeKeys: [...new Set(balances.map((b) => b.leaveTypeKey))],
          workingJson: {} as never,
          executedBy: user?.id ?? null,
        },
      });

      for (const b of balances) {
        const policy = resolvePolicy(policies, b.leaveTypeKey, branchId);
        if (!policy) continue;

        const outcome = carryForwardFor({
          balance: {
            leaveTypeKey: b.leaveTypeKey,
            allocated: b.allocated,
            used: b.used,
            carriedOver: b.carriedOver,
          },
          policy,
          encashedThisYear: encashedBy.get(`${b.employeeId}:${b.leaveTypeKey}`) ?? 0,
        });

        carriedTotal += outcome.carried;
        lapsedTotal += outcome.lapsed;
        working.push({
          employeeId: b.employeeId,
          leaveTypeKey: b.leaveTypeKey,
          carried: outcome.carried,
          lapsed: outcome.lapsed,
          reasons: outcome.reasons,
        });
        if (outcome.carried <= 0) continue;

        touched.add(b.employeeId);
        const expiresOn = outcome.expiresOn
          ? new Date(Date.UTC(toYear, outcome.expiresOn.addMonths, 0))
          : null;

        await tx.leaveTypeBalance.upsert({
          where: {
            employeeId_year_leaveTypeKey: {
              employeeId: b.employeeId,
              year: toYear,
              leaveTypeKey: b.leaveTypeKey,
            },
          },
          create: {
            employeeId: b.employeeId,
            year: toYear,
            leaveTypeKey: b.leaveTypeKey,
            allocated: 0,
            used: 0,
            carriedOver: Math.round(outcome.carried),
            carriedOverExpiresOn: expiresOn,
            carriedFromYear: fromYear,
            carryForwardRunId: run.id,
          },
          update: {
            carriedOver: Math.round(outcome.carried),
            carriedOverExpiresOn: expiresOn,
            carriedFromYear: fromYear,
            carryForwardRunId: run.id,
          },
        });
      }

      return tx.leaveCarryForwardRun.update({
        where: { id: run.id },
        data: {
          employeeCount: touched.size,
          daysCarried: new Prisma.Decimal(carriedTotal.toFixed(2)),
          daysLapsed: new Prisma.Decimal(lapsedTotal.toFixed(2)),
          workingJson: { entries: working } as never,
        },
      });
    });

    await this.audit.log({
      userId: user?.id,
      action: 'LEAVE_CARRY_FORWARD_APPLIED',
      resourceType: 'LeaveCarryForwardRun',
      resourceId: result.id,
      branchId,
      newData: {
        fromYear,
        toYear,
        employeeCount: touched.size,
        daysCarried: carriedTotal,
        daysLapsed: lapsedTotal,
      },
    });
    return { success: true, data: result };
  }

  /**
   * Undo one carry-forward run, and nothing else.
   *
   * Only the balances stamped with this run id are touched, so an accrual or an
   * allocation written afterwards survives untouched.
   */
  async reverseCarryForward(runId: string, user: any) {
    const run = await this.prisma.leaveCarryForwardRun.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException('Carry-forward run not found');
    assertBranchAssignable(run.branchId);
    if (run.status !== 'APPLIED') {
      throw new ConflictException('This run has already been reversed.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.leaveTypeBalance.updateMany({
        where: { carryForwardRunId: runId },
        data: {
          carriedOver: 0,
          carriedOverExpiresOn: null,
          carriedFromYear: null,
          carryForwardRunId: null,
        },
      });
      await tx.leaveCarryForwardRun.update({
        where: { id: runId },
        data: { status: 'REVERSED', reversedBy: user?.id ?? null, reversedAt: new Date() },
      });
    });

    await this.audit.log({
      userId: user?.id,
      action: 'LEAVE_CARRY_FORWARD_REVERSED',
      resourceType: 'LeaveCarryForwardRun',
      resourceId: runId,
      branchId: run.branchId,
      newData: { fromYear: run.fromYear, toYear: run.toYear },
    });
    return { success: true };
  }

  async listCarryForwardRuns(branchId?: string) {
    const data = await this.prisma.leaveCarryForwardRun.findMany({
      where: branchId ? { branchId } : {},
      orderBy: { executedAt: 'desc' },
    });
    return { success: true, data };
  }

  // ── Shared ───────────────────────────────────────────────────────────────

  private async loadEmployee(employeeId: string, user: unknown, verb: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        fullName: true,
        employeeCode: true,
        departmentId: true,
        branchId: true,
        baseSalary: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    assertCanAccessEmployeeRecord(user, employee, verb);
    return employee;
  }

  private async encashmentInputs(
    employee: { id: string; branchId: string | null; baseSalary: unknown },
    leaveTypeKey: string,
    year: number,
    excludeRequestId?: string,
  ) {
    const [policies, balanceRow, encashed, components] = await Promise.all([
      this.prisma.leaveTypePolicy.findMany({ where: { leaveTypeKey } }),
      this.prisma.leaveTypeBalance.findFirst({
        where: { employeeId: employee.id, year, leaveTypeKey },
      }),
      this.prisma.leaveEncashmentRequest.aggregate({
        where: {
          employeeId: employee.id,
          leaveTypeKey,
          year,
          status: { in: ['PENDING', 'APPROVED', 'PAID'] },
          ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
        },
        _sum: { days: true },
      }),
      this.prisma.salaryComponent.findMany({
        where: { employeeId: employee.id, isActive: true },
        select: { componentType: true, amount: true },
      }),
    ]);

    const basicFromComponents = components
      .filter((c) => c.componentType === 'BASIC')
      .reduce((a, c) => a + Number(c.amount), 0);
    const grossFromComponents = components
      .filter((c) => c.componentType !== 'PAYROLL_CONFIG')
      .reduce((a, c) => a + Number(c.amount), 0);

    return {
      policy: resolvePolicy(
        policies.map(toPolicyLike),
        leaveTypeKey,
        employee.branchId,
      ),
      balanceRow,
      alreadyEncashed: Number(encashed._sum.days ?? 0),
      basic: basicFromComponents > 0 ? basicFromComponents : Number(employee.baseSalary),
      gross: grossFromComponents > 0 ? grossFromComponents : Number(employee.baseSalary),
    };
  }

  private explainWriteFailure(e: unknown, leaveTypeKey: string, year: number): Error {
    const message = e instanceof Error ? e.message : String(e);
    // Prisma reports a unique violation as P2002 and does not always name a
    // PARTIAL index in the message, so the code is checked as well as the text —
    // otherwise this leaks as a 500 and the caller is told nothing at all.
    const code = (e as { code?: string })?.code;
    if (code === 'P2002' || message.includes('uniq_leave_encashment_live')) {
      return new ConflictException(
        `There is already a live encashment request for ${leaveTypeKey} in ${year}. ` +
          `Two requests against the same balance is how an employee is paid for ` +
          `the same days twice — cancel or complete the existing one first.`,
      );
    }
    return e as Error;
  }
}
