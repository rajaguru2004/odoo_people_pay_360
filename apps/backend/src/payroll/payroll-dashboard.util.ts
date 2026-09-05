import { AttendanceStatus, SalaryComponentType } from '@prisma/client';
import { roundMoney } from './payroll-calc.util';
import { rate } from '../attendances/attendance-calendar.util';

/**
 * The analytics page's maths, with no Prisma and no Nest in it.
 *
 * Layer 0, exactly like `payroll-period.util.ts` and `payroll-calc.util.ts`:
 * every function here takes plain values and returns plain values, so the
 * arithmetic that the charts rest on can be tested without a database, a
 * module or a clock.
 *
 * The service above composes these. It does the reading; this does the sums.
 */

/** A trend bucket before the running total is walked over it. */
export interface TrendInput {
  key: string;
  label: string;
  gross: number;
  net: number;
  deductions: number;
  employeeCount: number;
}

export interface TrendBucket extends TrendInput {
  /**
   * The running total of `net` from the START of the window to this bucket.
   *
   * Server-owned on purpose. A client-side `reduce` over a filtered array
   * silently restarts the total at whatever the window edge happens to be, so
   * the same month reads as a different cumulative figure depending on which
   * window the reader opened — which is a chart arguing with itself.
   */
  cumulativeNet: number;
}

/** The steps of the gross-to-net bridge, in render order. */
export interface BridgeStep {
  key: string;
  label: string;
  amount: number;
  /**
   * `total` is an absolute column that starts at zero; `add` and `subtract` are
   * floating steps that hang off the running balance. The frontend draws a
   * floating bar from a transparent base, so it needs to be told which is which
   * rather than inferring it from the sign.
   */
  kind: 'total' | 'add' | 'subtract';
}

export interface Bridge {
  steps: BridgeStep[];
  gross: number;
  deductions: number;
  net: number;
  /**
   * What the per-payslip net floor added back.
   *
   * Each payslip floors its own net at zero (`netPay = max(0, gross − deductions)`
   * in `payroll-calc.util.ts`), and only LOP is capped at gross — an ordinary
   * deduction is not. So for anybody whose deductions exceeded their earnings,
   * the excess is charged to nobody, and across the run
   * `Σnet ≥ Σgross − Σdeductions`. This is the difference.
   *
   * It is a step of its own rather than folded into another, because a bridge
   * whose bars do not reach its own final column is the one thing a bridge
   * cannot afford to get wrong. Zero in the ordinary case.
   */
  netFloorResidual: number;
}

/** One component bucket of the earnings/deductions split. */
export interface ComponentBucket {
  key: string;
  label: string;
  amount: number;
}

/** A payslip line as this file needs to read it. */
export interface LineInput {
  code: string;
  type: SalaryComponentType;
  amount: number;
}

/** One department's attendance composition. */
export interface AttendanceSegments {
  present: number;
  late: number;
  absent: number;
  halfDay: number;
  onLeave: number;
}

/**
 * The statuses that are attendance EVENTS.
 *
 * `HOLIDAY` and `WEEKEND` are deliberately absent. They are calendar facts, not
 * things anybody did or failed to do, and leaving them in the denominator
 * shrinks every real rate by however many days the branch was shut — which
 * makes a perfect month look like a two-thirds one.
 */
export const ATTENDANCE_EVENT_STATUSES: AttendanceStatus[] = [
  AttendanceStatus.PRESENT,
  AttendanceStatus.LATE,
  AttendanceStatus.ABSENT,
  AttendanceStatus.HALF_DAY,
  AttendanceStatus.ON_LEAVE,
];

/** The code the calculator gives the loss-of-pay line. */
export const LOP_CODE = 'LOP';

/** The code a basic-salary component is expected to carry. */
export const BASIC_CODE = 'BASIC';

/** The label the frontend prints for rows with no department or type. */
export const UNASSIGNED_LABEL = 'Unassigned';

/**
 * Walk a running total across the window.
 *
 * The buckets arrive oldest first and stay that way: a cumulative series is
 * only meaningful in the order it accumulated.
 */
export function buildCumulativeTrend(
  buckets: readonly TrendInput[],
): TrendBucket[] {
  let running = 0;
  return buckets.map((bucket) => {
    running = roundMoney(running + bucket.net);
    return { ...bucket, cumulativeNet: running };
  });
}

/**
 * The gross-to-net bridge, closed.
 *
 * `net` is the SUM of the payslips' own stored nets, never `gross − deductions`
 * recomputed here: each payslip already floored its own, and subtracting across
 * the run would cancel one person's shortfall against another person's pay.
 * The gap between the two is `netFloorResidual`, and it is rendered rather than
 * hidden.
 *
 * Employer contributions are in none of these figures. They are recorded and
 * never paid to anybody, so putting them in the bridge would stop the bars
 * reaching `netPay` — which is the only thing a bridge is for.
 */
export function buildBridge(input: {
  gross: number;
  deductions: number;
  net: number;
}): Bridge {
  const gross = roundMoney(input.gross);
  const deductions = roundMoney(input.deductions);
  const net = roundMoney(input.net);
  const residual = roundMoney(net - (gross - deductions));

  const steps: BridgeStep[] = [
    { key: 'GROSS', label: 'Gross', amount: gross, kind: 'total' },
    {
      key: 'DEDUCTIONS',
      label: 'Deductions',
      amount: deductions,
      kind: 'subtract',
    },
  ];

  // Drawn only when it is not zero. A permanent "Floor adjustment: 0" column
  // teaches the reader to ignore the one thing on the chart that means
  // somebody's deductions exceeded their pay.
  if (residual !== 0) {
    steps.push({
      key: 'NET_FLOOR',
      label: 'Net floored at zero',
      amount: residual,
      kind: residual > 0 ? 'add' : 'subtract',
    });
  }

  steps.push({ key: 'NET', label: 'Net', amount: net, kind: 'total' });

  return { steps, gross, deductions, net, netFloorResidual: residual };
}

/**
 * Basic, allowances and deductions, from the payslip snapshot.
 *
 * Grouped on `PayslipLine.code` and `type` — the denormalised snapshot — and
 * never through `componentId`, which is nullable and whose component may since
 * have been renamed or retired. The LOP line is a deduction like any other
 * here; it is the bridge, not this chart, that separates it out.
 *
 * `EMPLOYER_CONTRIBUTION` is excluded. It is not part of what was earned or
 * what was withheld, and stacking it beside them would make the column taller
 * than the gross it claims to decompose.
 */
export function buildComponentMix(
  lines: readonly LineInput[],
): ComponentBucket[] {
  let basic = 0;
  let allowances = 0;
  let deductions = 0;

  for (const line of lines) {
    const amount = Number.isFinite(line.amount) ? line.amount : 0;
    if (line.type === SalaryComponentType.EARNING) {
      if (line.code?.toUpperCase() === BASIC_CODE) basic += amount;
      else allowances += amount;
    } else if (line.type === SalaryComponentType.DEDUCTION) {
      deductions += amount;
    }
  }

  return [
    { key: 'BASIC', label: 'Basic', amount: roundMoney(basic) },
    { key: 'ALLOWANCES', label: 'Allowances', amount: roundMoney(allowances) },
    { key: 'DEDUCTIONS', label: 'Deductions', amount: roundMoney(deductions) },
  ];
}

/** An empty composition, so a department with no rows still gets a bar. */
export function emptySegments(): AttendanceSegments {
  return { present: 0, late: 0, absent: 0, halfDay: 0, onLeave: 0 };
}

/**
 * Add one attendance row's status to a department's composition.
 *
 * Anything outside `ATTENDANCE_EVENT_STATUSES` is ignored rather than counted
 * into a catch-all: a weekend is not a category of attendance, and giving it a
 * segment would put the biggest slice on the chart on the days nobody worked.
 */
export function addSegment(
  segments: AttendanceSegments,
  status: AttendanceStatus,
  count = 1,
): void {
  switch (status) {
    case AttendanceStatus.PRESENT:
      segments.present += count;
      break;
    case AttendanceStatus.LATE:
      segments.late += count;
      break;
    case AttendanceStatus.ABSENT:
      segments.absent += count;
      break;
    case AttendanceStatus.HALF_DAY:
      segments.halfDay += count;
      break;
    case AttendanceStatus.ON_LEAVE:
      segments.onLeave += count;
      break;
    default:
      break;
  }
}

/** Every event day in a composition — the denominator of its own bar. */
export function segmentTotal(segments: AttendanceSegments): number {
  return (
    segments.present +
    segments.late +
    segments.absent +
    segments.halfDay +
    segments.onLeave
  );
}

/**
 * Attendance health: the days somebody worked, over the days that were events.
 *
 * `HALF_DAY` counts as worked — the person was there. `ON_LEAVE` is in the
 * denominator because approved leave is a day accounted for, and dropping it
 * would let a team improve its own rate by taking holiday.
 *
 * `null`, never `0`, when there were no event days at all: a month nobody was
 * rostered is not a month everybody failed to turn up.
 */
export function attendanceHealth(segments: AttendanceSegments): number | null {
  const worked = segments.present + segments.late + segments.halfDay;
  return rate(worked, segmentTotal(segments));
}

/**
 * How much of the workforce the period actually paid.
 *
 * `null` when there is nobody active to pay, for the same reason every other
 * rate here is: nought per cent would be a claim that a run failed, and no run
 * was owed.
 */
export function payrollCompletion(
  paid: number,
  activeEmployees: number,
): number | null {
  return rate(paid, activeEmployees);
}

/** One stage of the run pipeline. */
export interface FunnelStage {
  stage: 'DRAFT' | 'CALCULATED' | 'APPROVED' | 'PAID';
  label: string;
  /** Runs that have reached AT LEAST this stage. */
  reached: number;
}

/** A run as the funnel needs to read it. */
export interface FunnelRunInput {
  status: string;
  calculatedAt: Date | null;
  approvedAt: Date | null;
  paidAt: Date | null;
}

/**
 * The run pipeline, as reach rather than as current status.
 *
 * Counting runs by the status they are in right now does not make a funnel: a
 * run in `PAID` is not also in `DRAFT`, so the bars go up and down and the
 * shape means nothing. `reached` counts runs that have got AT LEAST this far,
 * which is monotonically decreasing by construction and makes each step's drop
 * the real answer to "how many runs are stuck before this gate".
 *
 * Read from the TIMESTAMPS, not from the status. A rejected run sits back in
 * `DRAFT` having genuinely been calculated once, and its `calculatedAt` still
 * says so — deriving reach from the current status would quietly un-count it
 * and make the first gate look wider than it was.
 *
 * `CANCELLED` runs are excluded entirely. A withdrawal is not a stage and not a
 * failure; leaving them in the first bar would make it disagree with the run
 * list.
 */
export function buildFunnel(runs: readonly FunnelRunInput[]): FunnelStage[] {
  const live = runs.filter((run) => run.status !== 'CANCELLED');
  return [
    { stage: 'DRAFT', label: 'Started', reached: live.length },
    {
      stage: 'CALCULATED',
      label: 'Computed',
      reached: live.filter((run) => run.calculatedAt !== null).length,
    },
    {
      stage: 'APPROVED',
      label: 'Validated',
      reached: live.filter((run) => run.approvedAt !== null).length,
    },
    {
      stage: 'PAID',
      label: 'Paid',
      reached: live.filter((run) => run.paidAt !== null).length,
    },
  ];
}
