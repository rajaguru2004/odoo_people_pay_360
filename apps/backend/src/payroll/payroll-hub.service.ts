import { Injectable } from '@nestjs/common';
import {
  ContractStatus,
  EmployeeStatus,
  PayrollRunStatus,
  type Prisma,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { dayKeyToDate, rate } from '../attendances/attendance-calendar.util';
import { roundMoney } from './payroll-calc.util';
import { periodFor, periodLabel, previousPeriod } from './payroll-period.util';

/**
 * The Payroll hub, in one request.
 *
 * Kept out of the run and payslip services because it answers a different
 * question. Those are about rows — start a run, calculate one, read a payslip.
 * This is about the shape of a month's payroll, and it shares nothing with them
 * but the tables.
 *
 * Two rules hold the page together:
 *
 * **Money means APPROVED or PAID.** Every money figure on this page filters to
 * those two statuses. A draft is a working figure that is still being
 * corrected, and a hub that added it to "paid this month" would disagree with
 * the register the moment somebody printed one. The hub and the reports read
 * the same locked set, so they cannot tell the reader two different totals.
 *
 * **A rate is `null`, never `0`, when there was nothing to divide by.** No run
 * last month and a run that paid nothing are different claims; a card printing
 * 0.0% for both has told the reader something false about one of them. The
 * frontend renders `null` as an em dash.
 */

/** The statuses that mean the money is settled and may be reported. */
export const LOCKED_RUN_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.PAID,
];

/** The statuses that mean a run is still being worked on. */
export const OPEN_RUN_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.DRAFT,
  PayrollRunStatus.CALCULATED,
];

/**
 * How many names the attention strip prints.
 *
 * `count` stays the true total. A strip showing five names under a count of
 * five when there are ninety would imply the list is the whole set, and the
 * reader would stop looking.
 */
export const NAME_CAP = 5;

/** The currency a hub with no run at all reports in. */
const FALLBACK_CURRENCY = 'OMR';

export type AttentionSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface AttentionItem {
  code: string;
  severity: AttentionSeverity;
  /** The true total, counted in the database. */
  count: number;
  /** A capped sample of `count`, never the whole set. */
  names: string[];
  message: string;
}

export interface HubPeriodRef {
  label: string;
  periodStart: string;
  periodEnd: string;
}

export interface HubTrendBucket {
  label: string;
  periodStart: string;
  gross: number;
  net: number;
  employeeCount: number;
}

export interface PayrollHubSummary {
  months: number;
  period: HubPeriodRef;
  previousPeriod: HubPeriodRef;
  runs: {
    byStatus: Record<PayrollRunStatus, number>;
    oldestAwaitingApproval: {
      id: string;
      label: string;
      calculatedAt: Date | null;
    } | null;
  };
  money: {
    currency: string;
    gross: number;
    net: number;
    deductions: number;
    employerCost: number;
    previousNet: number;
    /** Percentage change on the previous period; `null` when it paid nothing. */
    changePct: number | null;
  };
  employees: {
    paid: number;
    inOpenRun: number;
    active: number;
    withoutStructure: number;
    withoutStructureNames: string[];
  };
  attention: AttentionItem[];
  trend: HubTrendBucket[];
}

/** A run as every card on this page reads it. */
interface RunRow {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  status: PayrollRunStatus;
  currency: string;
  totalGross: MoneyValue;
  totalNet: MoneyValue;
  employeeCount: number;
  calculatedAt: Date | null;
}

/** One month of the window, resolved once and reused by every card. */
interface WindowPeriod {
  periodStart: string;
  periodEnd: string;
  label: string;
}

/** What a money column can arrive as, before it is a number. */
export type MoneyValue = Prisma.Decimal | number | string | null | undefined;

/**
 * A `Decimal(18, 3)` as a number, rounded to the precision the column stores.
 *
 * `Number(decimal.toString())` rather than `decimal.toNumber()` so a plain
 * number — from a caller that already unwrapped one, or from a test double —
 * behaves exactly the same as a Prisma Decimal.
 */
export function money(value: MoneyValue): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value.toString());
  return roundMoney(Number.isFinite(parsed) ? parsed : 0);
}

/** `YYYY-MM-DD` for a date-only column, without ever applying a zone. */
function dayKey(date: Date): string {
  return DateTime.fromJSDate(date, { zone: 'utc' }).toFormat('yyyy-MM-dd');
}

/**
 * Today, as the company clock sees it.
 *
 * A payroll period is a calendar month, and which month "now" falls in differs
 * by zone for a few hours either side of midnight. Read from the company row
 * rather than taken from the server's own clock, so the hub, the reports and
 * the attendance pages all agree about what month it is.
 *
 * A free function so the hub and the reports share one definition; both take
 * the same client and neither may answer for a different day than the other.
 */
export async function companyToday(prisma: PrismaService): Promise<string> {
  const company = await prisma.company.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { timezone: true },
  });
  const zone = company?.timezone?.trim() || 'UTC';
  return DateTime.now().setZone(zone).toFormat('yyyy-MM-dd');
}

const fullName = (person: { firstName: string; lastName: string }) =>
  `${person.firstName} ${person.lastName}`.trim();

@Injectable()
export class PayrollHubService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Everything the Payroll hub renders, in one round of parallel reads.
   *
   * The cards have to agree with each other — a "paid this month" total that
   * disagrees with the trend's last bar is worse than either number alone — so
   * they are all derived from the same set of results rather than fetched card
   * by card.
   */
  async hubSummary(months: number): Promise<PayrollHubSummary> {
    const todayKey = await companyToday(this.prisma);
    const anchor = monthOf(todayKey);
    const period = describePeriod(anchor.month, anchor.year);
    const prev = previousPeriod(anchor.month, anchor.year);
    const previous = describePeriod(prev.month, prev.year);

    const window = trendWindow(anchor.month, anchor.year, months);
    const windowStart = dayKeyToDate(window[0].periodStart);
    const anchorStart = dayKeyToDate(period.periodStart);
    const previousStart = dayKeyToDate(previous.periodStart);
    const activeEmployee = { status: EmployeeStatus.ACTIVE } as const;
    const withoutStructure = {
      ...activeEmployee,
      salaryStructure: { is: null },
    } as const;
    const withoutContract = {
      ...activeEmployee,
      contracts: { none: { status: ContractStatus.ACTIVE } },
    } as const;

    const [
      statusGroups,
      runs,
      staleOpenRuns,
      current,
      priorNet,
      openRunEmployees,
      activeCount,
      noStructureCount,
      noStructureSample,
      noContractCount,
      noContractSample,
    ] = await Promise.all([
      // Counted in the database across all history, not by measuring a page.
      // The runs list is paginated, so a long back catalogue would otherwise be
      // under-reported on the one card whose job is to say what is outstanding.
      this.prisma.payrollRun.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      // One read of the runs table covering the trend window AND every run
      // still open, whatever its period. The trend, the currency, the oldest
      // run awaiting approval and the stale-draft sample all come off these
      // same rows, so no two of them can disagree.
      this.prisma.payrollRun.findMany({
        where: {
          OR: [
            { periodStart: { gte: windowStart } },
            { status: { in: OPEN_RUN_STATUSES } },
          ],
        },
        select: {
          id: true,
          periodStart: true,
          periodEnd: true,
          status: true,
          currency: true,
          totalGross: true,
          totalNet: true,
          employeeCount: true,
          calculatedAt: true,
        },
        orderBy: { periodStart: 'desc' },
      }),
      this.prisma.payrollRun.count({
        where: {
          status: { in: OPEN_RUN_STATUSES },
          periodEnd: { lt: dayKeyToDate(todayKey) },
        },
      }),
      // Money means APPROVED or PAID — here and in every report.
      this.prisma.payslip.aggregate({
        where: {
          payrollRun: {
            periodStart: anchorStart,
            status: { in: LOCKED_RUN_STATUSES },
          },
        },
        _sum: {
          grossPay: true,
          netPay: true,
          totalDeductions: true,
          totalEmployerCost: true,
        },
        _count: { _all: true },
      }),
      this.prisma.payslip.aggregate({
        where: {
          payrollRun: {
            periodStart: previousStart,
            status: { in: LOCKED_RUN_STATUSES },
          },
        },
        _sum: { netPay: true },
      }),
      // Grouped rather than counted, because somebody sitting in two open runs
      // is one person waiting, not two.
      this.prisma.payslip.groupBy({
        by: ['employeeId'],
        where: { payrollRun: { status: { in: OPEN_RUN_STATUSES } } },
      }),
      this.prisma.employee.count({ where: activeEmployee }),
      this.prisma.employee.count({ where: withoutStructure }),
      this.namesOf(withoutStructure),
      this.prisma.employee.count({ where: withoutContract }),
      this.namesOf(withoutContract),
    ]);

    const rows = runs as RunRow[];
    const byStatus = tallyStatuses(statusGroups);
    const awaitingApproval = rows
      .filter((run) => run.status === PayrollRunStatus.CALCULATED)
      .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
    const stale = rows
      .filter(
        (run) =>
          OPEN_RUN_STATUSES.includes(run.status) &&
          dayKey(run.periodEnd) < todayKey,
      )
      .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());

    const net = money(current._sum.netPay);
    const previousNet = money(priorNet._sum.netPay);

    return {
      months,
      period,
      previousPeriod: previous,
      runs: {
        byStatus,
        oldestAwaitingApproval: awaitingApproval[0]
          ? {
              id: awaitingApproval[0].id,
              label: periodLabel(awaitingApproval[0].periodStart),
              calculatedAt: awaitingApproval[0].calculatedAt,
            }
          : null,
      },
      money: {
        currency: this.currencyOf(rows, period.periodStart),
        gross: money(current._sum.grossPay),
        net,
        deductions: money(current._sum.totalDeductions),
        employerCost: money(current._sum.totalEmployerCost),
        previousNet,
        // Null, not zero, when the previous period paid nothing: "unchanged" is
        // a claim about a comparison that cannot be made.
        changePct: rate(net - previousNet, previousNet),
      },
      employees: {
        paid: current._count._all,
        inOpenRun: openRunEmployees.length,
        active: activeCount,
        withoutStructure: noStructureCount,
        withoutStructureNames: noStructureSample,
      },
      attention: buildAttention({
        noStructure: { count: noStructureCount, names: noStructureSample },
        noContract: { count: noContractCount, names: noContractSample },
        awaitingApproval: {
          count: byStatus.CALCULATED,
          names: awaitingApproval
            .slice(0, NAME_CAP)
            .map((run) => periodLabel(run.periodStart)),
        },
        staleOpen: {
          count: staleOpenRuns,
          names: stale
            .slice(0, NAME_CAP)
            .map((run) => periodLabel(run.periodStart)),
        },
      }),
      trend: buildTrend(window, rows),
    };
  }

  /** A capped sample of the people a `where` describes, in a stable order. */
  private async namesOf(where: object): Promise<string[]> {
    const people = await this.prisma.employee.findMany({
      where,
      select: { firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: NAME_CAP,
    });
    return people.map(fullName);
  }

  /**
   * The currency the page prints its money in.
   *
   * The anchor period's run when there is one, the most recent run otherwise.
   * A hub with no runs at all has no money to label, so the fallback is only
   * ever attached to zeroes.
   */
  private currencyOf(rows: RunRow[], anchorStart: string): string {
    const anchorRun = rows.find(
      (run) => dayKey(run.periodStart) === anchorStart,
    );
    return anchorRun?.currency ?? rows[0]?.currency ?? FALLBACK_CURRENCY;
  }
}

/** The month a day key falls in. */
function monthOf(key: string): { month: number; year: number } {
  const parsed = DateTime.fromFormat(key, 'yyyy-MM-dd', { zone: 'utc' });
  const date = parsed.isValid ? parsed : DateTime.utc();
  return { month: date.month, year: date.year };
}

/** A period and the label the server owns for it. */
export function describePeriod(month: number, year: number): HubPeriodRef {
  const period = periodFor(month, year);
  return { label: periodLabel(period.periodStart), ...period };
}

/**
 * The trend window, oldest first, ending at the anchor month.
 *
 * Every month gets a bucket whether or not a run was locked for it. A chart
 * that simply omitted the empty months would draw a continuous line through a
 * period nobody was paid in.
 */
export function trendWindow(
  month: number,
  year: number,
  months: number,
): WindowPeriod[] {
  const window: WindowPeriod[] = [];
  let cursor = { month, year };
  for (let index = 0; index < months; index += 1) {
    window.unshift(describePeriod(cursor.month, cursor.year));
    cursor = previousPeriod(cursor.month, cursor.year);
  }
  return window;
}

/** Every status named, so a card never has to read `undefined` as zero. */
export function tallyStatuses(
  groups: Array<{ status: PayrollRunStatus; _count: { _all: number } }>,
): Record<PayrollRunStatus, number> {
  const byStatus: Record<PayrollRunStatus, number> = {
    DRAFT: 0,
    CALCULATED: 0,
    APPROVED: 0,
    PAID: 0,
    CANCELLED: 0,
  };
  for (const group of groups) {
    byStatus[group.status] = group._count._all;
  }
  return byStatus;
}

/**
 * One bar per month of the window, from locked runs only.
 *
 * Reads the run's own stamped totals rather than re-summing payslips: those
 * figures are what the run header states, and a chart that quietly computed a
 * different number would be arguing with the page it sits on.
 */
export function buildTrend(
  window: WindowPeriod[],
  rows: RunRow[],
): HubTrendBucket[] {
  const locked = new Map<string, RunRow>();
  for (const run of rows) {
    if (LOCKED_RUN_STATUSES.includes(run.status)) {
      locked.set(dayKey(run.periodStart), run);
    }
  }

  return window.map((period) => {
    const run = locked.get(period.periodStart);
    return {
      label: period.label,
      periodStart: period.periodStart,
      gross: money(run?.totalGross),
      net: money(run?.totalNet),
      employeeCount: run?.employeeCount ?? 0,
    };
  });
}

interface AttentionInput {
  noStructure: { count: number; names: string[] };
  noContract: { count: number; names: string[] };
  awaitingApproval: { count: number; names: string[] };
  staleOpen: { count: number; names: string[] };
}

/**
 * The strip, with only the things that are actually wrong on it.
 *
 * An empty entry is dropped rather than rendered as a green tick: a strip that
 * always has four rows on it stops being read, and the whole point is that
 * something appearing there means somebody has to act.
 */
export function buildAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [
    {
      code: 'NO_STRUCTURE',
      severity: 'CRITICAL',
      count: input.noStructure.count,
      names: input.noStructure.names,
      message: plural(
        input.noStructure.count,
        'active employee has no salary structure and cannot be paid',
        'active employees have no salary structure and cannot be paid',
      ),
    },
    {
      code: 'NO_ACTIVE_CONTRACT',
      severity: 'WARNING',
      count: input.noContract.count,
      names: input.noContract.names,
      message: plural(
        input.noContract.count,
        'active employee has no active contract behind their pay',
        'active employees have no active contract behind their pay',
      ),
    },
    {
      code: 'RUN_AWAITING_APPROVAL',
      severity: 'WARNING',
      count: input.awaitingApproval.count,
      names: input.awaitingApproval.names,
      message: plural(
        input.awaitingApproval.count,
        'calculated run is waiting for approval',
        'calculated runs are waiting for approval',
      ),
    },
    {
      code: 'DRAFT_FOR_CLOSED_PERIOD',
      severity: 'CRITICAL',
      count: input.staleOpen.count,
      names: input.staleOpen.names,
      message: plural(
        input.staleOpen.count,
        'run is still open for a period that has already ended',
        'runs are still open for a period that has already ended',
      ),
    },
  ];

  return items.filter((item) => item.count > 0);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
