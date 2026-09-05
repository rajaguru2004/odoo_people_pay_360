import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BudgetCommitmentService } from '../budgets/budget-commitment.service';
import { getBranchContext } from '../common/branch/branch-context';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { roundMoney } from '../common/utils/money.util';
import {
  LoanPolicyService,
  DEFAULT_LOAN_POLICY,
} from '../advance-loans/loan-policy.service';
import {
  LoanRecoveryService,
  type LoanCandidate,
  type RecoveryPlan,
} from '../advance-loans/loan-recovery.service';
import { LoanNotificationService } from '../advance-loans/loan-notification.service';
import { LoanScheduleService } from '../advance-loans/loan-schedule.service';
import type { LeaveLoanPolicy } from '../advance-loans/loan.types';
import { CreatePayrollDto, UpdatePayrollItemDto } from './dto/payroll.dto';
import { HolidaysService } from '../holidays/holidays.service';
import { OvertimeService } from '../overtime/overtime.service';
import { SalaryComponentsService } from '../salary-components/salary-components.service';
import {
  SystemSettingsService,
  PayrollConfig,
} from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import { ResolvedOvertimeConfig } from '../overtime-policy/overtime-policy.types';
import {
  SalaryBasisValue,
  computeEarnedSalary,
  hourlyRateFor,
  isDailyWage,
  resolveContractedRates,
  resolveContractedRatesDetailed,
  type ContractedRates,
  toSalaryBasis,
} from './payroll-earnings.util';
import {
  Employee,
  Contract,
  Attendance,
  Reward,
  Discipline,
  SalaryComponent,
  Prisma,
  PayrollStatus,
  PayrollRunType,
  LeaveRequest,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { GarnishmentsService } from '../garnishments/garnishments.service';
import { PayrollFeaturesService } from './payroll-features.service';
import { PayrollItemLinesService } from './payroll-item-lines.service';
import { GratuityService } from '../gratuity/gratuity.service';
import { LeaveEncashmentService } from '../leave-encashment/leave-encashment.service';
import { EmployeeRecoveriesService } from '../employee-recoveries/employee-recoveries.service';
import {
  allocateRecoveries,
  type RecoveryAllocation,
  type RecoveryOrder,
} from '../employee-recoveries/recovery-allocator';
import type {
  BuildLinesInput,
  FigureInput,
  LineBucket,
  LineSourceType,
} from './payroll-item-lines.util';
// The same 2dp rounding the payslip lines and the reports use, so a YTD total
// cannot disagree with the payslips it adds up.
import { round2 } from './payroll-item-lines.util';
import {
  allocateGarnishments,
  type GarnishmentAllocation,
} from '../garnishments/garnishment-allocator';

type EmployeeWithRelations = Employee & {
  contracts?: Contract[];
  attendances?: Attendance[];
  rewards?: Reward[];
  disciplines?: Discipline[];
  leaveRequests?: LeaveRequest[];
};

export interface HistoryItem {
  action: string;
  timestamp: Date;
  status: string;
  performedBy?: string;
  reason?: string | null;
}

/** Fallback constants kept only as last-resort defaults (Indian IT payroll) */
const FALLBACK_MIN_PART_TIME_HOURS = 20;

/**
 * Payroll statuses an employee is allowed to see. A payroll is only surfaced to
 * the employee once HR has approved/locked it — DRAFT, PENDING_APPROVAL and
 * REJECTED runs stay internal to HR.
 */
export const EMPLOYEE_VISIBLE_PAYROLL_STATUSES: Prisma.EnumPayrollStatusFilter = {
  in: [PayrollStatus.APPROVED, PayrollStatus.LOCKED],
};

// Rounding lives in common/utils/money.util.ts so payroll and the loan
// amortization engine share exactly one convention. Do not reintroduce a local
// copy — see that file's header.

/**
 * The uncombined parts behind one payslip's columns, kept only long enough to
 * build its itemised lines.
 *
 * The engine stores `insurance` as PF + ESI and `tax` as income tax +
 * professional tax, so by the time a row is written those four figures cannot
 * be told apart. This carries them out of the calculation and no further.
 */
interface PayrollLineDetail {
  components: Array<{
    code: string;
    bucket: 'baseSalary' | 'allowances';
    amount: number;
  }>;
  pf: number;
  esi: number;
  incomeTax: number;
  professionalTax: number;
  disciplineDeduction: number;
  lopDeduction: number;
  carriedDeduction: number;
  garnishmentLines: Array<{
    reference: string;
    amount: number;
    id: string | null;
  }>;
  loanLines: Array<{ requestId: string; amount: number }>;
}

/**
 * Turn one payslip's captured parts plus its STORED columns into line input.
 *
 * The totals come from the row, never from a recomputation, because that is
 * what the lines have to reconcile against — a breakdown that adds up to a
 * figure the payslip does not show is worse than no breakdown at all.
 *
 * Where a bucket has a total but no detail (a loan restated by a concurrent
 * run, a garnishment plan that produced no named lines), one summary line is
 * emitted for the whole column rather than none: an unexplained column would
 * fail reconciliation and refuse the run.
 */
function buildLineInputFromDetail(
  d: PayrollLineDetail,
  item: {
    baseSalary: unknown;
    allowances: unknown;
    bonus: unknown;
    overtimePay: unknown;
    foodAllowance: unknown;
    siteAllowance: unknown;
    reimbursement: unknown;
    deduction: unknown;
    advanceLoanDeduction: unknown;
    garnishment: unknown;
    insurance: unknown;
    tax: unknown;
  },
): BuildLinesInput {
  const n = (v: unknown) => roundMoney(Number(v ?? 0));
  const totals = {
    baseSalary: n(item.baseSalary),
    allowances: n(item.allowances),
    bonus: n(item.bonus),
    overtimePay: n(item.overtimePay),
    foodAllowance: n(item.foodAllowance),
    siteAllowance: n(item.siteAllowance),
    reimbursement: n(item.reimbursement),
    deduction: n(item.deduction),
    advanceLoanDeduction: n(item.advanceLoanDeduction),
    garnishment: n(item.garnishment),
    insurance: n(item.insurance),
    tax: n(item.tax),
  };

  const one = (
    code: string,
    label: string,
    amount: number,
    sourceType: LineSourceType,
    sourceId?: string | null,
  ) => ({ code, label, amount, sourceType, sourceId: sourceId ?? null });

  // `deduction` is the engine's catch-all: loss of pay, disciplinary amounts and
  // arrears recovered from an earlier payslip all land in one column.
  const deductionFigures = [
    d.lopDeduction > 0 && one('LOP', 'Loss of pay', d.lopDeduction, 'LOP'),
    d.disciplineDeduction > 0 &&
      one(
        'DISCIPLINE',
        'Disciplinary deduction',
        d.disciplineDeduction,
        'DISCIPLINE',
      ),
    d.carriedDeduction > 0 &&
      one(
        'CARRIED_DEDUCTION',
        'Deduction carried from an earlier payroll',
        d.carriedDeduction,
        'CARRY_FORWARD',
      ),
  ].filter(Boolean) as FigureInput[];

  const garnishmentFigures: FigureInput[] = d.garnishmentLines
    .filter((g) => g.amount > 0)
    .map((g) =>
      one(
        'GARNISHMENT',
        `Court order ${g.reference}`,
        g.amount,
        'GARNISHMENT',
        g.id,
      ),
    );

  const loanFigures: FigureInput[] = d.loanLines
    .filter((l) => l.amount > 0)
    .map((l) =>
      one(
        'LOAN_EMI',
        'Loan / advance instalment',
        l.amount,
        'LOAN',
        l.requestId,
      ),
    );

  const sum = (f: FigureInput[]) =>
    roundMoney(f.reduce((a, x) => a + x.amount, 0));

  /** Cover a column whose detail is missing or was restated underneath us. */
  const reconciled = (
    figures: FigureInput[],
    total: number,
    fallback: () => FigureInput,
  ): FigureInput[] => {
    if (total <= 0) return [];
    if (figures.length === 0) return [fallback()];
    return Math.abs(sum(figures) - total) > 0.005 ? [fallback()] : figures;
  };

  return {
    components: d.components.map((c) => ({
      code: c.code,
      bucket: c.bucket,
      amount: c.amount,
    })),
    totals,
    figures: {
      bonus:
        totals.bonus > 0
          ? [one('BONUS', 'Bonus / reward', totals.bonus, 'REWARD')]
          : [],
      overtimePay:
        totals.overtimePay > 0
          ? [one('OVERTIME', 'Overtime', totals.overtimePay, 'OVERTIME')]
          : [],
      foodAllowance:
        totals.foodAllowance > 0
          ? [
              one(
                'FOOD_ALLOWANCE',
                'Food allowance (overtime)',
                totals.foodAllowance,
                'OVERTIME',
              ),
            ]
          : [],
      siteAllowance:
        totals.siteAllowance > 0
          ? [
              one(
                'SITE_ALLOWANCE',
                'Site allowance (overtime)',
                totals.siteAllowance,
                'OVERTIME',
              ),
            ]
          : [],
      reimbursement:
        totals.reimbursement > 0
          ? [
              one(
                'REIMBURSEMENT',
                'Reimbursement',
                totals.reimbursement,
                'REIMBURSEMENT',
              ),
            ]
          : [],
      deduction: reconciled(deductionFigures, totals.deduction, () =>
        one('DEDUCTION', 'Deduction', totals.deduction, 'MANUAL'),
      ),
      advanceLoanDeduction: reconciled(
        loanFigures,
        totals.advanceLoanDeduction,
        () =>
          one(
            'LOAN_EMI',
            'Loan / advance instalment',
            totals.advanceLoanDeduction,
            'LOAN',
          ),
      ),
      garnishment: reconciled(garnishmentFigures, totals.garnishment, () =>
        one(
          'GARNISHMENT',
          'Court-ordered deduction',
          totals.garnishment,
          'GARNISHMENT',
        ),
      ),
      // PF and ESI finally split: the column sums them and cannot say which is
      // which, and until now that breakdown lived only in the free-text note.
      insurance: reconciled(
        [
          d.pf > 0 && one('PF', 'Provident fund', d.pf, 'STATUTORY'),
          d.esi > 0 &&
            one('ESI', 'Employee state insurance', d.esi, 'STATUTORY'),
        ].filter(Boolean) as FigureInput[],
        totals.insurance,
        () =>
          one(
            'INSURANCE',
            'Statutory insurance',
            totals.insurance,
            'STATUTORY',
          ),
      ),
      tax: reconciled(
        [
          d.incomeTax > 0 &&
            one('INCOME_TAX', 'Income tax', d.incomeTax, 'STATUTORY'),
          d.professionalTax > 0 &&
            one(
              'PROFESSIONAL_TAX',
              'Professional tax',
              d.professionalTax,
              'STATUTORY',
            ),
        ].filter(Boolean) as FigureInput[],
        totals.tax,
        () => one('TAX', 'Tax', totals.tax, 'STATUTORY'),
      ),
    },
  };
}

/**
 * Buckets `updateItem` does not recompute, whose generated lines therefore stay
 * accurate and are carried across the rewrite.
 */
const UPDATE_ITEM_UNTOUCHED_BUCKETS: LineBucket[] = [
  'baseSalary',
  'reimbursement',
  'advanceLoanDeduction',
  'garnishment',
];

/** Re-use the surviving lines of an untouched bucket, or summarise the column. */
function figuresFromKept(
  kept: Array<{
    bucket: string;
    code: string;
    label: string;
    amount: unknown;
    sourceId: string | null;
  }>,
  bucket: LineBucket,
  total: number,
): FigureInput[] {
  if (total <= 0) return [];
  const mine = kept.filter((l) => l.bucket === bucket);
  const sum = roundMoney(mine.reduce((a, l) => a + Number(l.amount), 0));
  if (mine.length > 0 && Math.abs(sum - total) <= 0.005) {
    return mine.map((l) => ({
      code: l.code,
      label: l.label,
      amount: Number(l.amount),
      sourceType: 'MANUAL' as LineSourceType,
      sourceId: l.sourceId,
    }));
  }
  return [
    {
      code: bucket.toUpperCase(),
      label: bucket,
      amount: total,
      sourceType: 'MANUAL' as LineSourceType,
    },
  ];
}

@Injectable()
export class PayrollsService {
  constructor(
    private prisma: PrismaService,
    private holidaysService: HolidaysService,
    private overtimeService: OvertimeService,
    private salaryComponentsService: SalaryComponentsService,
    private systemSettingsService: SystemSettingsService,
    private notifications: NotificationsService,
    private overtimePolicyService: OvertimePolicyService,
    private budgetCommitments: BudgetCommitmentService,
    private loanPolicy: LoanPolicyService,
    private loanRecovery: LoanRecoveryService,
    private loanNotifications: LoanNotificationService,
    private loanSchedules: LoanScheduleService,
    private dispatcher: NotificationDispatcher,
    private audit: AuditService,
    private garnishments: GarnishmentsService,
    private features: PayrollFeaturesService,
    private itemLines: PayrollItemLinesService,
    // End-of-service provisions are written when a run locks and reversed when
    // it is unlocked or deleted. One-way: GratuityModule never imports this one.
    private gratuity: GratuityService,
    // Approved encashment requests are paid by the next run, exactly as
    // reimbursements are. One-way: LeaveEncashmentModule never imports this one.
    private encashment: LeaveEncashmentService,
    // Employer recoveries sit after the loan ladder. One-way:
    // EmployeeRecoveriesModule never imports this one.
    private recoveries: EmployeeRecoveriesService,
  ) {}

  private readonly logger = new Logger(PayrollsService.name);

  /**
   * Effective overtime config for one approved OT row, resolved from the policy
   * snapshotted on the row (null → legacy global config). Memoized per run via
   * the supplied cache so a policy is loaded at most once per payroll run.
   */
  private async otConfigForRow(
    ot: { overtimePolicyId?: string | null },
    cache: Map<string, ResolvedOvertimeConfig>,
  ): Promise<ResolvedOvertimeConfig> {
    const key = ot.overtimePolicyId ?? '__legacy__';
    let cfg = cache.get(key);
    if (!cfg) {
      cfg = await this.overtimePolicyService.configForPolicyId(
        ot.overtimePolicyId ?? null,
      );
      cache.set(key, cfg);
    }
    return cfg;
  }

  async create(dto: CreatePayrollDto) {
    // Per-branch payroll: a run must target one concrete branch. `employee`
    // reads below are auto-scoped, so without a selected branch a run would
    // silently cover everyone (global) or one branch (scoped) — resolve the
    // target explicitly and stamp it. When branch scoping is disabled for the
    // request (ctx null), fall back to the legacy company-wide run.
    const ctx = getBranchContext();
    let runBranchId: string | null = null;
    if (ctx) {
      runBranchId =
        ctx.effectiveBranchId ??
        (!ctx.isAllBranches && ctx.accessibleBranchIds.length === 1
          ? ctx.accessibleBranchIds[0]
          : null);
      if (!runBranchId) {
        throw new BadRequestException(
          'Select a specific branch before generating payroll — payroll runs are per-branch.',
        );
      }
    }

    // Check if payroll exists. Scoped by branch so two branches can each run the
    // same period, and matching the columns of the DB constraint that backs this
    // check (uniq_payroll_period_branch_batch_version, migration 20260805100000)
    // — this findFirst is only a friendly error, the index is what actually
    // prevents the concurrent-create race.
    const existing = await this.prisma.payroll.findFirst({
      where: {
        month: dto.month,
        year: dto.year,
        batchId: dto.batchId || null,
        branchId: runBranchId,
      },
      select: { id: true, status: true },
    });
    if (existing) {
      const where = `${dto.month}/${dto.year}${dto.batchId ? ' (Batch ' + dto.batchId + ')' : ''}`;
      // A LOCKED period and an in-flight one need DIFFERENT actions — "wait for
      // the current run to finish" against "this period is settled, correct it
      // with a revision" — and the old message said only that the period was
      // taken, so the operator could not tell which. `DELETE` on the same run
      // already names the lock; this now matches it.
      throw new ConflictException(
        existing.status === 'LOCKED'
          ? `Payroll for ${where} is LOCKED and cannot be regenerated. Create a revision to correct it.`
          : `Payroll for ${where} already exists`,
      );
    }

    console.log(`🔄 Starting payroll creation for ${dto.month}/${dto.year}...`);

    // Resolve targeted employee IDs
    let targetEmployeeIds: string[] | undefined = undefined;
    /** Ids the caller asked for that resolved to nobody payable. Returned so a
     *  stale or mistyped id is visible rather than silently dropped (G23). */
    let unmatchedEmployeeIds: string[] = [];
    if (dto.batchId) {
      const batchMembers = await this.prisma.payrollBatchMember.findMany({
        where: { batchId: dto.batchId },
        select: { employeeId: true },
      });
      targetEmployeeIds = batchMembers.map((m) => m.employeeId);
      if (targetEmployeeIds.length === 0) {
        throw new BadRequestException(
          'The selected payroll batch has no employees.',
        );
      }
    } else if (dto.employeeIds && dto.employeeIds.length > 0) {
      targetEmployeeIds = dto.employeeIds;
    }

    // G32 — a FINAL_SETTLEMENT run is the one that pays a leaver what they are
    // owed and closes the file, so it must be able to REACH a leaver. Every
    // soft-exit path writes `INACTIVE` on the Employee, so excluding INACTIVE
    // here meant the natural HR order — close the record, then settle — produced
    // a run the leaver was silently absent from, and the run looked complete.
    //
    // Widened only for this run type: every other type still pays ACTIVE staff
    // only. A settlement run must also be TARGETED (a batch or an explicit
    // employee list), so it cannot sweep up everyone who ever left the company.
    const settlementRun = dto.runType === PayrollRunType.FINAL_SETTLEMENT;
    const employeeWhereClause: any =
      settlementRun && targetEmployeeIds
        ? { status: { in: ['ACTIVE', 'INACTIVE'] } }
        : { status: 'ACTIVE' };
    if (targetEmployeeIds) {
      employeeWhereClause.id = { in: targetEmployeeIds };
    }

    // Get all active employees with their related data in one query
    const employees = await this.prisma.employee.findMany({
      where: employeeWhereClause,
      include: {
        contracts: {
          where: { status: 'ACTIVE' },
          orderBy: { startDate: 'desc' },
          take: 1,
        },
        attendances: {
          where: {
            date: {
              gte: new Date(Date.UTC(dto.year, dto.month - 1, 1)),
              lte: new Date(Date.UTC(dto.year, dto.month, 0)),
            },
            status: { in: ['PRESENT', 'LEAVE'] },
          },
        },
        rewards: {
          where: {
            rewardDate: {
              gte: new Date(Date.UTC(dto.year, dto.month - 1, 1)),
              lte: new Date(Date.UTC(dto.year, dto.month, 0)),
            },
          },
        },
        disciplines: {
          where: {
            disciplineDate: {
              gte: new Date(Date.UTC(dto.year, dto.month - 1, 1)),
              lte: new Date(Date.UTC(dto.year, dto.month, 0)),
            },
          },
        },
        leaveRequests: {
          where: {
            status: 'APPROVED',
            startDate: { lte: new Date(Date.UTC(dto.year, dto.month, 0)) },
            endDate: { gte: new Date(Date.UTC(dto.year, dto.month - 1, 1)) },
          },
        },
      },
    });

    console.log(`📋 Found ${employees.length} active employees`);

    // ── G23 — an empty or partly-unmatched population is stated, not swallowed
    //
    // A run naming only unknown ids used to answer 201 with zero items and
    // `totalAmount: 0`, and the run-level attendance guard below is skipped
    // entirely when the population is empty — so "payroll produced nothing" and
    // "payroll was never given anyone" looked identical on screen. A mistyped
    // filter yielded a clean, approvable, zero-value payroll.
    if (targetEmployeeIds) {
      const found = new Set(employees.map((e) => e.id));
      const unmatched = targetEmployeeIds.filter((id) => !found.has(id));

      if (employees.length === 0) {
        throw new BadRequestException(
          `None of the ${targetEmployeeIds.length} selected employee(s) can be paid in this run — ` +
            `they are not active${settlementRun ? '' : ' (or have left)'}, are outside this branch, or do not exist. ` +
            'Payroll was not created.',
        );
      }
      if (unmatched.length > 0) {
        // Partial match is the common shape — some ids good, some stale. The run
        // is still created for the ones that resolved, but the ones that did not
        // are NAMED rather than silently dropped.
        console.warn(
          `⚠️  ${unmatched.length} selected employee(s) matched nobody and were not paid: ${unmatched.join(', ')}`,
        );
      }
      unmatchedEmployeeIds = unmatched;
    } else if (employees.length === 0) {
      throw new BadRequestException(
        'This branch has no employees who can be paid, so payroll was not created.',
      );
    }

    // Detect which employees actually have attendance CAPTURED for the month.
    // Zero rows means attendance was never processed for that employee — which
    // must NOT be treated as "absent all month" (that would wipe the entire
    // salary via LOP). We skip LOP and flag those items.
    //
    // `source: 'LEAVE'` rows are excluded deliberately, and the exclusion is the
    // whole point of the filter. Approving leave WRITES attendance rows
    // (`leave-requests.service.ts`, `status: 'LEAVE'`, `source: 'LEAVE'`), so
    // counting them made a single approved day of leave look like "attendance was
    // processed" — which switched this protection OFF and turned every uncaptured
    // working day in the month into loss of pay. Measured before the fix: an
    // employee on 1500 with no captured attendance and ONE day of approved PAID
    // leave was paid 67.67 instead of 1488.75, with a payslip reading
    // "Loss of Pay (LOP): 21 day(s) deducted". This is the exact failure the
    // guard exists to prevent, re-entering through the leave door.
    //
    // The question the guard has to answer is "did a human or a device record
    // this employee's attendance?", and a row the system wrote for itself is not
    // evidence of that.
    const attendanceCounts = await this.prisma.attendance.groupBy({
      by: ['employeeId'],
      where: {
        employeeId: { in: employees.map((e) => e.id) },
        date: {
          gte: new Date(Date.UTC(dto.year, dto.month - 1, 1)),
          lte: new Date(Date.UTC(dto.year, dto.month, 0)),
        },
        // Anything the system generated on the employee's behalf is not capture.
        OR: [{ source: null }, { source: { notIn: ['LEAVE'] } }],
      },
      _count: { _all: true },
    });
    const employeesWithAttendance = new Set(
      attendanceCounts
        .filter((c) => c._count._all > 0)
        .map((c) => c.employeeId),
    );

    // Guard: refuse to generate payroll when no attendance has been captured for
    // the period. Without it, every employee would count as absent for all
    // working days and LOP would wipe the entire salary — a wrong result driven
    // by missing data, not real absence. HR must process attendance first.
    if (employees.length > 0 && employeesWithAttendance.size === 0) {
      throw new BadRequestException(
        `Attendance for ${dto.month}/${dto.year} has not been processed yet. ` +
          `Process attendance for this period before running payroll.`,
      );
    }

    // Batch load all salary components
    const salaryComponentsMap = new Map<string, SalaryComponent[]>();
    try {
      // `effectiveDate` is the date the component STARTS applying, so a
      // component dated after the period being run has not started yet and must
      // not be paid in it. Without this filter the column was decorative — it
      // only ever ordered rows — and a raise recorded in advance was paid from
      // the moment it was entered rather than from the month it takes effect.
      //
      // The mirror consequence is deliberate: a component entered TODAY does not
      // reach into a back-dated run for an earlier month. That is what an
      // effective date means; a genuine retro adjustment is an ADJUSTMENT run or
      // a back-dated `effectiveDate`, not a silent reach backwards.
      const allSalaryComponents = await this.prisma.salaryComponent.findMany({
        where: {
          employeeId: { in: employees.map((e) => e.id) },
          isActive: true,
          effectiveDate: { lte: new Date(Date.UTC(dto.year, dto.month, 0)) },
        },
      });

      // Group by employeeId
      for (const sc of allSalaryComponents) {
        let list = salaryComponentsMap.get(sc.employeeId);
        if (!list) {
          list = [];
          salaryComponentsMap.set(sc.employeeId, list);
        }
        list.push(sc);
      }
    } catch {
      console.warn('Failed to load salary components, using base salaries');
    }

    // Load payroll configuration from admin settings (Indian IT defaults if not overridden)
    const payrollConfig = await this.systemSettingsService.getPayrollConfig();

    // Which leave types are paid. LeaveRequest.leaveType holds a LEAVE_TYPE
    // library label, and that library row carries an explicit isPaid flag — so
    // resolve paid-ness from the flag rather than from the literal 'UNPAID'.
    // With payroll_daily_wage_pay_leave on, this decides real cash: a custom
    // type like "Leave Without Pay" would otherwise be paid out.
    const unpaidLeaveTypes = new Set<string>(['UNPAID']);
    // Per-leave-type loan behaviour ('CONTINUE' | 'PAUSE' | 'EXTEND' | null).
    // Maternity / sabbatical / suspension / long medical each get their own
    // rule by setting the column on their LEAVE_TYPE library row — no new code.
    const leaveLoanPolicyByType = new Map<string, LeaveLoanPolicy>();
    try {
      const leaveTypeRows = await this.prisma.libraryItem.findMany({
        where: { libraryType: 'LEAVE_TYPE' },
        select: { label: true, isPaid: true, loanDeductionPolicy: true },
      });
      for (const row of leaveTypeRows) {
        if (row.isPaid === false) unpaidLeaveTypes.add(row.label);
        const p = (row.loanDeductionPolicy ?? '').toUpperCase();
        if (p === 'CONTINUE' || p === 'PAUSE' || p === 'EXTEND') {
          leaveLoanPolicyByType.set(row.label, p);
        }
      }
    } catch {
      // Library unavailable — fall back to the literal check alone.
    }
    const isPaidLeaveType = (leaveType?: string | null) =>
      !!leaveType && !unpaidLeaveTypes.has(leaveType);

    // Work days for the month, resolved per branch (each branch may have its
    // own weekly-off days + holidays). Memoized for the run.
    const workDaysByBranch = new Map<string | null, number>();
    const workDaysFor = async (branchId: string | null): Promise<number> => {
      const key = branchId ?? null;
      if (!workDaysByBranch.has(key)) {
        workDaysByBranch.set(
          key,
          await this.holidaysService.getWorkDaysInMonth(
            dto.month,
            dto.year,
            branchId ?? undefined,
          ),
        );
      }
      return workDaysByBranch.get(key)!;
    };

    // Public-holiday dates for the month, per branch, memoized the same way.
    // Only reached when payroll_daily_wage_pay_holidays is on — keeping it lazy
    // means the default path makes no extra query.
    const holidayDatesByBranch = new Map<string | null, string[]>();
    const holidayDatesFor = async (
      branchId: string | null,
    ): Promise<string[]> => {
      const key = branchId ?? null;
      if (!holidayDatesByBranch.has(key)) {
        holidayDatesByBranch.set(
          key,
          await this.holidaysService.getPaidHolidayDatesInMonth(
            dto.month,
            dto.year,
            branchId ?? undefined,
          ),
        );
      }
      return holidayDatesByBranch.get(key)!;
    };

    // Batch load all overtime hours and food allowances
    const overtimeHoursMap = new Map<string, number>();
    const overtimePayMap = new Map<string, number>();
    const foodAllowanceMap = new Map<string, number>();
    const siteAllowanceMap = new Map<string, number>();
    try {
      const allOvertimes = await this.prisma.overtimeRequest.findMany({
        where: {
          employeeId: { in: employees.map((e) => e.id) },
          status: 'APPROVED',
          date: {
            gte: new Date(Date.UTC(dto.year, dto.month - 1, 1)),
            lte: new Date(Date.UTC(dto.year, dto.month, 0)),
          },
        },
      });

      // Per-run cache of resolved overtime configs, keyed by the policy
      // snapshotted on each OT row (null → legacy global config).
      const otCfgCache = new Map<string, ResolvedOvertimeConfig>();

      for (const emp of employees) {
        const empOvertimes = allOvertimes.filter(
          (o) => o.employeeId === emp.id,
        );
        let hoursSum = 0;
        let paySum = 0;
        let foodSum = 0;
        let siteSum = 0;

        const empWorkDays = await workDaysFor(emp.branchId);
        const salaryComponents = await this.prorateComponentsForPeriod(
          salaryComponentsMap.get(emp.id) || [],
          dto.month,
          dto.year,
          emp.branchId,
          empWorkDays,
        );
        const rates = resolveContractedRates(emp.baseSalary, salaryComponents);
        // Daily-wage staff carry a per-DAY rate, so their overtime hour is
        // rate/hoursPerDay — spreading it over the month's work days as if it
        // were a monthly salary understates overtime ~workDays-fold.
        const hourlyRate = hourlyRateFor(
          toSalaryBasis(emp.salaryType),
          rates.fullRate,
          empWorkDays,
          payrollConfig.workHoursPerDay,
        );

        for (const ot of empOvertimes) {
          const otCfg = await this.otConfigForRow(ot, otCfgCache);
          const tier = this.overtimeRowTier(ot, hourlyRate, otCfg);
          paySum += tier.pay;
          hoursSum += tier.hours;
          foodSum += Number(ot.foodAllowance || 0);
          // Approver-granted per request; never derived, so there is nothing to
          // recompute here — it is only ever summed.
          siteSum += Number(ot.siteAllowance || 0);
        }

        overtimeHoursMap.set(emp.id, hoursSum);
        overtimePayMap.set(emp.id, paySum);
        foodAllowanceMap.set(emp.id, foodSum);
        siteAllowanceMap.set(emp.id, siteSum);
      }
    } catch (err) {
      console.warn('Failed to load overtime data', err);
    }

    // Batch load approved reimbursements not yet included in any payroll.
    // Selection is "APPROVED and unlinked" (not a date window) so requests
    // approved after a month was locked ride the next payroll run.
    const reimbursementMap = new Map<string, number>();
    const reimbursementIdsMap = new Map<string, string[]>();
    try {
      const pendingReimbursements = await this.prisma.reimbursement.findMany({
        where: {
          employeeId: { in: employees.map((e) => e.id) },
          status: 'APPROVED',
          payrollItemId: null,
        },
        select: { id: true, employeeId: true, amount: true },
      });
      for (const r of pendingReimbursements) {
        reimbursementMap.set(
          r.employeeId,
          (reimbursementMap.get(r.employeeId) || 0) + Number(r.amount),
        );
        const ids = reimbursementIdsMap.get(r.employeeId) || [];
        ids.push(r.id);
        reimbursementIdsMap.set(r.employeeId, ids);
      }
    } catch (err) {
      console.warn('Failed to load reimbursement data', err);
    }

    // Resolved BEFORE any transaction opens, and before the loaders below: with
    // a switch off the run issues no extra statements at all, rather than
    // issuing one that finds nothing.
    const features = await this.features.resolve();

    // ── End-of-service paid through this run ──────────────────────────────
    //
    // Only on a FINAL_SETTLEMENT run, and only when the installation says the
    // exit payout must reach the wage file. Everywhere else gratuity stays a
    // provision that never touches a payslip, which is what keeps it out of
    // every tax and insurance base.
    const gratuityPayoutMap = new Map<string, number>();
    if (
      features.eosbEnabled &&
      features.eosbPayThroughFinalRun &&
      (dto.runType ?? 'REGULAR') === 'FINAL_SETTLEMENT'
    ) {
      const asOf = new Date(Date.UTC(dto.year, dto.month, 0));
      for (const emp of employees) {
        try {
          const res = await this.gratuity.entitlementFor(
            emp.id,
            { role: 'ADMIN' },
            asOf,
          );
          const amount = Number((res as { data?: { amount?: number } })?.data?.amount ?? 0);
          if (amount > 0) gratuityPayoutMap.set(emp.id, roundMoney(amount));
        } catch (err) {
          // One employee's missing nationality class must not fail the run for
          // everybody else; the entitlement service already refuses in words.
          this.logger.warn(
            `Gratuity payout skipped for ${emp.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    // ── Employer recoveries ───────────────────────────────────────────────
    //
    // Asset damage, training bonds, notice shortfalls. Loaded like garnishments
    // and allocated AFTER the loan ladder — a loan is money the employee asked
    // for on an agreed schedule, a recovery is a claim the employer asserted, so
    // when pay is short the schedule is honoured and the claim waits. A recovery
    // is never exempt from the take-home floor.
    let recoveryInputs = new Map<string, RecoveryOrder[]>();
    if (features.employeeRecoveryEnabled) {
      try {
        recoveryInputs = await this.recoveries.loadForPayroll(
          employees.map((e) => e.id),
          new Date(Date.UTC(dto.year, dto.month - 1, 1)),
          new Date(Date.UTC(dto.year, dto.month, 0)),
        );
      } catch (err) {
        console.warn('Failed to load employee recovery data', err);
      }
    }

    // ── Leave encashment ──────────────────────────────────────────────────
    //
    // Approved requests not yet carried by any run, loaded exactly as
    // reimbursements are: `payrollItemId: null` is the double-inclusion guard,
    // so a request one run already paid is invisible to the next.
    let encashmentMap = new Map<string, { total: number; ids: string[] }>();
    if (features.leaveEncashmentEnabled && runBranchId) {
      try {
        encashmentMap = await this.encashment.loadForPayroll(
          employees.map((e) => e.id),
          runBranchId,
        );
      } catch (err) {
        console.warn('Failed to load leave encashment data', err);
      }
    }

    // ── Advance/loan recovery: candidate load ──────────────────────────────
    //
    // Only the CANDIDATES are loaded here. How much of each is actually taken
    // cannot be decided yet, because affordability depends on net pay and net
    // pay is not known until calculateSalaryOptimized has run. Recovery is
    // therefore applied per employee INSIDE the loop below (see applyRecovery),
    // which is what makes partial salary, LWP and multi-loan competition for a
    // limited net expressible at all.
    //
    // Selection is date-based and in-flight guarded: everything due this cycle
    // OR EARLIER (so arrears sweep forward) with no PENDING ledger row (so an
    // instalment already carried by an unlocked draft is not taken twice).
    // Balances still only move at lock time.
    const runType = dto.runType ?? 'REGULAR';
    let loanPolicy = DEFAULT_LOAN_POLICY;
    try {
      loanPolicy = await this.loanPolicy.resolve(runBranchId ?? null);
    } catch (err) {
      this.logger.error(
        `Loan policy resolution failed, falling back to defaults: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const advanceLoanPlanMap = new Map<string, RecoveryPlan>();

    // Court orders outrank every voluntary recovery, so they are resolved for
    // the whole population BEFORE the loan ladder runs and the figure is fed
    // into it — `LoanRecoveryService.allocateForEmployee` already subtracts
    // `garnishment` from the pool a loan may reach. Until this existed the
    // engine passed a literal 0 and the ladder's first rung was unreachable.
    const garnishPeriodStart = new Date(Date.UTC(dto.year, dto.month - 1, 1));
    const garnishPeriodEnd = new Date(Date.UTC(dto.year, dto.month, 0));
    const garnishmentInputs = await this.garnishments.loadForPayroll(
      employees.map((e) => e.id),
      garnishPeriodStart,
      garnishPeriodEnd,
    );
    // Keyed by employee; the branch is carried alongside because the
    // carry-forward ledger is branch-scoped and `Payroll.branchId` is nullable
    // in the schema even though every real run has one.
    const garnishmentPlanMap = new Map<
      string,
      { allocation: GarnishmentAllocation; branchId: string }
    >();

    // Deduction balances an EARLIER run could not take. Collected last of all,
    // after the court order and the loan ladder, because a manual payslip
    // deduction is the weakest claim on the pay of the three.
    const deductionCarry = await this.garnishments.loadDeductionCarryForwards(
      employees.map((e) => e.id),
    );
    const deductionSettlementMap = new Map<
      string,
      Array<{ id: string; amount: number }>
    >();

    let loanCandidates = new Map<string, LoanCandidate[]>();
    try {
      loanCandidates = await this.loanRecovery.loadCandidates(
        employees.map((e) => e.id),
        dto.month,
        dto.year,
        runType,
        loanPolicy,
      );
    } catch (err) {
      // Legacy behaviour was an unconditional swallow, which silently produced
      // a payroll with ZERO loan recovery and no trace. With v2 ON this becomes
      // a policy decision — FAIL (the default) refuses to produce a payroll
      // that under-deducts. With v2 OFF the old soft-dependency is preserved
      // exactly, because the kill-switch must mean "behave as before".
      const message = err instanceof Error ? err.message : String(err);
      if (
        loanPolicy.moduleV2Enabled &&
        loanPolicy.recoveryFailurePolicy === 'FAIL'
      ) {
        throw new BadRequestException(
          `Loan recovery planning failed: ${message}`,
        );
      }
      this.logger.error(`Failed to load advance/loan data: ${message}`);
    }

    // Create payroll. The findFirst above is a friendly pre-check; this is the
    // authoritative one. uniq_payroll_period_branch_batch_version rejects the
    // second of two concurrent creates for the same period, which the old
    // NULL-permitting constraint let through.
    let payroll: Awaited<ReturnType<typeof this.prisma.payroll.create>>;
    try {
      payroll = await this.prisma.payroll.create({
        data: {
          month: dto.month,
          year: dto.year,
          status: 'DRAFT',
          totalAmount: 0,
          batchId: dto.batchId || null,
          branchId: runBranchId,
          runType: runType as PayrollRunType,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `Payroll for ${dto.month}/${dto.year}${dto.batchId ? ' (Batch ' + dto.batchId + ')' : ''} already exists`,
        );
      }
      throw err;
    }

    // Calculate salary for each employee (now with pre-loaded data)
    // Decimal, not a float accumulator: over hundreds of rows `+=` on a JS number
    // drifts before it is ever narrowed to the Decimal column, so the run total
    // could disagree with the sum of its own items.
    /** employeeId -> the parts behind the columns, for itemisation. */
    const lineDetailMap = new Map<string, PayrollLineDetail>();
    /** employeeId -> what the employer recoveries took, for persistence. */
    const recoveryPlanMap = new Map<
      string,
      { allocation: RecoveryAllocation; branchId: string }
    >();

    let totalAmount = new Prisma.Decimal(0);
    const payrollItems: Prisma.PayrollItemCreateManyInput[] = [];

    for (const emp of employees) {
      const salaryComponents = await this.prorateComponentsForPeriod(
        salaryComponentsMap.get(emp.id) || [],
        dto.month,
        dto.year,
        emp.branchId,
        await workDaysFor(emp.branchId),
      );
      const overtimeHours = overtimeHoursMap.get(emp.id) || 0;
      const overtimePay = overtimePayMap.get(emp.id) || 0;
      const foodAllowance = foodAllowanceMap.get(emp.id) || 0;
      const siteAllowance = siteAllowanceMap.get(emp.id) || 0;
      const reimbursement = reimbursementMap.get(emp.id) || 0;

      // Apply per-employee payroll config overrides (stored as PAYROLL_CONFIG component note JSON)
      const payrollConfigComponent = salaryComponents.find(
        (sc) => sc.componentType === 'PAYROLL_CONFIG',
      );
      let effectivePayrollConfig = payrollConfig;
      if (payrollConfigComponent?.note) {
        try {
          const overrides = JSON.parse(payrollConfigComponent.note) as {
            pfEnabled?: boolean;
            esiEnabled?: boolean;
            professionalTaxEnabled?: boolean;
          };
          effectivePayrollConfig = {
            ...payrollConfig,
            ...(overrides.pfEnabled !== undefined && {
              pfEnabled: overrides.pfEnabled,
            }),
            ...(overrides.esiEnabled !== undefined && {
              esiEnabled: overrides.esiEnabled,
            }),
            ...(overrides.professionalTaxEnabled !== undefined && {
              professionalTaxEnabled: overrides.professionalTaxEnabled,
            }),
          };
        } catch {
          // malformed JSON — fall back to global config
        }
      }

      let presentDays = 0;
      let paidLeaveDays = 0;
      // Every date with an attendance row. Attendances are pre-filtered to
      // PRESENT/LEAVE with no holiday exclusion, so a daily-wage worker who
      // WORKED a public holiday is already being paid for it via presentDays.
      // This set stops the paid-holiday pass paying them a second time.
      const attendedDates = new Set<string>();

      const approvedLeaves = emp.leaveRequests || [];

      for (const att of emp.attendances || []) {
        attendedDates.add(new Date(att.date).toISOString().split('T')[0]);
        if (att.status === 'PRESENT') {
          presentDays++;
        } else if (att.status === 'LEAVE') {
          const attDate = new Date(att.date);
          const approvedLeave = approvedLeaves.find((lr) => {
            const start = new Date(lr.startDate);
            const end = new Date(lr.endDate);
            start.setUTCHours(0, 0, 0, 0);
            end.setUTCHours(0, 0, 0, 0);
            attDate.setUTCHours(0, 0, 0, 0);
            return attDate >= start && attDate <= end;
          });

          if (approvedLeave && isPaidLeaveType(approvedLeave.leaveType)) {
            paidLeaveDays++;
          }
        }
      }

      let effectiveWorkDays = presentDays + paidLeaveDays;

      // No attendance rows AT ALL for this employee in this period.
      //
      // The run-level guard above refuses a period where NOBODY has attendance.
      // This is the same fault one employee at a time — a late joiner processed
      // after the import, a device that failed to sync, a branch whose
      // attendance was not run — and it had the same consequence the run-level
      // guard exists to prevent: zero rows read as "absent every working day",
      // LOP consumed the whole salary, and the employee was paid NOTHING while
      // the rest of the run looked entirely normal.
      //
      // Missing data is not evidence of absence. Treat them as fully present and
      // flag the item, so the figure is safe and the gap is visible to whoever
      // reviews the run. A daily-wage worker is deliberately excluded: their pay
      // IS the days worked, so "no days recorded" is a real zero, not a gap.
      const attendanceMissing =
        !employeesWithAttendance.has(emp.id) && !isDailyWage(emp.salaryType);

      // Working days this employee was actually EMPLOYED for. Equal to the
      // branch month for anyone whose employment spans it, and smaller for a
      // joiner or a leaver whose dates fall inside the period.
      //
      // It exists because "treat missing attendance as fully present" was being
      // applied to people who were not there to be present. Measured before the
      // fix: an employee whose `startDate` was the LAST working day of the month,
      // with no attendance captured, was paid a full month — the same 1488.75 as
      // a colleague of several years.
      const tenureWorkDays = await this.workDaysWithinEmployment(
        emp,
        dto.month,
        dto.year,
        await workDaysFor(emp.branchId),
      );

      if (attendanceMissing) {
        // Fully present for the part of the period they were employed — not for
        // the whole month.
        effectiveWorkDays = tenureWorkDays;
        presentDays = effectiveWorkDays;
      }

      // ── Daily-wage extras ───────────────────────────────────────────────
      // Both default to 0, which is the baseline rule: a daily-wage employee is
      // paid strictly for days actually worked.
      const isDaily = isDailyWage(emp.salaryType);
      const dailyPaidLeaveDays =
        isDaily && effectivePayrollConfig.dailyWagePayLeave ? paidLeaveDays : 0;

      let dailyPaidHolidayDays = 0;
      if (isDaily && effectivePayrollConfig.dailyWagePayHolidays) {
        const startIso = new Date(emp.startDate).toISOString().split('T')[0];
        const endIso = emp.endDate
          ? new Date(emp.endDate).toISOString().split('T')[0]
          : null;
        const dates = await holidayDatesFor(emp.branchId);
        dailyPaidHolidayDays = dates.filter(
          (d) =>
            // Already paid as a worked (or leave) day.
            !attendedDates.has(d) &&
            // Inside the employment window — otherwise someone joining on the
            // 28th is paid for every holiday earlier in the month.
            d >= startIso &&
            (!endIso || d <= endIso),
        ).length;
      }

      // Pass 1: net pay with ZERO loan recovery. Affordability is a function of
      // this figure, so recovery cannot be an input to it.
      // Encashment is looked up BEFORE the engine runs, because whether it
      // belongs inside the statutory base decides how it is passed in.
      const encashmentEntry = encashmentMap.get(emp.id);
      const encashmentPay = roundMoney(encashmentEntry?.total ?? 0);
      const encashmentIsTaxable =
        features.leaveEncashmentEnabled && features.leaveEncashmentTaxable;

      const preRecovery = this.calculateSalaryOptimized(
        emp,
        dto.month,
        dto.year,
        await workDaysFor(emp.branchId),
        salaryComponents,
        overtimeHours,
        overtimePay,
        effectivePayrollConfig,
        presentDays,
        effectiveWorkDays,
        foodAllowance,
        reimbursement,
        0,
        { leave: dailyPaidLeaveDays, holiday: dailyPaidHolidayDays },
        encashmentIsTaxable ? encashmentPay : 0,
        siteAllowance,
      );

      // Unpaid-leave days actually falling in this cycle, plus the loan policy
      // of every leave type involved — the inputs the allocator needs for the
      // CONTINUE / PAUSE / EXTEND decision.
      const cycleStart = new Date(Date.UTC(dto.year, dto.month - 1, 1));
      const cycleEnd = new Date(Date.UTC(dto.year, dto.month, 0));
      let unpaidLeaveDays = 0;
      const leavePolicies: (LeaveLoanPolicy | null)[] = [];
      for (const lv of approvedLeaves) {
        if (isPaidLeaveType(lv.leaveType)) continue;
        const from = new Date(
          Math.max(new Date(lv.startDate).getTime(), cycleStart.getTime()),
        );
        const to = new Date(
          Math.min(new Date(lv.endDate).getTime(), cycleEnd.getTime()),
        );
        if (to < from) continue;
        unpaidLeaveDays +=
          Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
        leavePolicies.push(leaveLoanPolicyByType.get(lv.leaveType) ?? null);
      }

      // Pass 2a: court orders, which come off the top. Their own shortfall is
      // carried to the next run rather than lapsing, so a period that cannot
      // satisfy an order under-recovers ONCE instead of silently forgiving a
      // legally binding instruction.
      const gInputs = garnishmentInputs.get(emp.id) ?? {
        orders: [],
        carried: [],
      };
      const garnishPlan = allocateGarnishments(
        {
          employeeId: emp.id,
          netPreRecovery: preRecovery.netSalary,
          periodStart: garnishPeriodStart,
          periodEnd: garnishPeriodEnd,
        },
        gInputs.orders,
        gInputs.carried,
      );
      if (garnishPlan.lines.length > 0) {
        const gBranchId = payroll.branchId ?? emp.branchId ?? runBranchId;
        if (gBranchId) {
          garnishmentPlanMap.set(emp.id, {
            allocation: garnishPlan,
            branchId: gBranchId,
          });
        }
      }

      // Pass 2b: decide the recovery against the now-known net, then apply it.
      const plan = LoanRecoveryService.allocateForEmployee(
        {
          employeeId: emp.id,
          netPreRecovery: preRecovery.netSalary,
          garnishment: garnishPlan.totalTaken,
          unpaidLeaveDays,
          leavePolicies,
          // Lets the allocator ask how far into a loan's life this cycle is,
          // which is what the grace rule needs.
          cycleKey: dto.year * 12 + dto.month,
        },
        loanCandidates.get(emp.id) ?? [],
        loanPolicy,
        runType,
      );
      if (plan.lines.length > 0) advanceLoanPlanMap.set(emp.id, plan);

      // Arithmetically identical to subtracting the recovery inside
      // calculateSalaryOptimized, which is why the existing net/tax/PF
      // assertions still hold.
      const netAfterRecovery = Math.max(
        0,
        preRecovery.netSalary - garnishPlan.totalTaken - plan.totalRecovered,
      );

      // Pass 2c: whatever an earlier payslip could not deduct. Bounded by what
      // is left after the court order and the loan ladder, so collecting arrears
      // can never drive net below zero and open a fresh shortfall in its place.
      // Pass 2b-2: employer recoveries, from what the loan ladder left.
      const recoveryPlan = features.employeeRecoveryEnabled
        ? allocateRecoveries(
            {
              employeeId: emp.id,
              available: netAfterRecovery,
              periodStart: garnishPeriodStart,
              periodEnd: garnishPeriodEnd,
            },
            recoveryInputs.get(emp.id) ?? [],
          )
        : { totalTaken: 0, lines: [], noteLines: [] };
      if (recoveryPlan.lines.length > 0) {
        const rBranchId = payroll.branchId ?? emp.branchId ?? runBranchId;
        if (rBranchId) {
          recoveryPlanMap.set(emp.id, {
            allocation: recoveryPlan,
            branchId: rBranchId,
          });
        }
      }
      const netAfterEmployerRecovery = Math.max(
        0,
        netAfterRecovery - recoveryPlan.totalTaken,
      );

      const carriedDeduction = GarnishmentsService.allocateCarriedDeductions(
        deductionCarry.get(emp.id) ?? [],
        netAfterEmployerRecovery,
      );
      if (carriedDeduction.settled.length > 0) {
        deductionSettlementMap.set(emp.id, carriedDeduction.settled);
      }

      const item = {
        ...preRecovery,
        // Added AFTER the statutory pipeline, like `reimbursement`. Whether
        // encashment belongs in the taxable base is a legal question, not an
        // engineering one — `leave_encashment_taxable` exists to answer it, and
        // it is on the open-questions list for the advisor.
        leaveEncashment: encashmentPay,
        // Post-tax, like a reimbursement: an end-of-service benefit is not
        // ordinary earnings, and putting it through the statutory pipeline
        // would tax a payment most jurisdictions exempt.
        gratuityPayout: gratuityPayoutMap.get(emp.id) ?? 0,
        otherRecovery: roundMoney(recoveryPlan.totalTaken),
        garnishment: roundMoney(garnishPlan.totalTaken),
        advanceLoanDeduction: roundMoney(plan.totalRecovered),
        deduction: roundMoney(
          Number(preRecovery.deduction ?? 0) + carriedDeduction.taken,
        ),
        netSalary: roundMoney(
          Math.max(0, netAfterEmployerRecovery - carriedDeduction.taken) +
            // Added here ONLY when it was not already inside gross. Doing both
            // would pay the encashment twice; doing neither would pay it never.
            (encashmentIsTaxable ? 0 : encashmentPay) +
            (gratuityPayoutMap.get(emp.id) ?? 0),
        ),
      };
      if (carriedDeduction.taken > 0) {
        garnishPlan.noteLines.push(
          `Deduction carried forward from an earlier payroll: ` +
            `${carriedDeduction.taken} recovered.`,
        );
      }

      // Itemisation detail for this employee, captured while the uncombined
      // parts are still in scope. Nothing is written yet: the loan reconciler
      // further down can restate `advanceLoanDeduction`, and a breakdown built
      // before that would disagree with the payslip it explains.
      if (features.itemLinesEnabled) {
        lineDetailMap.set(emp.id, {
          components: (preRecovery.earningComponents ?? []).map((c) => ({
            code: c.code,
            // `calculateSalaryOptimized` already narrows this to the two
            // earning buckets; the annotation is here because the return type
            // widens to string on the way through the payroll item shape.
            bucket: c.bucket as 'baseSalary' | 'allowances',
            amount: c.amount,
          })),
          pf: preRecovery.pf ?? 0,
          esi: preRecovery.esi ?? 0,
          incomeTax: preRecovery.incomeTax ?? 0,
          professionalTax: preRecovery.professionalTax ?? 0,
          disciplineDeduction: preRecovery.disciplineDeduction ?? 0,
          lopDeduction: preRecovery.lopDeduction ?? 0,
          carriedDeduction: carriedDeduction.taken,
          garnishmentLines: garnishPlan.lines.map((l: any) => ({
            reference: String(l.courtReference ?? l.reference ?? 'Court order'),
            amount: Number(l.amount ?? l.taken ?? 0),
            id: l.garnishmentId ?? l.id ?? null,
          })),
          loanLines: plan.lines.map((l: any) => ({
            requestId: String(l.requestId ?? ''),
            amount: Number(l.amount ?? 0),
          })),
        });
      }

      const noteParts: string[] = [
        ...garnishPlan.noteLines,
        ...plan.noteLines,
        ...recoveryPlan.noteLines,
      ];
      if (isDailyWage(item.salaryType)) {
        // Only spell out the breakdown when something beyond worked days was
        // paid, so the common note stays short.
        const extras: string[] = [];
        if (item.paidLeaveDays > 0)
          extras.push(`paid leave ${item.paidLeaveDays}`);
        if (item.paidHolidayDays > 0)
          extras.push(`public holidays ${item.paidHolidayDays}`);
        noteParts.push(
          extras.length
            ? `Daily wage: ${item.payableDays} day(s) paid × ${item.periodRate} per day ` +
                `(worked ${item.payableDays - item.paidLeaveDays - item.paidHolidayDays}, ${extras.join(', ')}).`
            : `Daily wage: ${item.payableDays} day(s) worked × ${item.periodRate} per day.`,
        );
        if (!item.statutoryApplied) {
          noteParts.push('Statutory deductions waived for daily-wage staff.');
        }
      }
      // Days the employee was not employed for are NOT absence, and must not be
      // described as loss of pay. Before this split, a joiner on the last working
      // day of the month received a payslip reading "Loss of Pay (LOP): 22 day(s)
      // deducted" — twenty-two days of "absence" on days before they were hired,
      // which is a sentence an employee disputes and HR cannot defend.
      const branchWorkDays = await workDaysFor(emp.branchId);
      const notEmployedDays = Math.max(0, branchWorkDays - tenureWorkDays);
      const absenceLopDays = Math.max(0, item.lopDays - notEmployedDays);

      if (notEmployedDays > 0) {
        noteParts.push(
          `Employed for ${tenureWorkDays} of ${branchWorkDays} working day(s) this ` +
            `period; the remaining ${notEmployedDays} are outside the employment dates ` +
            'and are not absence.',
        );
      }
      if (absenceLopDays > 0) {
        noteParts.push(`Loss of Pay (LOP): ${absenceLopDays} day(s) deducted.`);
      }
      if (attendanceMissing) {
        // Visible on the payslip and in the run, so the gap is reviewed rather
        // than discovered by the employee on pay day.
        noteParts.push(
          'No attendance was captured for this employee in this period, so no ' +
            'loss of pay was applied. Verify attendance before locking.',
        );
      }
      if (item.esi > 0) {
        noteParts.push(
          `ESI (employee): ${item.esi} included in insurance total.`,
        );
      }
      const itemNotes: string | null = noteParts.length
        ? noteParts.join(' ')
        : null;

      payrollItems.push({
        payrollId: payroll.id,
        employeeId: emp.id,
        baseSalary: item.baseSalary,
        workDays: item.workDays,
        actualWorkDays: item.actualWorkDays,
        allowances: item.allowances,
        bonus: item.bonus,
        deduction: item.deduction,
        overtimeHours: item.overtimeHours,
        overtimePay: item.overtimePay,
        foodAllowance: item.foodAllowance,
        siteAllowance: item.siteAllowance,
        reimbursement: item.reimbursement,
        advanceLoanDeduction: item.advanceLoanDeduction,
        // The column that had been zero on every payslip ever produced. The
        // field list here is explicit, so a value computed above reaches the
        // database only if it is named — which is why this was missed once.
        garnishment: item.garnishment,
        leaveEncashment: item.leaveEncashment,
        gratuityPayout: item.gratuityPayout,
        otherRecovery: item.otherRecovery,
        insurance: item.insurance,
        tax: item.tax,
        netSalary: item.netSalary,
        notes: itemNotes,
      });
      totalAmount = totalAmount.add(new Prisma.Decimal(item.netSalary));
    }

    // Create payroll items in batch, then link the included reimbursements to
    // their payroll items (double-inclusion guard: linked rows are skipped by
    // future runs; deleting a DRAFT payroll SetNulls the link and re-releases them).
    await this.prisma.$transaction(async (tx) => {
      await tx.payrollItem.createMany({ data: payrollItems });

      // Court orders settle inside the same transaction as the items they were
      // priced against, so a run that fails part-way never leaves an order
      // believing it collected money no payslip carries.
      for (const [, settled] of deductionSettlementMap) {
        await this.garnishments.persistDeductionRecovery(
          tx,
          payroll.id,
          settled,
        );
      }

      for (const [employeeId, entry] of recoveryPlanMap) {
        await this.recoveries.persistAllocation(tx, {
          employeeId,
          branchId: entry.branchId,
          payrollId: payroll.id,
          allocation: entry.allocation,
        });
      }

      if (garnishmentPlanMap.size > 0) {
        // `createMany` does not return ids, and `garnishment_deductions` is
        // keyed to the payslip line it came off — which is what lets an unlock
        // reverse each order by exactly what it took rather than by splitting
        // one summed column back out across however many orders an employee is
        // under. One query, after the insert.
        const itemIds = new Map(
          (
            await tx.payrollItem.findMany({
              where: { payrollId: payroll.id },
              select: { id: true, employeeId: true },
            })
          ).map((i) => [i.employeeId, i.id]),
        );
        for (const [employeeId, entry] of garnishmentPlanMap) {
          await this.garnishments.persistAllocation(tx, {
            employeeId,
            branchId: entry.branchId,
            payrollId: payroll.id,
            payrollItemId: itemIds.get(employeeId) ?? null,
            month: dto.month,
            year: dto.year,
            allocation: entry.allocation,
          });
        }
      }

      if (
        reimbursementIdsMap.size > 0 ||
        advanceLoanPlanMap.size > 0 ||
        encashmentMap.size > 0
      ) {
        const createdItems = await tx.payrollItem.findMany({
          where: { payrollId: payroll.id },
          select: { id: true, employeeId: true },
        });
        for (const created of createdItems) {
          // Approved encashment requests, linked exactly as reimbursements are:
          // the link is what makes them invisible to the next run.
          const encashIds = encashmentMap.get(created.employeeId)?.ids ?? [];
          if (encashIds.length > 0) {
            await this.encashment.linkToItem(tx, created.id, encashIds);
          }

          const ids = reimbursementIdsMap.get(created.employeeId);
          if (ids && ids.length > 0) {
            await tx.reimbursement.updateMany({
              where: {
                id: { in: ids },
                status: 'APPROVED',
                payrollItemId: null,
              },
              data: { payrollItemId: created.id },
            });
          }

          // Record advance/loan instalments as ledger rows linked to this
          // payroll item. Rows with an amount flip to PAID (and move balances)
          // at lock. Zero-amount rows are written as SKIPPED so "why was
          // nothing recovered in June?" is answerable from the ledger alone —
          // SKIPPED sits outside the live partial unique index, so it never
          // blocks a genuine recovery in a later cycle.
          const plan = advanceLoanPlanMap.get(created.employeeId);
          if (plan && plan.lines.length > 0) {
            await tx.advanceLoanDeduction.createMany({
              data: plan.lines.map((l) => ({
                requestId: l.requestId,
                scheduleId: l.scheduleId,
                payrollItemId: created.id,
                amount: l.amount,
                principalComponent: l.principalComponent,
                interestComponent: l.interestComponent,
                feeComponent: l.feeComponent,
                plannedAmount: l.plannedAmount,
                shortfallAmount: l.shortfallAmount,
                outcome: l.outcome,
                reason: l.reason,
                month: dto.month,
                year: dto.year,
                status: l.amount > 0 ? 'PENDING' : 'SKIPPED',
              })),
              // A concurrent run that already claimed this instalment loses at
              // the unique index; degrade to "recovers nothing twice" rather
              // than throwing away the whole payroll.
              skipDuplicates: true,
            });

            // ── Reconcile the payslip to what was ACTUALLY inserted ────────
            //
            // skipDuplicates silently drops a row a concurrent run already
            // claimed. Without this, the item would still show the full
            // deduction and the employee's net would be reduced by money that
            // has no ledger row — so nothing flips at lock and the loan is
            // never credited. Withheld but not credited is the worst possible
            // outcome, so trust the ledger and restate the item.
            const written = await tx.advanceLoanDeduction.aggregate({
              where: { payrollItemId: created.id, status: 'PENDING' },
              _sum: { amount: true },
            });
            const actual = roundMoney(Number(written._sum.amount ?? 0));
            const planned = roundMoney(plan.totalRecovered);
            if (Math.abs(actual - planned) > 0.005) {
              const item = await tx.payrollItem.findUnique({
                where: { id: created.id },
                select: { netSalary: true, advanceLoanDeduction: true },
              });
              if (item) {
                // Give back exactly what was not actually claimed.
                const refund = roundMoney(
                  Number(item.advanceLoanDeduction) - actual,
                );
                await tx.payrollItem.update({
                  where: { id: created.id },
                  data: {
                    advanceLoanDeduction: actual,
                    netSalary: roundMoney(Number(item.netSalary) + refund),
                  },
                });
                this.logger.warn(
                  `Loan recovery for payroll item ${created.id} restated from ${planned} to ${actual}: ` +
                    `another run had already claimed the instalment(s).`,
                );
              }
            }
          }
        }
      }

      // ── Itemisation ───────────────────────────────────────────────────
      //
      // Last, and deliberately so: the loan reconciler above can restate an
      // item's `advanceLoanDeduction` and `netSalary` when a concurrent run
      // already claimed an instalment. Lines are built from what is ACTUALLY
      // stored, so a restated payslip and its breakdown cannot disagree.
      if (features.itemLinesEnabled) {
        const finalItems = await tx.payrollItem.findMany({
          where: { payrollId: payroll.id },
          select: {
            id: true,
            employeeId: true,
            baseSalary: true,
            allowances: true,
            bonus: true,
            overtimePay: true,
            foodAllowance: true,
            siteAllowance: true,
            reimbursement: true,
            deduction: true,
            advanceLoanDeduction: true,
            garnishment: true,
            insurance: true,
            tax: true,
          },
        });
        for (const fi of finalItems) {
          const detail = lineDetailMap.get(fi.employeeId);
          if (!detail) continue;
          await this.itemLines.buildAndPersist(tx, {
            payrollItemId: fi.id,
            strict: features.itemLinesStrictReconciliation,
            context: {
              payrollId: payroll.id,
              employeeId: fi.employeeId,
              branchId: payroll.branchId ?? null,
            },
            input: buildLineInputFromDetail(detail, fi),
          });
        }
      }
    });

    // Update total amount
    await this.prisma.payroll.update({
      where: { id: payroll.id },
      data: { totalAmount },
    });

    console.log(
      `✅ Payroll created: ${payrollItems.length} employees, total: ${totalAmount.toString()}`,
    );

    return {
      success: true,
      message: `Payroll created for ${dto.month}/${dto.year}`,
      data: {
        ...payroll,
        // Number at the API boundary, preserving the existing response shape.
        // Only the ACCUMULATION had to be exact; a single 2dp total is safe here.
        totalAmount: totalAmount.toNumber(),
        employeeCount: payrollItems.length,
        // G23 — ids the caller asked for that matched nobody payable. Empty on
        // the ordinary path; non-empty means some of the selection was stale and
        // those people were NOT paid.
        unmatchedEmployeeIds,
      },
    };
  }

  async findAll(query: { year?: number; status?: string }) {
    const { year, status } = query;
    const where: Prisma.PayrollWhereInput = {};
    if (year) where.year = year;
    if (status) where.status = status as PayrollStatus;

    const payrolls = await this.prisma.payroll.findMany({
      where,
      include: {
        _count: { select: { items: true } },
        batch: { select: { id: true, name: true } },
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });

    return { success: true, data: payrolls };
  }

  async findOne(id: string) {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id },
      include: {
        batch: { select: { id: true, name: true } },
        items: {
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                fullName: true,
                // Drives basis-aware columns in the payroll run table.
                salaryType: true,
                department: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    if (!payroll) {
      throw new NotFoundException('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(payroll.branchId);

    // Conditional include, for the reason set out in getEmployeePayslipDetail:
    // with itemisation off the response shape does not change at all.
    const features = await this.features.resolve();
    if (!features.itemLinesEnabled) return { success: true, data: payroll };

    const lines = await this.prisma.payrollItemLine.findMany({
      where: { payrollItemId: { in: payroll.items.map((i) => i.id) } },
      orderBy: { displayOrder: 'asc' },
    });
    const byItem = new Map<string, typeof lines>();
    for (const l of lines) {
      const list = byItem.get(l.payrollItemId) ?? [];
      list.push(l);
      byItem.set(l.payrollItemId, list);
    }

    return {
      success: true,
      data: {
        ...payroll,
        items: payroll.items.map((i) => ({
          ...i,
          lines: byItem.get(i.id) ?? [],
        })),
      },
    };
  }

  async updateItem(
    payrollId: string,
    itemId: string,
    dto: UpdatePayrollItemDto,
  ) {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
    });
    if (!payroll) {
      throw new NotFoundException('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(payroll.branchId);
    if (payroll.status === 'LOCKED') {
      throw new BadRequestException('Cannot update locked payroll');
    }

    const item = await this.prisma.payrollItem.findUnique({
      where: { id: itemId },
      include: { employee: true },
    });
    if (!item || item.payrollId !== payrollId) {
      throw new NotFoundException('Payroll item not found');
    }

    // Recalculate with new values using live payroll config
    const cfg = await this.systemSettingsService.getPayrollConfig();

    const allowances = dto.allowances ?? Number(item.allowances);
    const bonus = dto.bonus ?? Number(item.bonus);
    const deduction = dto.deduction ?? Number(item.deduction);

    const baseSalary = Number(item.baseSalary);
    // The overtime hourly rate comes from the employee's CONTRACTED rate, not
    // from the stored item amounts — for daily-wage staff `item.baseSalary` is
    // already rate × days worked, which would inflate the rate by the day count.
    const salaryType = toSalaryBasis((item.employee as any)?.salaryType);
    const liveComponents = await this.prisma.salaryComponent.findMany({
      where: { employeeId: item.employeeId, isActive: true },
    });
    const rates = resolveContractedRates(
      item.employee?.baseSalary,
      liveComponents,
    );
    const hourlyRate = hourlyRateFor(
      salaryType,
      rates.fullRate,
      item.workDays,
      cfg.workHoursPerDay,
    );

    // Get calculated values from approved requests

    // Get calculated values from approved requests
    const calculatedOt = await this.calculateOvertimePayAndAllowance(
      item.employeeId,
      payroll.month,
      payroll.year,
      hourlyRate,
    );

    let overtimeHours = Number(item.overtimeHours);
    let overtimePay = Number(item.overtimePay);
    let foodAllowance = Number(item.foodAllowance || 0);
    let siteAllowance = Number(item.siteAllowance || 0);

    if (dto.overtimeHours !== undefined) {
      overtimeHours = dto.overtimeHours;
      if (calculatedOt.overtimeHours > 0) {
        overtimePay =
          (overtimeHours / calculatedOt.overtimeHours) *
          calculatedOt.overtimePay;
      } else {
        overtimePay = overtimeHours * hourlyRate * cfg.overtimeRate;
      }
    } else {
      overtimeHours = calculatedOt.overtimeHours;
      overtimePay = calculatedOt.overtimePay;
    }

    if (dto.foodAllowance !== undefined) {
      foodAllowance = dto.foodAllowance;
    } else {
      foodAllowance = calculatedOt.foodAllowance;
    }

    if (dto.siteAllowance !== undefined) {
      siteAllowance = dto.siteAllowance;
    } else {
      siteAllowance = calculatedOt.siteAllowance;
    }

    // Non-taxable: mirrors linked approved reimbursements, never part of gross
    // or any statutory base; added to net after deductions.
    const reimbursement = Number(item.reimbursement || 0);
    // Advance/loan recovery already computed at generation; preserve it so a
    // manual item edit keeps net consistent (post-tax deduction).
    const advanceLoanDeduction = Number(item.advanceLoanDeduction || 0);

    // Normalize to the stored precision before computing anything from these, so
    // the statutory bases and net all derive from exactly what gets persisted —
    // same rule as the create path.
    const basePay = roundMoney(baseSalary);
    const allowancePay = roundMoney(allowances);
    const bonusPay = roundMoney(bonus);
    const deductionAmt = roundMoney(deduction);
    const otPay = roundMoney(overtimePay);
    const foodPay = roundMoney(foodAllowance);
    const sitePay = roundMoney(siteAllowance);
    const reimbPay = roundMoney(reimbursement);
    const loanDeduction = roundMoney(advanceLoanDeduction);

    const grossSalary =
      basePay +
      allowancePay +
      bonusPay -
      deductionAmt +
      otPay +
      foodPay +
      sitePay;

    // Mirror the generation-time rule: daily-wage staff can be exempted from the
    // whole statutory pipeline by admin setting.
    const applyStatutory =
      !isDailyWage(salaryType) || cfg.dailyWageStatutoryDeductions;

    // PF / Social Insurance
    const insurance =
      applyStatutory && cfg.pfEnabled
        ? this.calculatePF(basePay, allowancePay, cfg)
        : 0;

    // ESI (India) — employee contribution on gross when within the wage ceiling.
    // Excluded from the taxable base; folded into the stored insurance total.
    const esi = applyStatutory ? this.calculateESI(grossSalary, cfg) : 0;

    // Professional Tax (India)
    const professionalTax =
      applyStatutory && cfg.professionalTaxEnabled
        ? this.calculateProfessionalTax(grossSalary, cfg)
        : 0;

    // Income Tax (TDS / PIT) — taxable base excludes ESI (only PF & PT reduce it).
    const tax = applyStatutory
      ? this.calculateIncomeTax(grossSalary, insurance, professionalTax, cfg)
      : 0;
    // Computed here only to prove the pipeline runs for these inputs; the
    // figures that persist are `finalInsurance` / `finalTax` below, derived from
    // the deduction the pay can actually bear.
    void insurance;
    void esi;
    void tax;
    void professionalTax;

    // A court order already claimed part of this pay at generation time. It is
    // NOT recomputed here — the order was priced against the run's own figures
    // and settling it twice would double-count — but it must still come off the
    // net, or an item edit silently hands the employee money the court has
    // attached.
    const garnishmentTaken = roundMoney(Number(item.garnishment || 0));

    // ── The shortfall, made honest ──────────────────────────────────────────
    //
    // Net floors at 0: money is not recovered through a payslip, and in a
    // fixed-width wage file a minus sign shifts every subsequent field on the
    // row. But flooring ALONE was the defect — the full `deduction` stayed on
    // the item, so `gross - deductions` came to −97,940 against a stated net of
    // 0, and nothing anywhere recorded that 97,940 had never been taken.
    //
    // So instead of clamping the ANSWER, clamp the INPUT: store the largest
    // deduction the pay can actually bear, carry the rest forward, and say so
    // on the payslip. The item reconciles again, and the shortfall becomes a
    // ledger row rather than a discrepancy someone has to reverse-engineer.
    //
    // Solved rather than derived because the statutory pipeline is not linear
    // in `deduction` — PF, ESI, PT and income tax all move with gross, and each
    // has its own slabs and ceilings. A closed form would have to re-derive all
    // four; a bisection over a monotone function does not, and is exact to the
    // stored precision in ~24 iterations of pure arithmetic.
    const netAtDeduction = (d: number): number => {
      const g =
        basePay + allowancePay + bonusPay - d + otPay + foodPay + sitePay;
      const ins =
        applyStatutory && cfg.pfEnabled
          ? this.calculatePF(basePay, allowancePay, cfg)
          : 0;
      const e = applyStatutory ? this.calculateESI(g, cfg) : 0;
      const pt =
        applyStatutory && cfg.professionalTaxEnabled
          ? this.calculateProfessionalTax(g, cfg)
          : 0;
      const it = applyStatutory ? this.calculateIncomeTax(g, ins, pt, cfg) : 0;
      return (
        g -
        roundMoney(ins + e) -
        roundMoney(it + pt) +
        reimbPay -
        loanDeduction -
        garnishmentTaken
      );
    };

    let appliedDeduction = deductionAmt;
    let deductionShortfall = 0;
    if (netAtDeduction(deductionAmt) < 0) {
      let lo = 0;
      let hi = deductionAmt;
      // `netAtDeduction` decreases monotonically in `d`, so the largest bearable
      // deduction is the boundary between the two.
      for (let i = 0; i < 40 && hi - lo > 0.005; i++) {
        const mid = (lo + hi) / 2;
        if (netAtDeduction(mid) >= 0) lo = mid;
        else hi = mid;
      }
      appliedDeduction = roundMoney(lo);
      // Rounding down to the stored precision can only make net larger, never
      // negative, so the floor holds after the round.
      deductionShortfall = roundMoney(deductionAmt - appliedDeduction);
    }

    const finalGross =
      basePay +
      allowancePay +
      bonusPay -
      appliedDeduction +
      otPay +
      foodPay +
      sitePay;
    // PF and ESI are kept apart here, and only recombined for the stored
    // `insurance` column, because they do not play the same part in the tax
    // base: `create()` reduces taxable income by PF and professional tax only
    // (`calculateSalaryOptimized`: "taxable base excludes ESI"), and an edit
    // must not quietly grant a shield that generating the same payslip does not.
    //
    // Passing the combined figure was also what made the deduction solver miss.
    // `netAtDeduction` models the engine — PF only — so the two disagreed about
    // the tax at any given deduction, the search stopped short of the largest
    // bearable one, and an over-large deduction left net a little above zero
    // with the difference silently added to the carried shortfall.
    const finalPF =
      applyStatutory && cfg.pfEnabled
        ? this.calculatePF(basePay, allowancePay, cfg)
        : 0;
    const finalESI = applyStatutory ? this.calculateESI(finalGross, cfg) : 0;
    const finalInsurance = roundMoney(finalPF + finalESI);
    const finalPT =
      applyStatutory && cfg.professionalTaxEnabled
        ? this.calculateProfessionalTax(finalGross, cfg)
        : 0;
    const finalTax = roundMoney(
      (applyStatutory
        ? this.calculateIncomeTax(finalGross, finalPF, finalPT, cfg)
        : 0) + finalPT,
    );
    const netSalary = Math.max(
      0,
      finalGross -
        finalInsurance -
        finalTax +
        reimbPay -
        loanDeduction -
        garnishmentTaken,
    );

    // Resolved before the transaction opens, same rule as create(): a switch
    // that is off must cost the edit no statements.
    const features = await this.features.resolve();

    let itemNotes = dto.notes ?? item.notes ?? null;
    if (deductionShortfall > 0) {
      const line =
        `Deduction of ${deductionAmt} exceeded the pay available: ` +
        `${appliedDeduction} was taken and ${deductionShortfall} is carried ` +
        `forward to the next payroll.`;
      itemNotes = itemNotes ? `${itemNotes} ${line}` : line;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Idempotent: an item edited twice must leave ONE carried balance, at the
      // amount the latest edit implies — not one row per keystroke.
      await tx.payrollCarryForward.deleteMany({
        where: {
          employeeId: item.employeeId,
          kind: 'DEDUCTION',
          originPayrollId: payrollId,
          status: 'OUTSTANDING',
        },
      });
      if (deductionShortfall > 0) {
        await tx.payrollCarryForward.create({
          data: {
            employeeId: item.employeeId,
            branchId: payroll.branchId ?? item.employee.branchId!,
            kind: 'DEDUCTION',
            amount: new Prisma.Decimal(deductionShortfall),
            status: 'OUTSTANDING',
            originPayrollId: payrollId,
            reason:
              `Deduction of ${deductionAmt} against pay that could bear ` +
              `${appliedDeduction}.`,
          },
        });
      }
      const row = await tx.payrollItem.update({
        where: { id: itemId },
        data: {
          allowances: allowancePay,
          bonus: bonusPay,
          deduction: appliedDeduction,
          overtimeHours,
          overtimePay: otPay,
          foodAllowance: foodPay,
          siteAllowance: sitePay,
          insurance: finalInsurance,
          tax: finalTax,
          netSalary: roundMoney(netSalary),
          notes: itemNotes,
        },
      });

      // ── Itemisation, rebuilt from what was just stored ──────────────────
      //
      // AFTER the update, and after the deduction solver has settled, because
      // the applied deduction is not the one that was asked for whenever the
      // pay could not bear it.
      //
      // Delete-and-rewrite per touched bucket rather than patch. `dto.allowances`
      // is a single number standing in for however many components produced the
      // old total, so apportioning it back across them would invent an
      // allocation nobody asked for. The rewritten line says it was set by hand,
      // which is the truth and is more useful than a plausible fiction.
      //
      // Untouched buckets keep their generated detail: `baseSalary`,
      // `reimbursement`, `advanceLoanDeduction` and `garnishment` are not
      // recomputed here, so their lines still describe the run that produced
      // them.
      if (features.itemLinesEnabled) {
        const existing = await tx.payrollItemLine.findMany({
          where: { payrollItemId: itemId },
          orderBy: { displayOrder: 'asc' },
        });
        const kept = existing.filter((l) =>
          UPDATE_ITEM_UNTOUCHED_BUCKETS.includes(l.bucket as LineBucket),
        );
        await this.itemLines.rebuildForItem(tx, {
          payrollItemId: itemId,
          strict: features.itemLinesStrictReconciliation,
          context: {
            payrollId,
            employeeId: item.employeeId,
            branchId: payroll.branchId ?? item.employee.branchId ?? null,
          },
          input: {
            components: kept
              .filter((l) => l.bucket === 'baseSalary')
              .map((l) => ({
                code: l.code,
                label: l.label,
                bucket: 'baseSalary' as const,
                amount: Number(l.amount),
                sourceId: l.sourceId,
              })),
            totals: {
              baseSalary: roundMoney(Number(row.baseSalary)),
              allowances: allowancePay,
              bonus: bonusPay,
              overtimePay: otPay,
              foodAllowance: foodPay,
              siteAllowance: sitePay,
              reimbursement: reimbPay,
              deduction: appliedDeduction,
              advanceLoanDeduction: loanDeduction,
              garnishment: garnishmentTaken,
              insurance: finalInsurance,
              tax: finalTax,
            },
            figures: {
              allowances:
                allowancePay > 0
                  ? [
                      {
                        code: 'ALLOWANCE_ADJUSTED',
                        label: 'Allowances (set by HR)',
                        amount: allowancePay,
                        sourceType: 'MANUAL',
                      },
                    ]
                  : [],
              bonus:
                bonusPay > 0
                  ? [
                      {
                        code: 'BONUS_ADJUSTED',
                        label: 'Bonus (set by HR)',
                        amount: bonusPay,
                        sourceType: 'MANUAL',
                      },
                    ]
                  : [],
              overtimePay:
                otPay > 0
                  ? [
                      {
                        code: 'OVERTIME',
                        label: 'Overtime',
                        amount: otPay,
                        sourceType: 'OVERTIME',
                      },
                    ]
                  : [],
              foodAllowance:
                foodPay > 0
                  ? [
                      {
                        code: 'FOOD_ALLOWANCE',
                        label: 'Food allowance (overtime)',
                        amount: foodPay,
                        sourceType: 'OVERTIME',
                      },
                    ]
                  : [],
              siteAllowance:
                sitePay > 0
                  ? [
                      {
                        code: 'SITE_ALLOWANCE',
                        label: 'Site allowance (overtime)',
                        amount: sitePay,
                        sourceType: 'OVERTIME',
                      },
                    ]
                  : [],
              reimbursement: figuresFromKept(kept, 'reimbursement', reimbPay),
              advanceLoanDeduction: figuresFromKept(
                kept,
                'advanceLoanDeduction',
                loanDeduction,
              ),
              garnishment: figuresFromKept(
                kept,
                'garnishment',
                garnishmentTaken,
              ),
              // The clamp keys on the APPLIED deduction, not on the DTO: the
              // solver can fire when `deduction` was never supplied, because
              // recomputed overtime moved the pay underneath it.
              deduction:
                appliedDeduction > 0
                  ? [
                      {
                        code:
                          deductionShortfall > 0
                            ? 'DEDUCTION_CLAMPED'
                            : 'DEDUCTION',
                        label:
                          deductionShortfall > 0
                            ? 'Deduction (limited to the pay available)'
                            : 'Deduction',
                        amount: appliedDeduction,
                        sourceType: 'MANUAL',
                      },
                    ]
                  : [],
              insurance: [
                finalPF > 0 && {
                  code: 'PF',
                  label: 'Provident fund',
                  amount: roundMoney(finalPF),
                  sourceType: 'STATUTORY' as const,
                },
                finalESI > 0 && {
                  code: 'ESI',
                  label: 'Employee state insurance',
                  amount: roundMoney(finalESI),
                  sourceType: 'STATUTORY' as const,
                },
              ].filter(Boolean) as FigureInput[],
              tax: [
                finalTax - roundMoney(finalPT) > 0 && {
                  code: 'INCOME_TAX',
                  label: 'Income tax',
                  amount: roundMoney(finalTax - roundMoney(finalPT)),
                  sourceType: 'STATUTORY' as const,
                },
                finalPT > 0 && {
                  code: 'PROFESSIONAL_TAX',
                  label: 'Professional tax',
                  amount: roundMoney(finalPT),
                  sourceType: 'STATUTORY' as const,
                },
              ].filter(Boolean) as FigureInput[],
            },
          },
        });
      }

      return row;
    });

    // Update payroll total
    const items = await this.prisma.payrollItem.findMany({
      where: { payrollId },
    });
    // Decimal accumulation — see the note in create(). Summing Number(netSalary)
    // across the run drifts before it reaches the Decimal column.
    const totalAmount = items.reduce(
      (sum, i) => sum.add(new Prisma.Decimal(i.netSalary)),
      new Prisma.Decimal(0),
    );
    await this.prisma.payroll.update({
      where: { id: payrollId },
      data: { totalAmount },
    });

    return {
      success: true,
      message: 'Payroll item updated',
      data: updated,
    };
  }

  // ── Core Calculation Engine (config-driven) ───────────────────────────────

  /**
   * Working days in the period that fall inside this employee's employment.
   *
   * Returns the branch's own figure unchanged for anyone employed for the whole
   * period, which is almost everyone — the overlap query only runs for a joiner
   * or a leaver whose date lands inside the month.
   *
   * Payroll had no concept of a start date before this. `workDaysFor()` is
   * computed per BRANCH, so a joiner and a colleague of ten years were given the
   * same working month, and the difference showed up either as an overpayment
   * (no attendance captured → treated as fully present for a month they were not
   * employed for) or as a payslip blaming them for absence on days before they
   * were hired.
   */
  /**
   * Scales each earning component by the share of the period it was effective for.
   *
   * `effectiveDate` used to behave as an on/off switch evaluated at the period
   * END: a component effective on day 20 of a 30-day month was paid IN FULL, and
   * so was a mid-month base-salary rise. Measured before this change — a 300
   * allowance effective on day 20 paid 300, not the ~110 that eleven days are
   * worth.
   *
   * Prorated by WORKING days, not calendar days, because that is what the rest of
   * payroll already means by a "day": loss of pay is `fullRate * lopDays /
   * workDays`, so a component that arrives part-way through has to be measured on
   * the same ruler or the two halves of a payslip disagree.
   *
   * A component effective on or before the period start is untouched, which is
   * almost all of them — the query only runs for one that lands inside.
   */
  private async prorateComponentsForPeriod<
    T extends { amount: any; effectiveDate?: Date | null },
  >(
    components: T[],
    month: number,
    year: number,
    branchId: string | null | undefined,
    branchWorkDays: number,
  ): Promise<T[]> {
    if (!components.length || branchWorkDays <= 0) return components;

    const periodStart = new Date(Date.UTC(year, month - 1, 1));
    const periodEnd = new Date(Date.UTC(year, month, 0));

    const out: T[] = [];
    for (const c of components) {
      const from = c.effectiveDate ? new Date(c.effectiveDate) : null;

      // Effective before the period, or undated: paid in full.
      if (!from || from <= periodStart) {
        out.push(c);
        continue;
      }
      // Effective after the period ends: the caller's date filter should already
      // have excluded it, but never pay for a period it does not cover.
      if (from > periodEnd) {
        out.push({ ...c, amount: 0 });
        continue;
      }

      const covered = await this.holidaysService.getWorkingDatesBetween(
        from,
        periodEnd,
        branchId ?? undefined,
      );
      const factor = Math.min(1, covered.length / branchWorkDays);
      out.push({ ...c, amount: Number(c.amount ?? 0) * factor });
    }
    return out;
  }

  private async workDaysWithinEmployment(
    emp: {
      startDate?: Date | string | null;
      endDate?: Date | string | null;
      branchId?: string | null;
    },
    month: number,
    year: number,
    branchWorkDays: number,
  ): Promise<number> {
    const periodStart = new Date(Date.UTC(year, month - 1, 1));
    const periodEnd = new Date(Date.UTC(year, month, 0));

    const joined = emp.startDate ? new Date(emp.startDate) : null;
    const left = emp.endDate ? new Date(emp.endDate) : null;

    const startsLate = joined != null && joined > periodStart;
    const endsEarly = left != null && left < periodEnd;

    // The common case: employed for the whole period. Nothing to compute.
    if (!startsLate && !endsEarly) return branchWorkDays;

    // Employment does not overlap the period at all.
    if ((joined && joined > periodEnd) || (left && left < periodStart))
      return 0;

    const from = startsLate ? joined : periodStart;
    const to = endsEarly ? left : periodEnd;

    const dates = await this.holidaysService.getWorkingDatesBetween(
      from,
      to,
      emp.branchId ?? undefined,
    );
    // Never MORE than the branch month: a bad date must not inflate anyone's pay.
    return Math.min(dates.length, branchWorkDays);
  }

  /**
   * Records a payroll lifecycle transition under its own name.
   *
   * The global `AuditInterceptor` derives `action` from the HTTP verb, and every
   * transition here is a POST — so submit, approve, reject, lock, unlock and
   * create-revision all landed as `CREATE` and were indistinguishable in the
   * trail. It also captures a pre-image separately from the response body, so a
   * row carried a before OR an after, never both.
   *
   * These entries carry the verb AND both sides of the status change, which is
   * what the compliance requirement actually asks for. Modelled on
   * `wps-configuration.service.ts`, which already does this.
   *
   * Failure to write an audit row must never fail the transition it describes —
   * the money has already moved by the time some of these run.
   */
  private async auditTransition(
    action: string,
    payroll: {
      id: string;
      branchId?: string | null;
      status: string;
      month: number;
      year: number;
    },
    userId: string,
    toStatus: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.log({
        userId,
        action,
        resourceType: 'Payroll',
        resourceId: payroll.id,
        branchId: payroll.branchId ?? null,
        oldData: { status: payroll.status },
        newData: {
          status: toStatus,
          month: payroll.month,
          year: payroll.year,
          ...(extra ?? {}),
        },
      });
    } catch (e) {
      this.logger.error(
        `Failed to write ${action} audit row for payroll ${payroll.id}: ${(e as Error).message}`,
      );
    }
  }

  private calculateSalaryOptimized(
    employee: EmployeeWithRelations,
    month: number,
    year: number,
    workDays: number,
    salaryComponents: SalaryComponent[],
    overtimeHours: number,
    overtimePay: number,
    cfg: PayrollConfig,
    actualWorkDays: number,
    effectiveWorkDays: number,
    foodAllowance: number = 0,
    reimbursement: number = 0,
    advanceLoanDeduction: number = 0,
    /**
     * DAILY only: extra days to pay at the day rate beyond days worked, already
     * gated on their settings and de-duplicated by the caller. An options
     * object rather than two more positionals — this signature is long enough
     * that another pair would invite a silent transposition.
     */
    dailyPaidDays: { leave: number; holiday: number } = {
      leave: 0,
      holiday: 0,
    },
    /**
     * Leave encashment that belongs INSIDE the statutory base.
     *
     * Whether encashment is taxable is a jurisdiction question, not an
     * engineering one, so `leave_encashment_taxable` decides it and the caller
     * passes the amount here only when the answer is yes. When it is no the
     * caller adds the same figure to net afterwards, exactly as it does for a
     * reimbursement — the money reaches the employee either way, and only the
     * tax and insurance bases differ.
     */
    taxableEncashment: number = 0,
    /**
     * Site allowance summed from the period's approved overtime. Treated
     * exactly like `foodAllowance` — a flat, OT-sourced earning inside gross
     * and therefore inside the statutory base — but carried separately so the
     * payslip can name which allowance it is paying.
     */
    siteAllowance: number = 0,
  ) {
    const activeContract = employee.contracts?.[0] || null;
    const salaryType = toSalaryBasis(employee.salaryType);
    const daily = isDailyWage(salaryType);

    // The contracted rate for ONE period — a month for MONTHLY staff, a single
    // day for DAILY (daily-wage) staff — split into basic + allowances. They are
    // added exactly once below; summing the components into both would
    // double-count every allowance.
    // `resolveContractedRatesDetailed` returns the same three rates as
    // `resolveContractedRates` plus the components behind them. The rates are
    // what the arithmetic below uses; the detail is carried out only so a
    // payslip can itemise, and is never summed to produce money.
    const ratesDetailed = resolveContractedRatesDetailed(
      employee.baseSalary,
      salaryComponents,
    );
    const rates: ContractedRates = {
      basicRate: ratesDetailed.basicRate,
      allowanceRate: ratesDetailed.allowanceRate,
      fullRate: ratesDetailed.fullRate,
    };

    // Attendance
    const hasAttendanceWarning = false;

    // Rewards / Disciplines
    const rewardBonus =
      employee.rewards?.reduce(
        (s: number, r: Reward) => s + Number(r.amount),
        0,
      ) || 0;
    const disciplineDeduction =
      employee.disciplines?.reduce(
        (s: number, d: Discipline) => s + Number(d.amount),
        0,
      ) || 0;

    // Earnings for the period. MONTHLY pays the full month and claws absence
    // back as LOP; DAILY pays rate × days actually present (no LOP, no rest-day
    // pay, and no cap at the month's nominal work days), plus whatever paid
    // leave / public holidays the admin opted into.
    const earned = computeEarnedSalary({
      salaryType,
      rates,
      workDays,
      presentDays: actualWorkDays,
      effectiveWorkDays,
      paidLeaveDays: dailyPaidDays.leave,
      paidHolidayDays: dailyPaidDays.holiday,
    });
    // Round every component AT DERIVATION, not on the way out.
    //
    // Proration divides by work days and work hours, so basePay/allowancePay/
    // lopDeduction routinely carry more precision than the Decimal(12,2) columns
    // hold. Rounding only some fields in the return object (baseSalary, bonus and
    // foodAllowance used to pass through raw) left Postgres to round them on
    // write, so the STORED components did not sum to the STORED net — the file
    // and the payslip disagreed with their own line items.
    //
    // Rounding here instead means gross, PF, professional tax, ESI, income tax
    // and net are all computed from exactly the values that get persisted, so the
    // payslip reconciles by construction. This is also the invariant a wage file
    // depends on: rows must sum to the header total.
    const baseSalary = roundMoney(earned.basePay);
    const allowances = roundMoney(earned.allowancePay);
    const { lopDays } = earned;
    const lopDeduction = roundMoney(earned.lopDeduction);
    const bonusPay = roundMoney(rewardBonus);
    const otPay = roundMoney(Number(overtimePay));
    const foodPay = roundMoney(Number(foodAllowance));
    const sitePay = roundMoney(Number(siteAllowance));
    const totalDeduction = roundMoney(disciplineDeduction + lopDeduction);

    const encashInGross = roundMoney(Number(taxableEncashment) || 0);
    const grossSalary =
      baseSalary +
      allowances +
      bonusPay -
      totalDeduction +
      otPay +
      foodPay +
      sitePay +
      encashInGross;

    // Daily-wage staff may be exempted from the whole statutory pipeline by an
    // admin setting (payroll_daily_wage_statutory_deductions). Monthly staff are
    // never affected.
    const applyStatutory = !daily || cfg.dailyWageStatutoryDeductions;

    // PF / Social Insurance
    let insurance = 0;
    let insuranceExempt = false;
    let insuranceExemptReason = '';

    if (!applyStatutory) {
      insuranceExempt = true;
      insuranceExemptReason = 'Daily-wage statutory deductions disabled';
    } else if (
      cfg.pfEnabled &&
      activeContract &&
      this.shouldPayInsurance(activeContract)
    ) {
      insurance = this.calculatePF(baseSalary, allowances, cfg);
    } else {
      insuranceExempt = true;
      if (!activeContract) insuranceExemptReason = 'No active contract';
      else if (activeContract.contractType === 'PROBATION')
        insuranceExemptReason = 'Probationary contract';
      else if (
        ['SEASONAL', 'SPECIFIC_TASK'].includes(activeContract.contractType)
      )
        insuranceExemptReason = `Contract ${activeContract.contractType}`;
      else if (activeContract.contractType === 'FIXED_TERM')
        insuranceExemptReason = 'Short-term contract (< 3 months)';
      else if (
        activeContract.workType === 'PART_TIME' &&
        activeContract.workHoursPerWeek < FALLBACK_MIN_PART_TIME_HOURS
      )
        insuranceExemptReason = `Part-time < ${FALLBACK_MIN_PART_TIME_HOURS}h/week`;
    }

    // Professional Tax (India)
    const professionalTax =
      applyStatutory && cfg.professionalTaxEnabled
        ? this.calculateProfessionalTax(grossSalary, cfg)
        : 0;

    // ESI (India Employee State Insurance) — employee contribution on gross,
    // only when gross is at/below the wage ceiling. Computed BEFORE income tax
    // but deliberately NOT subtracted from the taxable base (ESI is not a
    // Chapter VI-A deduction under the new regime).
    const esi = applyStatutory ? this.calculateESI(grossSalary, cfg) : 0;

    // Income Tax (TDS / PIT) — taxable base excludes ESI (only PF & PT reduce it).
    const tax = applyStatutory
      ? this.calculateIncomeTax(grossSalary, insurance, professionalTax, cfg)
      : 0;

    // Reimbursements are expense repayments, not income: excluded from gross
    // and every statutory base (PF/PT/TDS), added to net after deductions.
    // Advance/loan recovery is a post-tax deduction (symmetric to reimbursement):
    // it never affects gross or any statutory base, only the final net.
    // Floor net pay at 0: when deductions/recoveries exceed earnings (e.g. an
    // employee absent all month whose salary is fully wiped by LOP), net pay
    // cannot go negative — you don't collect money back through a payslip.
    // ESI has no dedicated column: fold it into the stored insurance total
    // (both are statutory employee insurance) so net stays correct everywhere;
    // the split is surfaced in the payslip note.
    const totalInsurance = roundMoney(insurance + esi);
    const totalTax = roundMoney(tax + professionalTax);
    const reimbPay = roundMoney(Number(reimbursement));
    const loanDeduction = roundMoney(Number(advanceLoanDeduction));

    // Derived from the SAME rounded values that get persisted, and from the two
    // combined columns (insurance, tax) rather than their four uncombined parts,
    // so `gross - insurance - tax + reimbursement - loan == net` holds exactly on
    // the stored row.
    const netSalary = Math.max(
      0,
      grossSalary - totalInsurance - totalTax + reimbPay - loanDeduction,
    );

    return {
      baseSalary,
      workDays,
      // For daily-wage staff this is the DAYS PAID, not merely days attended, so
      // that periodRate × actualWorkDays still reconciles with baseSalary on the
      // payslip and in the Excel export once paid leave/holidays are included.
      // Monthly staff are unaffected — their payableDays is effectiveWorkDays.
      actualWorkDays: daily ? earned.payableDays : actualWorkDays,
      effectiveWorkDays,
      hasAttendanceWarning,
      allowances,
      bonus: bonusPay,
      deduction: totalDeduction,
      overtimeHours,
      overtimePay: otPay,
      foodAllowance: foodPay,
      siteAllowance: sitePay,
      reimbursement: reimbPay,
      advanceLoanDeduction: loanDeduction,
      insurance: totalInsurance,
      esi: roundMoney(esi),
      insuranceExempt,
      insuranceExemptReason,
      tax: totalTax,
      // ── Itemisation detail ────────────────────────────────────────────────
      // The parts behind the two combined columns, carried out unrounded-into
      // -each-other so a payslip line can name them. `insurance` is PF + ESI and
      // `tax` is income tax + professional tax; the columns cannot say which is
      // which, and until now the split survived only inside the free-text note.
      // None of these is persisted as a column — they exist to build lines.
      /** Encashment already inside `grossSalary`; the caller must not add it twice. */
      taxableEncashment: encashInGross,
      pf: roundMoney(insurance),
      incomeTax: roundMoney(tax),
      professionalTax: roundMoney(professionalTax),
      disciplineDeduction: roundMoney(disciplineDeduction),
      /**
       * The contracted components behind `baseSalary` and `allowances`, scaled
       * by the same proration the engine applied, so they sum back to the two
       * columns to within rounding.
       */
      earningComponents: ratesDetailed.components.map((c) => ({
        code: c.code,
        bucket: c.bucket === 'basicRate' ? 'baseSalary' : 'allowances',
        // `fullRate` is the denominator because both basePay and allowancePay
        // are shares of it; a zero rate means there is nothing to apportion.
        amount:
          rates.fullRate > 0
            ? (c.bucket === 'basicRate'
                ? earned.basePay
                : earned.allowancePay) *
              (c.amount /
                (c.bucket === 'basicRate'
                  ? rates.basicRate || 1
                  : rates.allowanceRate || 1))
            : 0,
      })),
      netSalary: roundMoney(netSalary),
      lopDays,
      lopDeduction,
      salaryType,
      /** Days actually paid — the billed day count for daily-wage staff. */
      payableDays: earned.payableDays,
      /** Of payableDays, how many were approved paid leave (DAILY only). */
      paidLeaveDays: dailyPaidDays.leave,
      /** Of payableDays, how many were public holidays (DAILY only). */
      paidHolidayDays: dailyPaidDays.holiday,
      /** The contracted rate for one period (one day when salaryType = DAILY). */
      periodRate: roundMoney(rates.fullRate),
      statutoryApplied: applyStatutory,
    };
  }

  /**
   * ESI employee contribution (India): a percentage of gross salary, payable
   * only when monthly gross is at or below the wage ceiling (esiSalaryCap).
   * Above the ceiling the employee is out of ESI coverage → 0.
   */
  private calculateESI(grossSalary: number, cfg: PayrollConfig): number {
    if (!cfg.esiEnabled || cfg.esiEmployeeRate <= 0) return 0;
    if (cfg.esiSalaryCap > 0 && grossSalary > cfg.esiSalaryCap) return 0;
    return grossSalary * cfg.esiEmployeeRate;
  }

  /** Provident Fund employee deduction (India: 12% of basic up to ₹15,000 cap) */
  private calculatePF(
    baseSalary: number,
    allowances: number,
    cfg: PayrollConfig,
  ): number {
    if (!cfg.pfEnabled) return 0;
    // In India PF is on Basic only; cap at pfSalaryCap unless pfOnFullSalary
    const pfBase = cfg.pfOnFullSalary
      ? baseSalary
      : Math.min(
          baseSalary,
          cfg.pfSalaryCap > 0 ? cfg.pfSalaryCap : baseSalary,
        );
    return pfBase * cfg.pfEmployeeRate;
  }

  /** Professional Tax — monthly slab lookup */
  private calculateProfessionalTax(
    monthlyGross: number,
    cfg: PayrollConfig,
  ): number {
    if (!cfg.professionalTaxEnabled || !cfg.professionalTaxSlabs?.length)
      return 0;
    for (const slab of cfg.professionalTaxSlabs) {
      if (monthlyGross <= slab.upTo) return slab.tax;
    }
    return (
      cfg.professionalTaxSlabs[cfg.professionalTaxSlabs.length - 1]?.tax ?? 0
    );
  }

  /** Income Tax — supports Indian annual projection & Indian monthly progressive */
  private calculateIncomeTax(
    grossSalary: number,
    pf: number,
    professionalTax: number,
    cfg: PayrollConfig,
  ): number {
    const brackets = cfg.taxBrackets;
    if (!brackets?.length) return 0;

    if (cfg.taxCalculationPeriod === 'annual') {
      // India: project monthly gross to annual, subtract deductions, apply slab, divide by 12
      const annualGross = grossSalary * 12;
      const annualPF = pf * 12;
      const annualPT = professionalTax * 12;
      const taxableAnnual = Math.max(
        0,
        annualGross - annualPF - annualPT - cfg.standardDeduction,
      );

      let annualTax = this.applyBrackets(taxableAnnual, brackets);

      // Section 87A Rebate: If annual taxable income ≤ threshold (India: ₹7,00,000), tax = 0
      if (cfg.taxRebateEnabled && taxableAnnual <= cfg.taxRebateLimit) {
        annualTax = 0;
      }

      // Health & Education Cess (India: 4% on income tax)
      if (cfg.cessEnabled && annualTax > 0) {
        annualTax = annualTax * (1 + cfg.cessRate);
      }

      return annualTax / 12;
    } else {
      // Monthly progressive (e.g. Vietnam): apply slabs directly to monthly taxable income
      const taxableMonthly = Math.max(
        0,
        grossSalary - pf - professionalTax - cfg.personalDeductionMonthly,
      );
      return this.applyBrackets(taxableMonthly, brackets);
    }
  }

  private applyBrackets(
    income: number,
    brackets: { limit: number; rate: number }[],
  ): number {
    let tax = 0;
    let remaining = income;
    let prev = 0;
    for (const b of brackets) {
      const slice = Math.min(remaining, b.limit - prev);
      if (slice <= 0) break;
      tax += slice * b.rate;
      remaining -= slice;
      prev = b.limit;
    }
    return tax;
  }

  /**
   * Back-compat alias for {@link lockPayroll}.
   *
   * This used to be a second, weaker lock: it moved a payroll to LOCKED from ANY
   * status, wrote only `finalizedAt`/`finalizedBy`, and skipped every side effect
   * lockPayroll performs. Because the web UI called only this one, in practice
   * LOCKED meant "someone clicked the padlock on a DRAFT run" — nothing had been
   * approved, reimbursements were never flipped to PAID (so they were paid again
   * the following month), and advance/loan installments stayed PENDING with
   * `amountRepaid` never advancing, so a loan was never actually recovered.
   *
   * It now delegates, so there is exactly one way to lock a payroll and LOCKED
   * carries a single meaning. Callers must approve the run first.
   */
  async finalize(id: string, userId: string) {
    // Same guard and the same side effects as `lock` — but stamped FINALIZE, so
    // the `finalizedAt`/`finalizedBy` columns the pre-lock integrations read are
    // still written. Routing through `lockPayroll` left `applyLock`'s FINALIZE
    // branch unreachable, so those callers silently saw null after the rename.
    return this.applyLock(id, userId, {
      allowedFrom: [PayrollStatus.APPROVED],
      stamp: 'FINALIZE',
    });
  }

  /**
   * A single employee's payslip for a period, addressed by path.
   *
   * `onlyFinalized` narrows the search to the statuses an employee is allowed to
   * see, exactly as `getEmployeePayslips` does. It is set for MANAGER and
   * EMPLOYEE callers: this door takes the employee from the URL rather than the
   * token, so without it a manager could read a subordinate's DRAFT or REJECTED
   * payslip — figures HR is still working on, and which `my-payslips/*` has
   * always refused to show. ADMIN and HR_MANAGER keep full access; the run is
   * theirs to work on.
   */
  async getPayslip(
    employeeId: string,
    month: number,
    year: number,
    opts: { onlyFinalized?: boolean } = {},
  ) {
    // Resolve the item VIA the employee so a month with several payrolls
    // (revisions, other batches/branches) can never pick a payroll that lacks
    // this employee. Prefer the most recent payroll for the period.
    const item = await this.prisma.payrollItem.findFirst({
      where: {
        employeeId,
        payroll: {
          month,
          year,
          ...(opts.onlyFinalized
            ? { status: EMPLOYEE_VISIBLE_PAYROLL_STATUSES }
            : {}),
        },
      },
      orderBy: { payroll: { createdAt: 'desc' } },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            position: true,
            department: { select: { name: true } },
          },
        },
        payroll: { select: { status: true } },
      },
    });

    if (!item) {
      throw new NotFoundException('Payslip not found');
    }

    const { payroll, ...itemRest } = item as any;
    return {
      success: true,
      data: {
        payroll: { month, year, status: payroll.status },
        ...itemRest,
      },
    };
  }

  private async calculateOvertimePayAndAllowance(
    employeeId: string,
    month: number,
    year: number,
    hourlyRate: number,
  ): Promise<{
    overtimePay: number;
    overtimeHours: number;
    foodAllowance: number;
    siteAllowance: number;
  }> {
    const approvedRequests = await this.prisma.overtimeRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        date: {
          gte: new Date(Date.UTC(year, month - 1, 1)),
          lte: new Date(Date.UTC(year, month, 0)),
        },
      },
    });

    const otCfgCache = new Map<string, ResolvedOvertimeConfig>();
    let overtimePay = 0;
    let overtimeHours = 0;
    let foodAllowance = 0;
    let siteAllowance = 0;

    for (const req of approvedRequests) {
      const otCfg = await this.otConfigForRow(req, otCfgCache);
      const tier = this.overtimeRowTier(req, hourlyRate, otCfg);
      overtimePay += tier.pay;
      overtimeHours += tier.hours;
      foodAllowance += Number(req.foodAllowance || 0);
      siteAllowance += Number(req.siteAllowance || 0);
    }

    return { overtimePay, overtimeHours, foodAllowance, siteAllowance };
  }

  /**
   * Per-request overtime pay, splitting hours across tiers.
   *
   * Prefers the persisted per-tier buckets (regularHours/lateHours/doubleHours)
   * so each portion of the shift is paid at its own rate. Falls back to the
   * legacy single-tier-by-otType calc for rows created before the split columns
   * existed (all buckets 0 but hours > 0).
   */
  private overtimeRowTier(
    ot: {
      hours: any;
      regularHours?: any;
      lateHours?: any;
      doubleHours?: any;
      doubleLateHours?: any;
      dayType?: string | null;
      otType: string;
    },
    hourlyRate: number,
    otCfg: {
      regularRate: number;
      lateRate: number;
      doubleRate: number;
      sunday?: { regularRate: number; lateRate: number };
      holiday?: { regularRate: number; lateRate: number };
    },
  ): { hours: number; pay: number } {
    let reg = Number(ot.regularHours || 0);
    let late = Number(ot.lateHours || 0);
    let dbl = Number(ot.doubleHours || 0);
    let dblLate = Number(ot.doubleLateHours || 0);

    if (reg + late + dbl + dblLate === 0) {
      // Legacy row: reconstruct a single bucket from otType.
      const h = Number(ot.hours || 0);
      if (ot.otType === 'DOUBLE_LATE') dblLate = h;
      else if (ot.otType === 'DOUBLE') dbl = h;
      else if (ot.otType === 'LATE') late = h;
      else reg = h;
    }

    // Pick the double-tier multipliers by day type (Sunday vs Holiday). Rows with
    // no day type (legacy, or WEEKDAY) fall back to the flat legacy doubleRate so
    // pre-migration approved rows are paid exactly as before.
    const dblRates =
      ot.dayType === 'HOLIDAY'
        ? otCfg.holiday
        : ot.dayType === 'SUNDAY'
          ? otCfg.sunday
          : undefined;
    const dblRegRate = dblRates ? dblRates.regularRate : otCfg.doubleRate;
    const dblLateRate = dblRates ? dblRates.lateRate : otCfg.doubleRate;

    // Use the full-precision hourly rate (baseSalary / (workDays * hoursPerDay))
    // when applying tier multipliers, and let the caller round only the final
    // overtime total. Rounding the rate to 2dp first would silently drop the
    // sub-cent portion of every hour (e.g. 48.0846 → 48.08), understating pay.
    // The rate shown on payslips / OT detail is a rounded display figure only.
    const hours = reg + late + dbl + dblLate;
    const pay =
      (reg * otCfg.regularRate +
        late * otCfg.lateRate +
        dbl * dblRegRate +
        dblLate * dblLateRate) *
      hourlyRate;
    return { hours, pay };
  }

  /** Legacy calculateTax kept for backward-compat with updateItem pre-config path */
  private calculateTax(taxableIncome: number): number {
    if (taxableIncome <= 0) return 0;
    // Default to Indian New Regime annual slabs projected monthly
    const brackets = [
      { limit: 300000, rate: 0.0 },
      { limit: 700000, rate: 0.05 },
      { limit: 1000000, rate: 0.1 },
      { limit: 1200000, rate: 0.15 },
      { limit: 1500000, rate: 0.2 },
      { limit: 999999999, rate: 0.3 },
    ];
    return this.applyBrackets(taxableIncome, brackets);
  }

  private shouldPayInsurance(contract: Contract): boolean {
    if (!contract) return false;
    if (contract.contractType === 'PROBATION') return false;
    if (['SEASONAL', 'SPECIFIC_TASK'].includes(contract.contractType))
      return false;
    if (contract.contractType === 'FIXED_TERM') {
      const start = new Date(contract.startDate);
      const end = contract.endDate ? new Date(contract.endDate) : null;
      if (end) {
        const months =
          (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30);
        if (months < 3) return false;
      }
    }
    const minHours = FALLBACK_MIN_PART_TIME_HOURS;
    if (
      contract.workType === 'PART_TIME' &&
      contract.workHoursPerWeek < minHours
    )
      return false;
    return true;
  }

  // Employee Payslip Methods
  async getEmployeePayslips(employeeId: string) {
    // A user with no linked employee record — the usual shape for a system
    // ADMIN — has no payslips rather than a broken query. Without this the
    // undefined id reached Prisma and the caller's own self-service page
    // answered 500.
    if (!employeeId) return { success: true, data: [] };

    const items = await this.prisma.payrollItem.findMany({
      // Only finalized payrolls are visible to employees. DRAFT /
      // PENDING_APPROVAL / REJECTED runs are still being worked on by HR and
      // must never leak to the employee's payslip list.
      where: {
        employeeId,
        payroll: { status: EMPLOYEE_VISIBLE_PAYROLL_STATUSES },
      },
      include: {
        payroll: {
          select: {
            id: true,
            month: true,
            year: true,
            status: true,
            createdAt: true,
          },
        },
        // The payslip list labels the basic-pay figure per pay basis.
        employee: { select: { salaryType: true } },
      },
      orderBy: [{ payroll: { year: 'desc' } }, { payroll: { month: 'desc' } }],
      take: 12, // Last 12 months
    });

    return {
      success: true,
      data: items.map((item) => ({
        ...item,
        month: item.payroll.month,
        year: item.payroll.year,
        status: item.payroll.status,
        payrollId: item.payroll.id,
      })),
    };
  }

  async getEmployeePayslipDetail(employeeId: string, itemId: string) {
    // A user with no linked employee record — the usual shape for a system
    // ADMIN — has no payslips rather than a broken query. Without this the
    // undefined id reached Prisma and the caller's own self-service page
    // answered 500.
    if (!employeeId) throw new NotFoundException('Payslip not found');

    const item = await this.prisma.payrollItem.findFirst({
      // Same finalized-only gate as the list: block direct-URL access to a
      // DRAFT/unpublished payslip.
      where: {
        id: itemId,
        employeeId,
        payroll: { status: EMPLOYEE_VISIBLE_PAYROLL_STATUSES },
      },
      include: {
        payroll: true,
        employee: {
          select: {
            id: true,
            fullName: true,
            employeeCode: true,
            position: true,
            salaryType: true,
            department: { select: { name: true } },
          },
        },
      },
    });

    if (!item) {
      throw new NotFoundException('Payslip not found');
    }

    // The breakdown is attached only when itemisation is on, so with the switch
    // off the response body is byte-identical to what it was before this
    // feature existed — no `lines: []` appearing on every payslip in the system
    // and no client having to learn a field that is always empty.
    const features = await this.features.resolve();
    if (!features.itemLinesEnabled) return { success: true, data: item };

    const lines = await this.prisma.payrollItemLine.findMany({
      where: { payrollItemId: item.id },
      orderBy: { displayOrder: 'asc' },
    });
    return { success: true, data: { ...item, lines } };
  }

  async getYTDSummary(employeeId: string, year: number) {
    // A user with no linked employee record — the usual shape for a system
    // ADMIN — has no payslips rather than a broken query. Without this the
    // undefined id reached Prisma and the caller's own self-service page
    // answered 500.
    if (!employeeId) {
      return {
        success: true,
        data: {
          year,
          employeeId: null,
          totalGrossIncome: 0,
          totalNetIncome: 0,
          totalTaxPaid: 0,
          totalInsurancePaid: 0,
          totalOvertimePay: 0,
          totalBonuses: 0,
          totalDeductions: 0,
          monthlyBreakdown: [] as any[],
          monthsCount: 0,
        },
      };
    }

    const items = await this.prisma.payrollItem.findMany({
      where: {
        employeeId,
        // LOCKED only, the same rule every payroll report applies. Without it a
        // DRAFT run — a figure HR is still working on — reached an employee's
        // year-to-date income and tax as though it had been paid, and the
        // number moved again when the run was edited. `getPayslip` already
        // refuses to show a non-finalised payslip to the employee it belongs
        // to; this summed them.
        payroll: { year, status: 'LOCKED' },
      },
      include: {
        payroll: { select: { month: true } },
      },
      orderBy: {
        payroll: { month: 'asc' },
      },
    });

    const summary = {
      year,
      employeeId,
      totalGrossIncome: 0,
      totalNetIncome: 0,
      totalTaxPaid: 0,
      totalInsurancePaid: 0,
      totalOvertimePay: 0,
      totalBonuses: 0,
      totalDeductions: 0,
      monthlyBreakdown: [] as any[],
      monthsCount: items.length,
    };

    items.forEach((item) => {
      const grossIncome =
        Number(item.baseSalary) +
        Number(item.allowances) +
        Number(item.bonus) +
        Number(item.overtimePay);
      const insurancePaid = Number(item.insurance);
      const taxPaid = Number(item.tax);

      summary.totalGrossIncome += grossIncome;
      summary.totalNetIncome += Number(item.netSalary);
      summary.totalTaxPaid += taxPaid;
      summary.totalInsurancePaid += insurancePaid;
      summary.totalOvertimePay += Number(item.overtimePay);
      summary.totalBonuses += Number(item.bonus);
      summary.totalDeductions += Number(item.deduction);

      summary.monthlyBreakdown.push({
        month: item.payroll.month,
        grossIncome: round2(grossIncome),
        netIncome: round2(Number(item.netSalary)),
        taxPaid: round2(taxPaid),
        insurancePaid: round2(insurancePaid),
      });
    });

    // Two decimals, not whole units. `Math.round` here turned 1,234.56 into
    // 1,235 on a screen an employee reconciles against their bank statement,
    // and twelve of those roundings drifted the year-to-date total away from
    // the sum of the payslips it claims to add up.
    summary.totalGrossIncome = round2(summary.totalGrossIncome);
    summary.totalNetIncome = round2(summary.totalNetIncome);
    summary.totalTaxPaid = round2(summary.totalTaxPaid);
    summary.totalInsurancePaid = round2(summary.totalInsurancePaid);
    summary.totalOvertimePay = round2(summary.totalOvertimePay);
    summary.totalBonuses = round2(summary.totalBonuses);
    summary.totalDeductions = round2(summary.totalDeductions);

    return { success: true, data: summary };
  }

  // =====================================================
  // PAYROLL WORKFLOW METHODS
  // =====================================================

  async submitForApproval(payrollId: string, userId: string) {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
      include: { items: true },
    });

    if (!payroll) {
      throw new NotFoundException('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(payroll.branchId);

    // DRAFT or REJECTED. Rejection exists to send work BACK: item edits are
    // allowed on a REJECTED run (only LOCKED refuses them) and the manage screen
    // offers Submit for exactly that status. Admitting DRAFT alone made REJECTED
    // a dead end whose only escape was deleting the run and generating it again,
    // which throws away every manual adjustment made since.
    if (payroll.status !== 'DRAFT' && payroll.status !== 'REJECTED') {
      throw new BadRequestException(
        'Can only submit a payroll for approval from DRAFT or REJECTED status',
      );
    }

    if (!payroll.items || payroll.items.length === 0) {
      throw new BadRequestException('Payroll has no employees');
    }

    const updated = await this.prisma.payroll.update({
      where: { id: payrollId },
      data: {
        status: 'PENDING_APPROVAL',
        submittedAt: new Date(),
        submittedBy: userId,
      },
    });

    await this.auditTransition(
      'PAYROLL_SUBMITTED',
      payroll,
      userId,
      'PENDING_APPROVAL',
    );

    // Notify every ADMIN that a run is waiting. This replaces a TODO that has
    // been dead for the life of the module, so payroll had no notification of
    // any kind — in-app included.
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: { id: true },
    });

    await this.dispatcher.dispatch({
      event: 'payroll_status',
      userIds: admins.map((a) => a.id),
      title: 'Payroll submitted for approval',
      message: `A payroll run for ${payroll.month}/${payroll.year} is awaiting your approval.`,
      link: `/dashboard/payroll/${payrollId}`,
      data: {
        period: `${payroll.month}/${payroll.year}`,
        status: 'PENDING_APPROVAL',
        employeeCount: payroll.items.length,
      },
      dedupeKey: `payroll:${payrollId}:submitted`,
    });

    return {
      success: true,
      message: 'Payroll submitted for approval',
      data: updated,
    };
  }

  async approvePayroll(
    payrollId: string,
    userId: string,
    dto: { notes?: string },
  ) {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
      include: { items: true },
    });

    if (!payroll) {
      throw new NotFoundException('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(payroll.branchId);

    if (payroll.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        'Can only approve payroll in PENDING_APPROVAL status',
      );
    }

    // Atomic transition. The status check above is a READ, and a read-then-write
    // is not a guard: two simultaneous approvals both passed it and both answered
    // `201 "Payroll approved"`, so two people each held a success receipt for an
    // approval only one of them is recorded as performing. Measured 8 times out
    // of 8 in isolation; under load the reads serialised and one lost, which made
    // the behaviour timing-dependent rather than absent.
    //
    // `updateMany` with the expected status in the WHERE clause makes the
    // transition conditional in the database, the way `lockPayroll` already does
    // it. A caller that loses now learns it lost.
    const claimed = await this.prisma.payroll.updateMany({
      where: { id: payrollId, status: 'PENDING_APPROVAL' },
      data: {
        status: 'APPROVED',
        approvedBy: userId,
        approvedAt: new Date(),
        notes: dto.notes || payroll.notes,
      },
    });

    if (claimed.count === 0) {
      throw new ConflictException(
        'Payroll is no longer awaiting approval (approved or changed concurrently)',
      );
    }

    await this.auditTransition('PAYROLL_APPROVED', payroll, userId, 'APPROVED');

    const updated = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
    });

    if (payroll.submittedBy) {
      await this.dispatcher.dispatch({
        event: 'payroll_status',
        userIds: [payroll.submittedBy],
        title: 'Payroll approved',
        message: `The payroll run for ${payroll.month}/${payroll.year} was approved.`,
        type: 'SUCCESS',
        link: `/dashboard/payroll/${payrollId}`,
        data: {
          period: `${payroll.month}/${payroll.year}`,
          status: 'APPROVED',
        },
        dedupeKey: `payroll:${payrollId}:approved`,
      });
    }

    return {
      success: true,
      message: 'Payroll approved',
      data: updated,
    };
  }

  async rejectPayroll(
    payrollId: string,
    userId: string,
    dto: { reason: string },
  ) {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
    });

    if (!payroll) {
      throw new NotFoundException('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(payroll.branchId);

    if (payroll.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        'Can only reject payroll in PENDING_APPROVAL status',
      );
    }

    const updated = await this.prisma.payroll.update({
      where: { id: payrollId },
      data: {
        status: 'REJECTED',
        rejectedBy: userId,
        rejectedAt: new Date(),
        rejectionReason: dto.reason,
      },
    });

    await this.auditTransition(
      'PAYROLL_REJECTED',
      payroll,
      userId,
      'REJECTED',
      {
        rejectionReason: dto.reason,
      },
    );

    if (payroll.submittedBy) {
      await this.dispatcher.dispatch({
        event: 'payroll_status',
        userIds: [payroll.submittedBy],
        title: 'Payroll rejected',
        message: `The payroll run for ${payroll.month}/${payroll.year} was rejected: ${dto.reason}`,
        type: 'ERROR',
        link: `/dashboard/payroll/${payrollId}`,
        data: {
          period: `${payroll.month}/${payroll.year}`,
          status: 'REJECTED',
          reason: dto.reason,
        },
        dedupeKey: `payroll:${payrollId}:rejected`,
      });
    }

    return {
      success: true,
      message: 'Payroll rejected',
      data: updated,
    };
  }

  /**
   * THE single money-finalizing path for a payroll run.
   *
   * Both `finalize()` and `lockPayroll()` delegate here. They used to diverge:
   * `finalize()` set status=LOCKED directly and did NOT flip the advance/loan
   * ledger or move `amountRepaid`, while only `lockPayroll()` did that work.
   * Since the UI and the `payroll_finalize` MCP tool both call `finalize`, the
   * primary path reduced net salary by the EMI but never advanced the loan
   * balance — and the ledger row, left PENDING forever, then permanently
   * excluded that loan from every future run via the `deductions: { none:
   * { status: 'PENDING' } }` guard in create(). Never reintroduce a second
   * path that writes LOCKED.
   *
   * Everything that moves money runs in ONE interactive transaction, including
   * the fully-recovered sweep: auto-closure is a consequence of the balance
   * moving and must be atomic with it, otherwise a crash in between leaves a
   * repaid loan APPROVED with amountRepaid == amount and the next run plans a
   * zero-due installment against it.
   */
  private async applyLock(
    payrollId: string,
    userId: string,
    opts: { allowedFrom: PayrollStatus[]; stamp: 'FINALIZE' | 'LOCK' },
  ) {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
    });

    if (!payroll) {
      throw new NotFoundException('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(payroll.branchId);

    if (payroll.status === PayrollStatus.LOCKED) {
      throw new BadRequestException('Payroll already locked');
    }
    if (!opts.allowedFrom.includes(payroll.status)) {
      throw new BadRequestException(
        `Cannot lock a payroll in ${payroll.status} status (expected one of ${opts.allowedFrom.join(', ')})`,
      );
    }

    // Capture which travel/training requests this run pays out, BEFORE the
    // reimbursements flip to PAID and stop matching `status: 'APPROVED'`.
    const sourcedClaims = await this.prisma.reimbursement.findMany({
      where: {
        status: 'APPROVED',
        payrollItem: { payrollId },
        sourceType: { not: null },
        sourceId: { not: null },
      },
      select: { sourceType: true, sourceId: true },
    });

    const now = new Date();
    // Resolved before the transaction opens: a switch that is off must cost
    // the lock no statements at all.
    const lockFeatures = await this.features.resolve();

    const { updated, completed } = await this.prisma.$transaction(
      async (tx) => {
        // Serialize concurrent lock/finalize attempts on the same run. Two
        // admins clicking Finalize at once must not both flip the ledger.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${payrollId}, 0))`;

        // Compare-and-set: the status check above was outside the lock, so it
        // is advisory only. This is the authoritative guard.
        const cas = await tx.payroll.updateMany({
          where: { id: payrollId, status: { in: opts.allowedFrom } },
          data: {
            status: PayrollStatus.LOCKED,
            lockedAt: now,
            lockedBy: userId,
            ...(opts.stamp === 'FINALIZE'
              ? { finalizedAt: now, finalizedBy: userId }
              : {}),
          },
        });
        if (cas.count === 0) {
          // 409, not 400: this is the losing side of a race, not a malformed
          // request — the payload was valid and would have worked a moment
          // earlier. Every other concurrency guard in this codebase (casVersion,
          // the idempotency-key guard, assertNoRunInFlight, and the loan-side
          // guards) answers 409, and a client that retries on 409 was being told
          // it had typed something invalid instead.
          throw new ConflictException(
            'Payroll is no longer in a lockable state (locked or changed concurrently)',
          );
        }

        await tx.reimbursement.updateMany({
          where: { status: 'APPROVED', payrollItem: { payrollId } },
          data: { status: 'PAID', paidAt: now },
        });

        // Advance/loan installments recovered in this payroll: sum the PENDING
        // ledger rows per request so each request's repaid balance moves
        // atomically with the lock. Revision copies carry no ledger rows, so
        // locking a revision moves nothing twice.
        const ledgerRows = await tx.advanceLoanDeduction.findMany({
          where: { status: 'PENDING', payrollItem: { payrollId } },
          select: {
            id: true,
            requestId: true,
            scheduleId: true,
            amount: true,
            principalComponent: true,
            interestComponent: true,
            feeComponent: true,
          },
        });
        // amountRepaid means PRINCIPAL repaid, not cash. With interest, cash
        // exceeds principal, and a cash-based counter would auto-complete a
        // loan early — so interest and fees get their own counters.
        const paidByRequest = new Map<
          string,
          { cash: number; principal: number; interest: number; fee: number }
        >();
        // A missing/NaN component must never reach an `increment` — Prisma
        // would write NaN and the balance would be destroyed. Coerce
        // explicitly, and when a row carries NO split at all treat it as pure
        // principal, which is exactly the pre-v2 shape.
        const money = (v: unknown): number => {
          const n = Number(v);
          return Number.isFinite(n) ? n : NaN;
        };
        for (const row of ledgerRows) {
          const acc = paidByRequest.get(row.requestId) ?? {
            cash: 0,
            principal: 0,
            interest: 0,
            fee: 0,
          };
          const cash = money(row.amount) || 0;
          let principal = money(row.principalComponent);
          let interest = money(row.interestComponent);
          let fee = money(row.feeComponent);
          const noSplit =
            !Number.isFinite(principal) &&
            !Number.isFinite(interest) &&
            !Number.isFinite(fee);
          if (noSplit) {
            principal = cash;
            interest = 0;
            fee = 0;
          } else {
            principal = Number.isFinite(principal) ? principal : 0;
            interest = Number.isFinite(interest) ? interest : 0;
            fee = Number.isFinite(fee) ? fee : 0;
          }
          acc.cash += cash;
          acc.principal += principal;
          acc.interest += interest;
          acc.fee += fee;
          paidByRequest.set(row.requestId, acc);
        }

        const completedReqs: Array<{
          id: string;
          employeeId: string;
          type: string;
          amount: number;
        }> = [];

        if (paidByRequest.size > 0) {
          // Row-lock the affected requests in a stable id order so two runs
          // touching overlapping employees queue instead of deadlocking.
          const ids = [...paidByRequest.keys()].sort();
          await tx.$executeRaw`SELECT id FROM advance_loan_requests WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;

          await tx.advanceLoanDeduction.updateMany({
            where: { status: 'PENDING', payrollItem: { payrollId } },
            data: { status: 'PAID' },
          });

          // The balances as they stand, read under the lock taken above. Needed
          // because the new `outstandingPrincipal` is written as an absolute
          // value — the only way to floor it at zero, since Prisma cannot clamp
          // a `decrement`.
          const balancesBefore = new Map<string, number>(
            (
              await tx.advanceLoanRequest.findMany({
                where: { id: { in: ids } },
                select: { id: true, outstandingPrincipal: true },
              })
            ).map((r) => [r.id, Number(r.outstandingPrincipal ?? 0)]),
          );

          for (const [requestId, sum] of paidByRequest) {
            const outstandingBefore = balancesBefore.get(requestId) ?? 0;

            await tx.advanceLoanRequest.update({
              where: { id: requestId },
              data: {
                // Principal ONLY — see the comment on paidByRequest.
                //
                // Do NOT fall back to the cash total when principal is 0: a
                // cycle whose whole instalment went to interest would then
                // credit principal with the interest as well, repaying the loan
                // twice as fast as the employee actually paid it. The
                // advance_loan_deductions_split_chk constraint guarantees the
                // three components reconcile to `amount`, and the v2 migration
                // backfilled legacy rows to principal = amount, so there is
                // nothing left for a fallback to rescue.
                amountRepaid: { increment: sum.principal },
                interestPaid: { increment: sum.interest },
                feesPaid: { increment: sum.fee },
                // The denormalised balance has to move with the ledger it
                // caches. It was previously left untouched here, so a loan that
                // payroll had recovered from still advertised its ORIGINAL
                // principal as outstanding — on the loan detail screen and in
                // `statement`, both of which read the column rather than
                // deriving. `LoanLifecycleService` derives and so was unaffected,
                // which is exactly why this went unnoticed: the money was right
                // everywhere it was recomputed and wrong everywhere it was read.
                //
                // Clamped at zero rather than allowed to go negative: the final
                // instalment can overshoot by a rounding unit, and a negative
                // balance would read as the company owing the employee.
                outstandingPrincipal: Math.max(
                  0,
                  outstandingBefore - sum.principal,
                ),
                version: { increment: 1 },
              },
            });
          }

          // Project the PLAN from the ledger. This is the ONLY place schedule
          // rows learn that money moved: payroll generation never writes here,
          // which is what makes deleting a draft payroll a no-op for the plan.
          for (const row of ledgerRows) {
            if (!row.scheduleId) continue;
            const sched = await tx.loanSchedule.findUnique({
              where: { id: row.scheduleId },
              select: {
                emiAmount: true,
                paidAmount: true,
                paidPrincipal: true,
                paidInterest: true,
              },
            });
            if (!sched) continue;
            const paidAmount = Number(sched.paidAmount) + Number(row.amount);
            const settled = paidAmount >= Number(sched.emiAmount) - 0.005;
            await tx.loanSchedule.update({
              where: { id: row.scheduleId },
              data: {
                paidAmount,
                paidPrincipal:
                  Number(sched.paidPrincipal) + Number(row.principalComponent),
                paidInterest:
                  Number(sched.paidInterest) + Number(row.interestComponent),
                carryForwardAmount: Math.max(
                  0,
                  Number(sched.emiAmount) - paidAmount,
                ),
                status: settled ? 'PAID' : 'PARTIAL',
                settledAt: settled ? now : null,
              },
            });
          }

          // Mirror each recovery into the money ledger so the employee
          // statement and the accounting journal read one continuous stream.
          if (ledgerRows.length > 0) {
            await tx.loanTransaction.createMany({
              data: ledgerRows
                .filter((r) => Number(r.amount) > 0)
                .map((r) => ({
                  requestId: r.requestId,
                  type: 'EMI_RECOVERY' as const,
                  transactionDate: now,
                  amount: r.amount,
                  principalComponent: r.principalComponent,
                  interestComponent: r.interestComponent,
                  feeComponent: r.feeComponent,
                  deductionId: r.id,
                  narration: `Recovered in payroll ${payrollId}`,
                })),
              skipDuplicates: true,
            });
          }

          // Fully-recovered sweep, INSIDE the transaction (see method doc).
          //
          // Gated on `autoCloseOnFullRecovery`, which was resolved into the
          // policy and branched on nowhere: the sweep closed every fully
          // recovered loan unconditionally, so a deployment that wanted a human
          // to confirm closure — because a final fee or an interest adjustment
          // may still be coming — could set the flag, see it saved, and watch
          // loans close anyway.
          const lockPolicy = await this.loanPolicy
            .resolve(payroll.branchId ?? null)
            .catch(() => DEFAULT_LOAN_POLICY);

          const affected = await tx.advanceLoanRequest.findMany({
            where: { id: { in: ids } },
          });
          for (const req of affected) {
            if (req.status === 'COMPLETED') continue;
            if (!lockPolicy.autoCloseOnFullRecovery) continue;
            if (Number(req.amountRepaid) >= Number(req.amount)) {
              await tx.advanceLoanRequest.update({
                where: { id: req.id },
                data: { status: 'COMPLETED', completedAt: now },
              });
              completedReqs.push({
                id: req.id,
                employeeId: req.employeeId,
                type: req.type,
                amount: Number(req.amount),
              });
            }
          }
        }

        // ── The end-of-service provision ──────────────────────────────────
        //
        // Written in the SAME transaction as the loan ledger above, so the
        // provision moves in the same commit as the money it accompanies. It is
        // a provision and not a payslip line: nothing here touches an item, a
        // net, a tax base or the wage file.
        // Encashment: mark the requests paid and CONSUME the days. Without the
        // second half an employee is paid for a day and still holds it, and the
        // year-end then carries a day that has already become money.
        if (lockFeatures.leaveEncashmentEnabled) {
          await this.encashment.settleForPayroll(tx, payrollId);
        }

        if (lockFeatures.eosbEnabled && lockFeatures.eosbAccrualEnabled) {
          const { accrued, skipped } = await this.gratuity.accrueForPayroll(
            tx,
            payrollId,
            lockFeatures.eosbServiceYearDays,
          );
          if (skipped > 0) {
            // Usually an unrecorded nationality class, which the calculator
            // refuses to guess at. Worth saying out loud: a liability report
            // that quietly omits people reads as a smaller liability.
            this.logger.warn(
              `Gratuity: ${accrued} accrual(s) written for payroll ${payrollId}, ` +
                `${skipped} employee(s) skipped — most often because no ` +
                `nationality class is recorded for them.`,
            );
          }
        }

        const row = await tx.payroll.findUnique({ where: { id: payrollId } });
        return { updated: row, completed: completedReqs };
      },
      { timeout: 30000 },
    );

    // ── Post-transaction, best-effort side effects ────────────────────────
    // The money is now actually paid, so it appears in budget ACTUALS. Move its
    // commitments OPEN -> REALIZED: not released (that would make it count
    // nowhere) but realized, so it stops counting as committed at exactly the
    // moment it starts counting as actual. Without this the same spend is
    // subtracted from Remaining twice.
    if (sourcedClaims.length > 0) {
      await this.budgetCommitments
        .realizeMany(
          sourcedClaims.map((c) => ({
            sourceType: c.sourceType as 'TRAVEL' | 'TRAINING',
            sourceId: c.sourceId as string,
          })),
          `Paid in payroll ${payrollId}`,
        )
        .catch((e) =>
          this.logger.error(
            `Budget realize on payroll lock failed: ${e.message}`,
          ),
        );
    }

    // Notify requesters whose advance/loan just completed. Batched: this used
    // to run a user.findFirst inside the loop.
    if (completed.length > 0) {
      try {
        const users = await this.prisma.user.findMany({
          where: { employeeId: { in: completed.map((c) => c.employeeId) } },
          select: { id: true, employeeId: true },
        });
        const userByEmployee = new Map(
          users.map((u) => [u.employeeId as string, u.id]),
        );
        for (const req of completed) {
          const userId2 = userByEmployee.get(req.employeeId);
          if (!userId2) continue;
          const label = req.type === 'LOAN' ? 'Loan' : 'Salary advance';
          // Deduped on the payroll CYCLE. Unlocking and re-locking a run is an
          // ordinary correction, and it used to re-announce every completed
          // loan each time — the borrower was told twice that the same loan
          // had been repaid. The link now names the loan rather than the list,
          // so somebody with several can tell which one this is about.
          await this.loanNotifications.notifyOnce({
            requestId: req.id,
            event: 'LOAN_COMPLETED',
            periodKey: `${payroll.year}-${String(payroll.month).padStart(2, '0')}`,
            recipientUserId: userId2,
            title: `${label} fully repaid`,
            message: `Your ${label.toLowerCase()} of ${req.amount} has been fully recovered and is now marked completed.`,
            link: `/dashboard/advance-loans/${req.id}`,
          });
        }
      } catch {
        // Completion notification is best-effort.
      }
    }

    // Deferral mode: EXTEND_TENURE.
    //
    // `deferralMode` was resolved into the policy and branched on nowhere, so
    // both values behaved as CARRY_FORWARD — a missed instalment stayed due and
    // the NEXT cycle owed two, which is the opposite of what a company setting
    // EXTEND_TENURE is asking for. Under EXTEND_TENURE the plan gains a cycle
    // instead, so the deduction stays the size the borrower agreed to.
    //
    // Applied at lock, once the deferral is final, and only for loans this run
    // actually deferred. Best-effort: a regeneration failure must not undo a
    // lock, and the carry-forward sweep still collects the instalment either
    // way.
    try {
      const lockPolicy = await this.loanPolicy
        .resolve(payroll.branchId ?? null)
        .catch(() => DEFAULT_LOAN_POLICY);

      if (lockPolicy.moduleV2Enabled && lockPolicy.deferralMode === 'EXTEND_TENURE') {
        const deferred = await this.prisma.advanceLoanDeduction.findMany({
          where: {
            payrollItem: { payrollId },
            outcome: 'DEFER',
          },
          select: { requestId: true },
          distinct: ['requestId'],
        });
        for (const row of deferred) {
          await this.loanSchedules
            .regenerate(row.requestId, { extendBy: 1, actorId: userId })
            .catch((err) =>
              this.logger.error(
                `Payroll ${payrollId} deferred loan ${row.requestId} but the tenure could not be extended: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
        }
      }
    } catch (err) {
      this.logger.error(
        `Payroll ${payrollId} locked, but deferral handling failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Record what court orders actually took, now that the money is final.
    //
    // At LOCK, not at generation: a draft run can be deleted, and money that
    // never moved must not count against an order's cap. Recomputed from the
    // payslip rather than carried from generation, because the payslip is what
    // was actually paid — and the unique (order, month, year) makes a re-lock
    // after an unlock a no-op instead of a second collection.
    try {
      const items = await this.prisma.payrollItem.findMany({
        where: { payrollId, garnishment: { gt: 0 } },
        select: { id: true, employeeId: true, garnishment: true },
      });
      if (items.length > 0) {
        const orders = await this.garnishments.loadActiveOrders(
          items.map((i) => i.employeeId),
          { month: payroll.month, year: payroll.year },
        );
        for (const item of items) {
          const split = GarnishmentsService.takeFor(
            orders.get(item.employeeId) ?? [],
            Number(item.garnishment),
          );
          await this.garnishments.recordCollected(
            split.orders.map((o) => ({ ...o, payrollItemId: item.id })),
            { month: payroll.month, year: payroll.year },
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Payroll ${payrollId} locked, but garnishment collections could not all be recorded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Tell employees their payslip is available.
    //
    // Text only, with a link to the portal — deliberately no amounts. Salary
    // figures over a consumer messenger are a Phase 2 decision behind a PIN.
    //
    // This fans out one row per employee. At the default 1.2s pacing a
    // 300-person run drains over ~6 minutes in the background, which is the
    // intended behaviour and the main reason the outbox is serial.
    try {
      const recipients = await this.prisma.payrollItem.findMany({
        where: { payrollId },
        select: { employee: { select: { user: { select: { id: true } } } } },
      });
      const userIds = recipients
        .map((r) => r.employee?.user?.id)
        .filter((id): id is string => Boolean(id));

      await this.dispatcher.dispatch({
        event: 'payslip_ready',
        userIds,
        title: 'Your payslip is ready',
        message: `Your payslip for ${payroll.month}/${payroll.year} is now available in the portal.`,
        type: 'SUCCESS',
        link: '/dashboard/my-payroll',
        data: { period: `${payroll.month}/${payroll.year}` },
        dedupeKey: `payslip:${payrollId}`,
      });
    } catch {
      // Payslip availability notice is best-effort; the money is already locked.
    }

    await this.auditTransition(
      opts.stamp === 'FINALIZE' ? 'PAYROLL_FINALIZED' : 'PAYROLL_LOCKED',
      payroll,
      userId,
      'LOCKED',
      { runType: payroll.runType },
    );

    return {
      success: true,
      message: 'Payroll locked',
      data: updated,
    };
  }

  async lockPayroll(payrollId: string, userId: string) {
    return this.applyLock(payrollId, userId, {
      allowedFrom: [PayrollStatus.APPROVED],
      stamp: 'LOCK',
    });
  }

  async createRevision(
    payrollId: string,
    userId: string,
    dto: { reason: string },
  ) {
    const originalPayroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
      include: { items: true },
    });

    if (!originalPayroll) {
      throw new NotFoundException('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(originalPayroll.branchId);

    if (originalPayroll.status !== 'LOCKED') {
      throw new BadRequestException(
        'Can only create a revision from a LOCKED payroll',
      );
    }

    // Create new payroll with incremented version.
    //
    // branchId and batchId are copied EXPLICITLY. The auto-stamp middleware
    // early-returns for a caller with global branch access, so omitting
    // branchId here left the revision company-wide (null): invisible to scoped
    // HR, a 404 from assertInBranch for them, and impossible to resolve a
    // per-branch WPS configuration against. A revision belongs to the same
    // branch and batch as the payroll it corrects.
    const newPayroll = await this.prisma.payroll.create({
      data: {
        month: originalPayroll.month,
        year: originalPayroll.year,
        status: 'DRAFT',
        totalAmount: originalPayroll.totalAmount,
        version: originalPayroll.version + 1,
        previousVersionId: originalPayroll.id,
        branchId: originalPayroll.branchId,
        batchId: originalPayroll.batchId,
        notes: `Version ${originalPayroll.version + 1} - ${dto.reason}`,
      },
    });

    // Copy all payroll items
    const newItems = originalPayroll.items.map((item) => ({
      payrollId: newPayroll.id,
      employeeId: item.employeeId,
      baseSalary: item.baseSalary,
      workDays: item.workDays,
      actualWorkDays: item.actualWorkDays,
      allowances: item.allowances,
      bonus: item.bonus,
      deduction: item.deduction,
      overtimeHours: item.overtimeHours,
      overtimePay: item.overtimePay,
      foodAllowance: item.foodAllowance,
      siteAllowance: item.siteAllowance,
      // Copy the amount only; reimbursement rows stay linked to the LOCKED
      // original so a revision can never pay them out twice.
      reimbursement: item.reimbursement,
      // Same rule for advance/loan recovery: copy the figure but create no
      // ledger rows, so a revision never double-charges an installment.
      advanceLoanDeduction: item.advanceLoanDeduction,
      insurance: item.insurance,
      tax: item.tax,
      netSalary: item.netSalary,
      notes: item.notes,
    }));

    await this.prisma.payrollItem.createMany({ data: newItems });

    return {
      success: true,
      message: `Version ${newPayroll.version} of payroll created`,
      data: newPayroll,
    };
  }

  async getApprovalHistory(payrollId: string) {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
    });

    if (!payroll) {
      throw new NotFoundException('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(payroll.branchId);

    const history: HistoryItem[] = [];

    // Created
    history.push({
      action: 'CREATED',
      timestamp: payroll.createdAt,
      status: 'DRAFT',
    });

    // Submitted
    if (payroll.submittedAt) {
      const submitter = payroll.submittedBy
        ? await this.prisma.user.findUnique({
            where: { id: payroll.submittedBy },
            select: { email: true },
          })
        : null;

      history.push({
        action: 'SUBMITTED',
        timestamp: payroll.submittedAt,
        performedBy: submitter?.email,
        status: 'PENDING_APPROVAL',
      });
    }

    // Approved
    if (payroll.approvedAt) {
      const approver = payroll.approvedBy
        ? await this.prisma.user.findUnique({
            where: { id: payroll.approvedBy },
            select: { email: true },
          })
        : null;

      history.push({
        action: 'APPROVED',
        timestamp: payroll.approvedAt,
        performedBy: approver?.email,
        status: 'APPROVED',
      });
    }

    // Rejected
    if (payroll.rejectedAt) {
      const rejector = payroll.rejectedBy
        ? await this.prisma.user.findUnique({
            where: { id: payroll.rejectedBy },
            select: { email: true },
          })
        : null;

      history.push({
        action: 'REJECTED',
        timestamp: payroll.rejectedAt,
        performedBy: rejector?.email,
        reason: payroll.rejectionReason,
        status: 'REJECTED',
      });
    }

    // Locked
    if (payroll.lockedAt) {
      const locker = payroll.lockedBy
        ? await this.prisma.user.findUnique({
            where: { id: payroll.lockedBy },
            select: { email: true },
          })
        : null;

      history.push({
        action: 'LOCKED',
        timestamp: payroll.lockedAt,
        performedBy: locker?.email,
        status: 'LOCKED',
      });
    }

    // Unlocked (reversal)
    //
    // The trail had no unlock step at all: reversing a run simply removed the
    // LOCKED entry, so a lock that had settled reimbursements and written loan
    // ledger rows left the history looking as though it never happened. The lock
    // now stays on the record and the reversal is appended after it, which is how
    // `unlockPayroll` already treats the ledger it reverses.
    if (payroll.unlockedAt) {
      const unlocker = payroll.unlockedBy
        ? await this.prisma.user.findUnique({
            where: { id: payroll.unlockedBy },
            select: { email: true },
          })
        : null;

      history.push({
        action: 'UNLOCKED',
        timestamp: payroll.unlockedAt,
        performedBy: unlocker?.email,
        reason: payroll.unlockReason,
        status: payroll.status,
      });
    }

    // Sort by timestamp
    history.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return {
      success: true,
      data: {
        payrollId,
        month: payroll.month,
        year: payroll.year,
        currentStatus: payroll.status,
        version: payroll.version,
        history,
      },
    };
  }

  async bulkApprove(payrollIds: string[], userId: string, notes?: string) {
    const results = {
      success: [] as string[],
      failed: [] as { id: string; reason: string }[],
    };

    for (const payrollId of payrollIds) {
      try {
        await this.approvePayroll(payrollId, userId, { notes });
        results.success.push(payrollId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.failed.push({
          id: payrollId,
          reason: message,
        });
      }
    }

    return {
      success: true,
      message: `Approved ${results.success.length}/${payrollIds.length} payrolls`,
      data: results,
    };
  }

  async remove(id: string) {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id },
    });

    if (!payroll) {
      throw new NotFoundException('Payroll not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(payroll.branchId);

    if (payroll.status === 'LOCKED') {
      throw new BadRequestException('Cannot delete a locked payroll');
    }

    const removeFeatures = await this.features.resolve();

    await this.prisma.$transaction(async (tx) => {
      // The loan ledger's payroll_item FK is SetNull (so REVERSED history
      // survives a run being deleted), which means deleting the payroll no
      // longer cascades the in-flight rows away. Delete the PENDING and
      // explanatory SKIPPED rows explicitly to keep the behaviour that made
      // deleting a draft re-release its instalments — while leaving PAID and
      // REVERSED rows untouched as history.
      await tx.advanceLoanDeduction.deleteMany({
        where: {
          payrollItem: { payrollId: id },
          status: { in: ['PENDING', 'SKIPPED'] },
        },
      });

      // Court orders do not cascade: `garnishments.amountRecovered` lives on a
      // row the payroll does not own, and the carry-forward ledger is
      // deliberately not FK'd to the run. Roll both back explicitly, BEFORE the
      // delete, or generate -> delete -> regenerate double-counts against a
      // finite order and closes it early.
      await this.garnishments.reverseForPayroll(tx, id);
      // The provision follows the run it belonged to. A deleted run that left a
      // liability behind would overstate what the company owes.
      if (removeFeatures.eosbAccrualEnabled) {
        await this.gratuity.reverseForPayroll(tx, id);
      }
      if (removeFeatures.employeeRecoveryEnabled) {
        await this.recoveries.reverseForPayroll(tx, id);
      }

      await tx.payroll.delete({ where: { id } });
    });

    return {
      success: true,
      message: `Payroll for ${payroll.month}/${payroll.year} deleted successfully`,
    };
  }

  /**
   * Reverse a locked payroll so it can be corrected and re-run.
   *
   * There was previously NO way back from LOCKED: once the ledger had flipped
   * and balances had moved, an incorrect recovery was unrecoverable through the
   * API. Reversal is append-only — deductions become REVERSED and a REVERSAL
   * transaction is written; nothing is deleted, so the audit trail survives.
   */
  async unlockPayroll(
    payrollId: string,
    userId: string,
    dto: { reason: string },
  ) {
    const payroll = await this.prisma.payroll.findUnique({
      where: { id: payrollId },
    });
    if (!payroll) throw new NotFoundException('Payroll not found');
    assertInBranch(payroll.branchId);

    if (payroll.status !== PayrollStatus.LOCKED) {
      throw new BadRequestException('Only a LOCKED payroll can be unlocked');
    }

    const paidRows = await this.prisma.advanceLoanDeduction.findMany({
      where: { status: 'PAID', payrollItem: { payrollId } },
      select: {
        id: true,
        requestId: true,
        scheduleId: true,
        amount: true,
        principalComponent: true,
        interestComponent: true,
        feeComponent: true,
        shortfallAmount: true,
      },
    });

    if (paidRows.length > 0) {
      // Reversing out of order would corrupt the carry-forward state of every
      // later cycle, so the most recent recovery must be reversed first.
      const later = await this.prisma.advanceLoanDeduction.findFirst({
        where: {
          status: 'PAID',
          requestId: { in: paidRows.map((r) => r.requestId) },
          payrollItem: { payrollId: { not: payrollId } },
          OR: [
            { year: { gt: payroll.year } },
            { year: payroll.year, month: { gt: payroll.month } },
          ],
        },
        select: { month: true, year: true },
      });
      if (later) {
        throw new ConflictException(
          `A later payroll run (${later.month}/${later.year}) has already recovered against these loans. Reverse that run first.`,
        );
      }
    }

    const lockedRevision = await this.prisma.payroll.findFirst({
      where: { previousVersionId: payrollId, status: PayrollStatus.LOCKED },
      select: { id: true, version: true },
    });
    if (lockedRevision) {
      throw new ConflictException(
        `Revision v${lockedRevision.version} of this payroll is locked. Unlock the revision first.`,
      );
    }

    const now = new Date();
    const unlockFeatures = await this.features.resolve();

    // A settlement has already been paid against this run's provision.
    //
    // Reversing it now would leave the settlement standing on an accrual that
    // says it never happened. Refused BEFORE the transaction, and for the same
    // reason as the "a later run already recovered against these loans" guard
    // above: a reversal must never make an earlier, already-honoured decision
    // unexplainable.
    if (unlockFeatures.eosbAccrualEnabled) {
      const settled = await this.gratuity.settledAccrualCount(payrollId);
      if (settled > 0) {
        throw new ConflictException(
          `This payroll cannot be unlocked: ${settled} end-of-service ` +
            `provision(s) from it have already been paid out in a final ` +
            `settlement. Reverse the settlement first.`,
        );
      }
    }

    const updated = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${payrollId}, 0))`;

        const cas = await tx.payroll.updateMany({
          where: { id: payrollId, status: PayrollStatus.LOCKED },
          data: {
            status: PayrollStatus.APPROVED,
            // `lockedAt` / `lockedBy` are deliberately NOT cleared.
            //
            // A lock is the transition that moves money: it settles
            // reimbursements and writes the loan ledger. `getApprovalHistory()`
            // derives its LOCKED step from `lockedAt`, so nulling it erased the
            // lock from the only trail the product shows — after a reversal there
            // was no usable record anywhere that the run had ever been locked,
            // and therefore none that the money had moved. The audit table cannot
            // fill the gap: every transition writes `CREATE` and no row carries
            // both sides of a change.
            //
            // The reversal is append-only instead, exactly as it already is for
            // the loan ledger it reverses: `unlockedAt`, `unlockedBy`,
            // `unlockReason` and `unlockCount` record the reversal, and the lock
            // it reversed stays on the record.
            unlockedAt: now,
            unlockedBy: userId,
            unlockReason: dto.reason,
            unlockCount: { increment: 1 },
          },
        });
        if (cas.count === 0) {
          throw new ConflictException(
            'Payroll is no longer locked (changed concurrently)',
          );
        }

        await tx.reimbursement.updateMany({
          where: { status: 'PAID', payrollItem: { payrollId } },
          data: { status: 'APPROVED', paidAt: null },
        });

        // The same reversal the loan ledger gets below, for court orders: put
        // `amountRecovered` back, delete the shortfalls this run opened, and
        // re-open the balances it cleared. Without it a revision re-prices the
        // orders against a total the reversed run had already advanced, and a
        // finite order closes for money the employee was handed back.
        await this.garnishments.reverseForPayroll(tx, payrollId);
        if (unlockFeatures.eosbAccrualEnabled) {
          await this.gratuity.reverseForPayroll(tx, payrollId);
        }
        if (unlockFeatures.employeeRecoveryEnabled) {
          await this.recoveries.reverseForPayroll(tx, payrollId);
        }
        if (unlockFeatures.leaveEncashmentEnabled) {
          // Put the requests back to APPROVED and release the days, so the next
          // run can pay them once and only once.
          await this.encashment.reverseForPayroll(tx, payrollId);
        }

        if (paidRows.length > 0) {
          const ids = [...new Set(paidRows.map((r) => r.requestId))].sort();
          await tx.$executeRaw`SELECT id FROM advance_loan_requests WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;

          for (const row of paidRows) {
            await tx.advanceLoanDeduction.update({
              where: { id: row.id },
              data: { status: 'REVERSED', reversedAt: now, reversedBy: userId },
            });

            await tx.loanTransaction.create({
              data: {
                requestId: row.requestId,
                type: 'REVERSAL',
                transactionDate: now,
                amount: row.amount,
                principalComponent: row.principalComponent,
                interestComponent: row.interestComponent,
                feeComponent: row.feeComponent,
                createdById: userId,
                narration: `Reversal of payroll ${payroll.month}/${payroll.year}: ${dto.reason}`,
              },
            });

            await tx.advanceLoanRequest.update({
              where: { id: row.requestId },
              data: {
                amountRepaid: { decrement: Number(row.principalComponent) },
                interestPaid: { decrement: Number(row.interestComponent) },
                feesPaid: { decrement: Number(row.feeComponent) },
                // The mirror of the lock: the recovery put this principal back
                // on the books, so reversing it owes that principal again. Left
                // out, an unlock would understate the balance by exactly what it
                // had just handed back to the employee.
                outstandingPrincipal: {
                  increment: Number(row.principalComponent),
                },
                version: { increment: 1 },
              },
            });

            if (row.scheduleId) {
              const sched = await tx.loanSchedule.findUnique({
                where: { id: row.scheduleId },
                select: {
                  emiAmount: true,
                  paidAmount: true,
                  paidPrincipal: true,
                  paidInterest: true,
                },
              });
              if (sched) {
                const paidAmount = Math.max(
                  0,
                  Number(sched.paidAmount) - Number(row.amount),
                );
                await tx.loanSchedule.update({
                  where: { id: row.scheduleId },
                  data: {
                    paidAmount,
                    paidPrincipal: Math.max(
                      0,
                      Number(sched.paidPrincipal) -
                        Number(row.principalComponent),
                    ),
                    paidInterest: Math.max(
                      0,
                      Number(sched.paidInterest) -
                        Number(row.interestComponent),
                    ),
                    carryForwardAmount: Math.max(
                      0,
                      Number(sched.emiAmount) - paidAmount,
                    ),
                    status: paidAmount > 0 ? 'PARTIAL' : 'SCHEDULED',
                    settledAt: null,
                  },
                });
              }
            }
          }

          // Reopen anything this run auto-closed, but only where a balance is
          // genuinely outstanding again.
          const affected = await tx.advanceLoanRequest.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              status: true,
              amount: true,
              amountRepaid: true,
            },
          });
          for (const req of affected) {
            const stillOwed =
              Number(req.amount) - Number(req.amountRepaid) > 0.005;
            if (stillOwed && ['COMPLETED', 'CLOSED'].includes(req.status)) {
              await tx.advanceLoanRequest.update({
                where: { id: req.id },
                data: {
                  status: 'ACTIVE',
                  completedAt: null,
                  closedAt: null,
                  closureType: null,
                },
              });
            }
          }
        }

        return tx.payroll.findUnique({ where: { id: payrollId } });
      },
      { timeout: 30000 },
    );

    await this.auditTransition(
      'PAYROLL_UNLOCKED',
      payroll,
      userId,
      'APPROVED',
      {
        unlockReason: dto.reason,
        reversedLoanRows: paidRows.length,
      },
    );

    return {
      success: true,
      message: `Payroll for ${payroll.month}/${payroll.year} unlocked; ${paidRows.length} loan recovery row(s) reversed`,
      data: updated,
    };
  }
}
