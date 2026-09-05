/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BankingConfigService } from '../bank-details/banking-config.service';
import {
  BankingFieldDef,
  branchAllowedCountries,
  validateBankingData,
} from '../bank-details/banking-fields.util';
import { runWithBranchBypass } from '../common/branch/branch-context';
import {
  TREND_MONTH_OPTIONS,
  buildMonthBuckets,
  pct,
} from '../common/utils/workforce-trend.util';

/**
 * One payload for the Payroll hub.
 *
 * The page used to fan out to seven browser requests, five of them
 * `/payrolls/reports/*` endpoints that load every payroll item and every payslip
 * line for a period in order to add up four numbers. This replaces them, on the
 * model of `AttendanceHubService` and `OrganizationHubService`.
 *
 * The question this hub owns: **what is the current payroll processing position,
 * what has been processed, what is waiting for action, and is payroll ready for
 * payment?** It carries no headcount card (People's), no loan book (Finance's)
 * and no attendance rate (Time & Attendance's).
 *
 * Two rules the rest of this file is built on:
 *
 *  - **Money means LOCKED.** Every existing payroll report filters
 *    `status: 'LOCKED'` and is right to: a DRAFT total is money that has not
 *    moved. The same rule applies here so the hub cannot disagree with the
 *    Reports screen.
 *  - **`null` means unknown.** A section that cannot be computed — no wage-file
 *    configuration, the pre-flight switch off, a branch with no banking country
 *    — returns `null`, never zeros. The client renders an em dash for it and is
 *    forbidden from printing an all-clear over it.
 *
 * Everything reads through the Prisma client (`count` / `aggregate` / `groupBy` /
 * `findMany`), all of which are in `BRANCH_READ_ACTIONS`, so branch scoping comes
 * from the extension rather than from a second, divergent implementation here.
 * Nothing in this file writes.
 */

/** Runs whose money has not moved yet. Same set `PayrollReportsService` uses. */
const OPEN_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] as const;

/** Settlement statuses that still represent money leaving the business. */
const OPEN_SETTLEMENT_STATUSES = ['DRAFT', 'APPROVED'] as const;

/**
 * The earning columns, in payslip order.
 *
 * `PayrollReportsService.grossOf()` sums only the first five. The other three
 * are real money on a real payslip that no gross formula in the codebase
 * includes — see `residual` below, which is where that surfaces rather than
 * being quietly absorbed.
 */
const EARNING_COLUMNS = [
  'baseSalary',
  'allowances',
  'bonus',
  'overtimePay',
  'foodAllowance',
  'siteAllowance',
  'reimbursement',
  'leaveEncashment',
] as const;

/** The deduction columns. The first six are `register`'s definition verbatim. */
const DEDUCTION_COLUMNS = [
  'deduction',
  'insurance',
  'tax',
  'advanceLoanDeduction',
  'garnishment',
  'otherRecovery',
] as const;

/**
 * Every money column the hub sums, as a Prisma `_sum` selector.
 *
 * The anchor and the previous month must sum the SAME set or the deltas on the
 * gross and statutory cards compare a total against a subset — which is how a
 * "payroll fell 90%" would get onto a dashboard.
 */
const MONEY_SUM_SELECT = {
  baseSalary: true,
  allowances: true,
  bonus: true,
  overtimePay: true,
  foodAllowance: true,
  siteAllowance: true,
  reimbursement: true,
  leaveEncashment: true,
  deduction: true,
  insurance: true,
  tax: true,
  advanceLoanDeduction: true,
  garnishment: true,
  otherRecovery: true,
  netSalary: true,
} satisfies Prisma.PayrollItemSumAggregateInputType;

export type MoneyColumn =
  | (typeof EARNING_COLUMNS)[number]
  | (typeof DEDUCTION_COLUMNS)[number];

export interface CompositionRow {
  key: MoneyColumn;
  amount: number;
}

export interface HubNamedEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
}

export interface PayrollTrendBucket {
  key: string;
  label: string;
  month: number;
  year: number;
  /** `null` when no run in this month is locked — NOT 0, which reads as "paid nobody". */
  net: number | null;
  /**
   * Gross for the month — the same eight earning columns `composition` sums.
   * `null` on the same rule as `net`: an unfinalised month has no gross either.
   */
  gross: number | null;
  /**
   * The statutory employee contribution (`insurance` — SPF in Oman, EPF in
   * India, CPF in Singapore). Its own series because it is the one deduction a
   * payroll officer is asked to reconcile against a regulator's portal.
   */
  statutory: number | null;
  employees: number;
  runs: number;
  lockedRuns: number;
  /** Whether any run in this month is locked. Drives the chart's "not finalised" state. */
  locked: boolean;
}

export interface PayrollReadiness {
  /** Whom this was measured over, and why. */
  population: 'run' | 'active';
  total: number;
  ready: number;
  /** `null` when nothing could be judged — never 100%. */
  readyRate: number | null;
  noBankRecord: number;
  incompleteFields: number;
  pendingChange: number;
  bankInactive: number;
  countryNotAllowed: number;
  /** Employees whose branch has no banking country, so nothing can be required of them. */
  unknown: number;
  names: HubNamedEmployee[];
}

export interface PayrollHubSummary {
  months: number;
  anchor: {
    month: number;
    year: number;
    label: string;
    resolvedFrom: 'latest-run' | 'current-month';
    /** The month the delta compares against. */
    previous: { month: number; year: number; label: string };
  };
  runs: {
    /** Every status in the trend window — what the pipeline donut draws. */
    windowByStatus: Record<string, number>;
    /**
     * Every run ever, at any status. Load-bearing for one distinction the page
     * cannot otherwise draw: "every run is locked" and "there are no runs" both
     * leave `inProgress` at 0, and only one of them is good news.
     */
    total: number;
    locked: number;
    /** Unwindowed queues. A queue is what is waiting NOW. */
    inProgress: number;
    pendingApproval: number;
    approvedNotLocked: number;
    draft: number;
    rejected: number;
    oldestPendingAt: string | null;
    draftForClosedPeriod: number;
    /** Runs pending approval, named so the strip can list them. */
    pending: Array<{
      id: string;
      month: number;
      year: number;
      label: string;
      submittedAt: string | null;
    }>;
    rejectedRuns: Array<{ id: string; month: number; year: number; label: string }>;
  };
  money: {
    /** `null` when the anchor has no locked run — never 0. */
    net: number | null;
    previousNet: number | null;
    /**
     * Gross, statutory and total deductions for the anchor, on the same
     * locked-only rule as `net`, each with the previous month beside it so the
     * client can draw a delta without a second request.
     */
    gross: number | null;
    previousGross: number | null;
    statutory: number | null;
    previousStatutory: number | null;
    deductions: number | null;
    previousDeductions: number | null;
    currency: string;
  };
  employees: {
    paid: number;
    inOpenRun: number;
    active: number;
    notInAnyRun: number;
    names: HubNamedEmployee[];
  };
  readiness: PayrollReadiness | null;
  trend: PayrollTrendBucket[];
  composition: {
    earnings: CompositionRow[];
    deductions: CompositionRow[];
    grossReported: number;
    deductionsTotal: number;
    net: number | null;
    /**
     * `Σearnings − Σdeductions − Σnet`. Non-zero means the payslip columns do
     * not reconcile with what was paid, and the panel prints it rather than
     * hiding it inside a rounded bar.
     */
    residual: number;
  };
  carryForward: { outstanding: number };
  settlements: { draft: number; awaitingPayment: number; openPayout: number } | null;
  wps: {
    lastFileAt: string | null;
    lastFileStatus: string | null;
    lastFileName: string | null;
    rejected: number;
  } | null;
  /**
   * Legacy company-wide runs (`branchId = null`). `Payroll` is `'direct'` in
   * BRANCH_SCOPE, not `'direct-or-global'`, so these are invisible to every
   * scoped query — including every figure above. Counted and named here so they
   * are visible rather than silently missing.
   */
  unscopedLegacyRuns: number;
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function periodLabel(month: number, year: number): string {
  return `${MONTH_LABELS[month - 1] ?? '??'} ${year}`;
}

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v === null || v === undefined ? 0 : Number(v);
}

/** Round to 2dp the way `PayrollReportsService` does, so totals agree. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class PayrollHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bankingConfig: BankingConfigService,
  ) {}

  /**
   * A window outside the offered list is refused rather than defaulted.
   *
   * Phase E's lesson from `anchor=2026-13-45`: a silent fallback answers for a
   * period nobody asked about, and the reader cannot see that it happened.
   */
  private parseMonths(raw?: string): number {
    if (raw === undefined || raw === null || raw === '') return 6;
    const n = Number(raw);
    if (!Number.isInteger(n) || !TREND_MONTH_OPTIONS.includes(n as 6 | 12)) {
      throw new BadRequestException(
        `months must be one of ${TREND_MONTH_OPTIONS.join(', ')}, received "${raw}"`,
      );
    }
    return n;
  }

  /**
   * The period this hub reports on.
   *
   * Runs are generated after a month ends, so anchoring on the calendar month
   * leaves the hub empty for the first days of every month — a dashboard of
   * nothing, on a database that holds a year of payroll. The anchor is therefore
   * the newest month that has any run, and the page prints which month it landed
   * on so the reader is never guessing.
   */
  private async resolveAnchor(now: Date): Promise<{
    month: number;
    year: number;
    resolvedFrom: 'latest-run' | 'current-month';
  }> {
    const curMonth = now.getUTCMonth() + 1;
    const curYear = now.getUTCFullYear();

    const latest = await this.prisma.payroll.findFirst({
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      select: { month: true, year: true },
    });

    if (!latest) return { month: curMonth, year: curYear, resolvedFrom: 'current-month' };

    const isCurrent = latest.year === curYear && latest.month === curMonth;
    return {
      month: latest.month,
      year: latest.year,
      resolvedFrom: isCurrent ? 'current-month' : 'latest-run',
    };
  }

  /**
   * `(year, month)` is a tuple, and Prisma has no tuple comparison — so a window
   * is expressed as an OR of the months in it. At 6 or 12 entries that is a
   * short, index-friendly clause, and it is exact, which a date-range
   * approximation over two integer columns would not be.
   */
  private monthPairs(
    buckets: Array<{ month: number; year: number }>,
  ): Prisma.PayrollWhereInput {
    return { OR: buckets.map((b) => ({ month: b.month, year: b.year })) };
  }

  async getSummary(monthsRaw?: string, now: Date = new Date()): Promise<PayrollHubSummary> {
    const months = this.parseMonths(monthsRaw);
    const anchor = await this.resolveAnchor(now);

    // The month the money delta compares against.
    const prevDate = new Date(Date.UTC(anchor.year, anchor.month - 2, 1));
    const previous = { month: prevDate.getUTCMonth() + 1, year: prevDate.getUTCFullYear() };

    // The trend window ends on the ANCHOR, not on today: a hub showing July
    // must draw the six months ending in July, or the chart and the cards above
    // it describe different periods.
    const anchorEnd = new Date(Date.UTC(anchor.year, anchor.month - 1, 1));
    const buckets = buildMonthBuckets(months, anchorEnd).map((b) => ({
      key: b.key,
      label: b.label,
      month: b.start.getUTCMonth() + 1,
      year: b.start.getUTCFullYear(),
    }));

    const anchorWhere: Prisma.PayrollWhereInput = {
      month: anchor.month,
      year: anchor.year,
    };
    const curMonth = now.getUTCMonth() + 1;
    const curYear = now.getUTCFullYear();

    const [
      windowRuns,
      queueByStatus,
      oldestPending,
      pendingRuns,
      rejectedRuns,
      draftForClosedPeriod,
      anchorMoney,
      previousMoney,
      anchorItems,
      windowItems,
      activeEmployees,
      excludedCount,
      excludedNames,
      composition,
      carryForward,
      settlementStatus,
      settlementPayout,
      lastWpsFile,
      wpsRejected,
    ] = await Promise.all([
      // Every run in the window, for the pipeline donut and the trend's run counts.
      this.prisma.payroll.findMany({
        where: this.monthPairs(buckets),
        select: { id: true, month: true, year: true, status: true },
      }),
      // Queues are UNWINDOWED on purpose: an open run from four months ago is
      // the problem, and a six-month window would eventually hide it.
      this.prisma.payroll.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.payroll.aggregate({
        where: { status: 'PENDING_APPROVAL' },
        _min: { submittedAt: true },
      }),
      this.prisma.payroll.findMany({
        where: { status: 'PENDING_APPROVAL' },
        select: { id: true, month: true, year: true, submittedAt: true },
        orderBy: [{ submittedAt: 'asc' }],
        take: 12,
      }),
      this.prisma.payroll.findMany({
        where: { status: 'REJECTED' },
        select: { id: true, month: true, year: true },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        take: 12,
      }),
      // A DRAFT for a month that has already ended is money nobody has run.
      this.prisma.payroll.count({
        where: {
          status: 'DRAFT',
          OR: [{ year: { lt: curYear } }, { year: curYear, month: { lt: curMonth } }],
        },
      }),
      this.prisma.payrollItem.aggregate({
        where: { payroll: { ...anchorWhere, status: 'LOCKED' } },
        _sum: { netSalary: true },
        _count: { _all: true },
      }),
      // Same column set as `composition` below: the previous month is what the
      // gross/statutory deltas compare against, so a `netSalary`-only sum here
      // would have left those two cards with no comparison to draw.
      this.prisma.payrollItem.aggregate({
        where: { payroll: { month: previous.month, year: previous.year, status: 'LOCKED' } },
        _sum: MONEY_SUM_SELECT,
        _count: { _all: true },
      }),
      // Distinct employees in the anchor month, by run status. Two runs can
      // cover one month (a per-branch run and a per-batch one), so a plain
      // count of items would double-count a person.
      this.prisma.payrollItem.findMany({
        where: { payroll: anchorWhere },
        select: { employeeId: true, payroll: { select: { status: true } } },
      }),
      // One narrow row per payslip in the window. At a year × a few hundred
      // employees this is a few thousand rows, and it is the only way to get an
      // exact distinct-employee count per month without a query per month.
      this.prisma.payrollItem.findMany({
        where: { payroll: { ...this.monthPairs(buckets), status: 'LOCKED' } },
        select: {
          payrollId: true,
          employeeId: true,
          netSalary: true,
          // The statutory series, and the eight columns `grossOf` adds up.
          insurance: true,
          baseSalary: true,
          allowances: true,
          bonus: true,
          overtimePay: true,
          foodAllowance: true,
          siteAllowance: true,
          reimbursement: true,
          leaveEncashment: true,
        },
      }),
      this.prisma.employee.count({ where: { status: 'ACTIVE' } }),
      // Active employees with no payslip at all in the anchor month.
      this.prisma.employee.count({
        where: { status: 'ACTIVE', payrollItems: { none: { payroll: anchorWhere } } },
      }),
      this.prisma.employee.findMany({
        where: { status: 'ACTIVE', payrollItems: { none: { payroll: anchorWhere } } },
        select: { id: true, employeeCode: true, fullName: true },
        orderBy: { fullName: 'asc' },
        take: 12,
      }),
      this.prisma.payrollItem.aggregate({
        where: { payroll: { ...anchorWhere, status: 'LOCKED' } },
        _sum: MONEY_SUM_SELECT,
      }),
      this.prisma.payrollCarryForward.count({ where: { status: 'OUTSTANDING' } }),
      // Mirrors `FinalSettlementsService.stats()` exactly rather than importing
      // it: same groupBy, same OPEN set, so the two cannot drift apart.
      this.prisma.finalSettlement.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.finalSettlement.aggregate({
        where: { status: { in: [...OPEN_SETTLEMENT_STATUSES] } },
        _sum: { netPayable: true },
      }),
      this.prisma.wpsFile.findFirst({
        orderBy: { generatedAt: 'desc' },
        select: { generatedAt: true, status: true, fileName: true },
      }),
      this.prisma.wpsFile.aggregate({ _sum: { rejectedCount: true } }),
    ]);

    // ── Runs ─────────────────────────────────────────────────────────────
    const windowByStatus: Record<string, number> = {};
    for (const r of windowRuns) {
      windowByStatus[r.status] = (windowByStatus[r.status] ?? 0) + 1;
    }

    const queue = Object.fromEntries(
      queueByStatus.map((r) => [r.status, r._count._all]),
    ) as Record<string, number>;
    const draft = queue['DRAFT'] ?? 0;
    const pendingApproval = queue['PENDING_APPROVAL'] ?? 0;
    const approvedNotLocked = queue['APPROVED'] ?? 0;

    // ── Employees in the anchor month ────────────────────────────────────
    const paidSet = new Set<string>();
    const openSet = new Set<string>();
    for (const it of anchorItems) {
      if (it.payroll.status === 'LOCKED') paidSet.add(it.employeeId);
      else if ((OPEN_STATUSES as readonly string[]).includes(it.payroll.status)) {
        openSet.add(it.employeeId);
      }
    }
    // Somebody already paid is not also "waiting in an open run".
    for (const id of paidSet) openSet.delete(id);

    // ── Trend ────────────────────────────────────────────────────────────
    const runMonthById = new Map(windowRuns.map((r) => [r.id, r]));
    const perMonth = new Map<
      string,
      { net: number; gross: number; statutory: number; employees: Set<string> }
    >();
    for (const item of windowItems) {
      const run = runMonthById.get(item.payrollId);
      if (!run) continue;
      const key = `${run.year}-${String(run.month).padStart(2, '0')}`;
      let entry = perMonth.get(key);
      if (!entry) {
        entry = { net: 0, gross: 0, statutory: 0, employees: new Set<string>() };
        perMonth.set(key, entry);
      }
      entry.net += num(item.netSalary);
      // Same eight columns as `composition.grossReported`, so the sparkline on
      // the gross card cannot disagree with the card's own figure.
      entry.gross +=
        num(item.baseSalary) +
        num(item.allowances) +
        num(item.bonus) +
        num(item.overtimePay) +
        num(item.foodAllowance) +
        num(item.siteAllowance) +
        num(item.reimbursement) +
        num(item.leaveEncashment);
      entry.statutory += num(item.insurance);
      entry.employees.add(item.employeeId);
    }

    const trend: PayrollTrendBucket[] = buckets.map((b) => {
      const runs = windowRuns.filter((r) => r.month === b.month && r.year === b.year);
      const lockedRuns = runs.filter((r) => r.status === 'LOCKED').length;
      const entry = perMonth.get(b.key);
      return {
        key: b.key,
        label: b.label,
        month: b.month,
        year: b.year,
        // A month with no locked run has no net to report. Reporting 0 would
        // draw a floor-height bar that reads as "we paid nobody that month".
        net: lockedRuns > 0 && entry ? round2(entry.net) : null,
        gross: lockedRuns > 0 && entry ? round2(entry.gross) : null,
        statutory: lockedRuns > 0 && entry ? round2(entry.statutory) : null,
        employees: entry ? entry.employees.size : 0,
        runs: runs.length,
        lockedRuns,
        locked: lockedRuns > 0,
      };
    });

    // ── Composition ──────────────────────────────────────────────────────
    const sums = composition._sum as Record<string, Prisma.Decimal | null>;
    const earnings: CompositionRow[] = EARNING_COLUMNS.map((key) => ({
      key,
      amount: round2(num(sums[key])),
    }));
    const deductions: CompositionRow[] = DEDUCTION_COLUMNS.map((key) => ({
      key,
      amount: round2(num(sums[key])),
    }));
    const grossReported = round2(earnings.reduce((a, r) => a + r.amount, 0));
    const deductionsTotal = round2(deductions.reduce((a, r) => a + r.amount, 0));
    const anchorHasLocked = (anchorMoney._count?._all ?? 0) > 0;
    const anchorNet = anchorHasLocked ? round2(num(anchorMoney._sum.netSalary)) : null;

    // The previous month follows the SAME "no locked run means unknown" rule as
    // the anchor. A month with nothing locked sums to 0 in Prisma, and a delta
    // drawn against that 0 would report the whole payroll as growth.
    const prevSums = previousMoney._sum as Record<string, Prisma.Decimal | null>;
    const prevHasLocked = (previousMoney._count?._all ?? 0) > 0;
    const prevOr = (value: number) => (prevHasLocked ? round2(value) : null);
    const prevGross = prevOr(EARNING_COLUMNS.reduce((a, k) => a + num(prevSums[k]), 0));
    const prevDeductions = prevOr(
      DEDUCTION_COLUMNS.reduce((a, k) => a + num(prevSums[k]), 0),
    );

    // ── Readiness ────────────────────────────────────────────────────────
    const readiness = await this.assessReadiness(anchorWhere, paidSet, openSet);

    // ── Deliberately unscoped, and LAST ──────────────────────────────────
    // `runWithBranchBypass` holds a counter on a shared AsyncLocalStorage store
    // for the duration of its callback, so anything running CONCURRENTLY inside
    // it is silently unscoped too. Phase F leaked an org-wide headcount onto a
    // branch view exactly this way. Every scoped read above has already settled.
    const unscopedLegacyRuns = await runWithBranchBypass(() =>
      this.prisma.payroll.count({ where: { branchId: null } }),
    );

    const settlementCounts = Object.fromEntries(
      settlementStatus.map((r) => [r.status, r._count._all]),
    ) as Record<string, number>;

    const rejectedTotal = num(wpsRejected._sum.rejectedCount);

    return {
      months,
      anchor: {
        month: anchor.month,
        year: anchor.year,
        label: periodLabel(anchor.month, anchor.year),
        resolvedFrom: anchor.resolvedFrom,
        previous: {
          month: previous.month,
          year: previous.year,
          label: periodLabel(previous.month, previous.year),
        },
      },
      runs: {
        windowByStatus,
        total: Object.values(queue).reduce((a, n) => a + n, 0),
        locked: queue['LOCKED'] ?? 0,
        inProgress: draft + pendingApproval + approvedNotLocked,
        pendingApproval,
        approvedNotLocked,
        draft,
        rejected: queue['REJECTED'] ?? 0,
        oldestPendingAt: oldestPending._min.submittedAt?.toISOString() ?? null,
        draftForClosedPeriod,
        pending: pendingRuns.map((r) => ({
          id: r.id,
          month: r.month,
          year: r.year,
          label: periodLabel(r.month, r.year),
          submittedAt: r.submittedAt?.toISOString() ?? null,
        })),
        rejectedRuns: rejectedRuns.map((r) => ({
          id: r.id,
          month: r.month,
          year: r.year,
          label: periodLabel(r.month, r.year),
        })),
      },
      money: {
        net: anchorNet,
        previousNet: prevHasLocked ? round2(num(prevSums.netSalary)) : null,
        // Gross and the statutory line beside net, because "what did payroll
        // cost" and "what did the employee take home" are different questions
        // and the hub was only ever answering the second one.
        gross: anchorHasLocked ? grossReported : null,
        previousGross: prevGross,
        statutory: anchorHasLocked ? round2(num(sums.insurance)) : null,
        previousStatutory: prevOr(num(prevSums.insurance)),
        deductions: anchorHasLocked ? deductionsTotal : null,
        previousDeductions: prevDeductions,
        // One tenant, one payroll currency — there is no currency column on
        // Payroll or PayrollItem. The client labels the figure from its own
        // resolved setting; this field exists so the payload is self-describing.
        currency: '',
      },
      employees: {
        paid: paidSet.size,
        inOpenRun: openSet.size,
        active: activeEmployees,
        notInAnyRun: excludedCount,
        names: excludedNames,
      },
      readiness,
      trend,
      composition: {
        earnings,
        deductions,
        grossReported,
        deductionsTotal,
        net: anchorNet,
        residual:
          anchorNet === null ? 0 : round2(grossReported - deductionsTotal - anchorNet),
      },
      carryForward: { outstanding: carryForward },
      settlements: {
        draft: settlementCounts['DRAFT'] ?? 0,
        awaitingPayment: settlementCounts['APPROVED'] ?? 0,
        openPayout: round2(num(settlementPayout._sum.netPayable)),
      },
      wps: lastWpsFile
        ? {
            lastFileAt: lastWpsFile.generatedAt.toISOString(),
            lastFileStatus: lastWpsFile.status,
            lastFileName: lastWpsFile.fileName,
            rejected: rejectedTotal,
          }
        : null,
      unscopedLegacyRuns,
    };
  }

  /**
   * Can the people in this run actually be paid?
   *
   * Nothing in the product answered this before. The two existing pre-flights
   * each miss half of it: `PayrollValidationService` checks no banking at all,
   * and `WpsPreflightService` checks it exhaustively but needs an
   * already-locked payroll AND a wage-file configuration, throwing without
   * either — so it can never be the universal source.
   *
   * This reuses the same validator the bank-details screens and the wage-file
   * builder use, rather than writing a second opinion about what a valid bank
   * record is. It stops short of the WPS identifier checks (LABOUR_CARD,
   * CIVIL_ID), which live inside the wage-file builder and are format-specific,
   * so **this is not the WPS verdict** and the panel says so.
   *
   * The honesty trap: a branch with no banking country has no required fields,
   * so every employee under it would validate as ready. Those are counted as
   * `unknown` and excluded from the rate, which can therefore be `null` — never
   * a fabricated 100%.
   */
  private async assessReadiness(
    anchorWhere: Prisma.PayrollWhereInput,
    paidSet: Set<string>,
    openSet: Set<string>,
  ): Promise<PayrollReadiness | null> {
    const inRun = new Set<string>([...paidSet, ...openSet]);
    const population: 'run' | 'active' = inRun.size > 0 ? 'run' : 'active';

    const employees = await this.prisma.employee.findMany({
      where:
        population === 'run'
          ? { id: { in: [...inRun] } }
          : { status: 'ACTIVE' },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        branch: { select: { country: true, bankingCountries: true } },
        bankDetails: {
          where: { isActive: true },
          select: {
            data: true,
            bank: { select: { country: true, bankCode: true, isActive: true } },
          },
          take: 1,
        },
        bankChangeRequests: {
          where: { status: 'PENDING' },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (employees.length === 0) return null;

    // One field-set fetch per distinct country, not per employee.
    const fieldCache = new Map<string, BankingFieldDef[]>();
    const fieldsFor = async (country: string): Promise<BankingFieldDef[]> => {
      const cached = fieldCache.get(country);
      if (cached) return cached;
      const fields = await this.bankingConfig.getFieldsForCountry(country);
      fieldCache.set(country, fields);
      return fields;
    };

    let ready = 0;
    let noBankRecord = 0;
    let incompleteFields = 0;
    let pendingChange = 0;
    let bankInactive = 0;
    let countryNotAllowed = 0;
    let unknown = 0;
    const names: HubNamedEmployee[] = [];

    const flag = (e: (typeof employees)[number]) => {
      if (names.length < 12) {
        names.push({ id: e.id, employeeCode: e.employeeCode, fullName: e.fullName });
      }
    };

    for (const e of employees) {
      const allowed = branchAllowedCountries(e.branch);
      const detail = e.bankDetails[0];

      // A pending change is reported even when the record on file is valid: the
      // money is about to go to an account somebody has already asked to leave.
      if (e.bankChangeRequests.length > 0) {
        pendingChange += 1;
        flag(e);
        continue;
      }

      if (!detail) {
        noBankRecord += 1;
        flag(e);
        continue;
      }

      if (!detail.bank?.isActive) {
        bankInactive += 1;
        flag(e);
        continue;
      }

      // No banking country configured means nothing can be required, so a
      // "valid" verdict here would be vacuous. Report it as unknown instead.
      if (allowed.length === 0) {
        unknown += 1;
        continue;
      }

      const bankCountry = (detail.bank.country ?? '').toUpperCase();
      if (!allowed.includes(bankCountry)) {
        countryNotAllowed += 1;
        flag(e);
        continue;
      }

      const fields = await fieldsFor(bankCountry);
      if (fields.length === 0) {
        unknown += 1;
        continue;
      }

      const result = validateBankingData(
        bankCountry,
        (detail.data as Record<string, unknown>) ?? {},
        fields,
        detail.bank.bankCode,
      );
      if (result.valid) ready += 1;
      else {
        incompleteFields += 1;
        flag(e);
      }
    }

    const judged = employees.length - unknown;

    return {
      population,
      total: employees.length,
      ready,
      readyRate: pct(ready, judged),
      noBankRecord,
      incompleteFields,
      pendingChange,
      bankInactive,
      countryNotAllowed,
      unknown,
      names,
    };
  }
}
