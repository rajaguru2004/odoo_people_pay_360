import { UserRole } from '@prisma/client';
import {
  rate,
  UNASSIGNED_DEPARTMENT,
} from '../attendances/attendance-calendar.util';
import { daysUntil } from '../common/utils/expiry.util';
import { roundMoney } from '../payroll/payroll-calc.util';
import { UNASSIGNED_LABEL } from '../payroll/payroll-dashboard.util';

/**
 * The main dashboard's maths, with no Prisma and no Nest in it.
 *
 * Layer 0, exactly like `payroll-dashboard.util.ts`: every function takes plain
 * values and returns plain values, so the rules the one page every role can
 * open rests on can be exercised without a database, a module or a clock.
 *
 * Two of those rules are the whole reason this file exists rather than living
 * inside the service:
 *
 * **Entitlement is data, not control flow.** `SECTIONS_BY_ROLE` is a table that
 * can be read, diffed against `utils/permissions.ts` and tested. Scattered
 * `if (role === ...)` branches down a 400-line service are a table too — one
 * nobody can see, and one that acquires a sixth branch the day somebody adds a
 * card.
 *
 * **A section the caller may not see is ABSENT, not zeroed.** A payroll block
 * of zeroes sent to an employee tells them the company paid nothing. So the
 * resolver returns the sections a role HAS, and the service both queries and
 * emits exactly those.
 */

/** The blocks a caller may be entitled to. Mirrors `DashboardSection`. */
export type DashboardSection =
  'workforce' | 'attendance' | 'payroll' | 'approvals' | 'compliance';

/**
 * Role → the sections that role may see.
 *
 * Mirrors `ROLE_PERMISSIONS` in the frontend's `utils/permissions.ts`, which is
 * a UI-affordance layer; this is the boundary that actually enforces it.
 *
 * `compliance` is ADMIN and HR only because it answers BY NAME about visas,
 * contracts and probation — the same reason an employee is refused the
 * workforce-wide attendance views while keeping their own history.
 *
 * `me` is in no row. It answers about the caller and nobody else, so it is
 * always present and has no entitlement check on it at all.
 */
export const SECTIONS_BY_ROLE: Record<UserRole, readonly DashboardSection[]> = {
  ADMIN: ['workforce', 'attendance', 'payroll', 'approvals', 'compliance'],
  HR_MANAGER: ['workforce', 'attendance', 'payroll', 'approvals', 'compliance'],
  PAYROLL_OFFICER: ['workforce', 'attendance', 'payroll', 'approvals'],
  MANAGER: ['workforce', 'attendance', 'approvals'],
  EMPLOYEE: [],
};

/**
 * The sections this role gets, as a fresh array.
 *
 * Copied rather than handed out by reference: the returned value is serialised
 * onto the wire, and a caller that sorted or pushed to it would be editing the
 * entitlement table for every subsequent request in the process.
 */
export function sectionsFor(role: UserRole): DashboardSection[] {
  return [...(SECTIONS_BY_ROLE[role] ?? [])];
}

/** May this role see this block? The gate on both the query and the payload. */
export function canSee(role: UserRole, section: DashboardSection): boolean {
  return (SECTIONS_BY_ROLE[role] ?? []).includes(section);
}

// ── Approvals ────────────────────────────────────────────────────────────────

export type DashboardApprovalSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface DashboardApprovalItem {
  key: string;
  label: string;
  /** Counted in the database. A queue always has a size, so never null. */
  count: number;
  href: string;
  severity: DashboardApprovalSeverity;
  /** Age of the oldest item waiting; `null` only when the queue is empty. */
  oldestDays: number | null;
}

export interface DashboardApprovals {
  total: number;
  items: DashboardApprovalItem[];
}

/** One queue, and who is allowed to be shown it. */
export interface ApprovalQueueDef {
  key: string;
  label: string;
  /** The screen that RESOLVES the queue, not a screen that describes it. */
  href: string;
  /** What the queue means while it is still fresh. Age escalates it. */
  baseSeverity: DashboardApprovalSeverity;
  roles: readonly UserRole[];
}

const ALL_APPROVERS: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.HR_MANAGER,
];

/**
 * The pending queues, and the roles that may act on each.
 *
 * Scoped to what the ROLE can actually do, mirroring the `@Roles` on the review
 * endpoint each `href` leads to. A card offering work to somebody the server
 * will refuse is a link to /403, and a reader who follows one twice stops
 * reading the panel.
 *
 * - A MANAGER holds `APPROVE_LEAVE` and `APPROVE_OVERTIME` and nothing else, so
 *   those two queues and no others.
 * - Payroll runs reach the PAYROLL_OFFICER even though only an ADMIN may sign
 *   one off. Separation of duties says the officer who ran it does not approve
 *   it; it does not say the officer is not the person chasing it, and a run
 *   stuck at the gate is their work not finishing.
 * - Corrections, terminations and department changes are all reviewed by ADMIN
 *   or HR — see the `@Roles` on `/attendance-corrections/:id/review`,
 *   `/contracts/terminations/:id/review` and
 *   `/departments/change-requests/:id/review`.
 */
export const APPROVAL_QUEUES: readonly ApprovalQueueDef[] = [
  {
    key: 'PAYROLL_RUN_APPROVAL',
    label: 'Payroll runs awaiting approval',
    href: '/dashboard/payroll/runs',
    // Nobody is paid until this clears, which is why it outranks every other
    // queue on the panel while it is still young.
    baseSeverity: 'CRITICAL',
    roles: [UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER],
  },
  {
    key: 'LEAVE_REQUESTS',
    label: 'Leave requests pending',
    href: '/dashboard/leaves/pending',
    baseSeverity: 'WARNING',
    roles: [UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER],
  },
  {
    key: 'OVERTIME_REQUESTS',
    label: 'Overtime requests pending',
    href: '/dashboard/overtime',
    baseSeverity: 'WARNING',
    roles: [UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER],
  },
  {
    key: 'ATTENDANCE_CORRECTIONS',
    label: 'Attendance corrections pending',
    href: '/dashboard/attendance/corrections',
    baseSeverity: 'INFO',
    roles: ALL_APPROVERS,
  },
  {
    key: 'TERMINATION_REQUESTS',
    label: 'Termination requests pending',
    href: '/dashboard/contracts/terminations',
    baseSeverity: 'WARNING',
    roles: ALL_APPROVERS,
  },
  {
    key: 'DEPARTMENT_CHANGE_REQUESTS',
    label: 'Department changes pending',
    href: '/dashboard/departments/change-requests',
    baseSeverity: 'INFO',
    roles: ALL_APPROVERS,
  },
];

/** A queue waiting longer than this is at least a warning. */
export const AGEING_WARNING_DAYS = 3;

/** A queue waiting longer than this is critical, whatever it is about. */
export const AGEING_CRITICAL_DAYS = 7;

const SEVERITY_RANK: Record<DashboardApprovalSeverity, number> = {
  CRITICAL: 2,
  WARNING: 1,
  INFO: 0,
};

/** One queue's size and the age of the oldest thing in it. */
export interface ApprovalQueueCount {
  key: string;
  /** Counted in the database, never measured off a page. */
  count: number;
  /** Whole days the oldest pending item has waited; `null` when none has. */
  oldestDays: number | null;
}

/**
 * Age raises a queue's severity; it never lowers it.
 *
 * A correction raised this morning is administrative, and the same correction
 * unanswered for a fortnight is somebody's pay being wrong. Without this the
 * panel ranks queues by what they are ABOUT rather than by how long a person
 * has been waiting, and the oldest thing on it can sit at the bottom for ever.
 */
export function escalate(
  base: DashboardApprovalSeverity,
  oldestDays: number | null,
): DashboardApprovalSeverity {
  const age = oldestDays ?? 0;
  if (age >= AGEING_CRITICAL_DAYS) return 'CRITICAL';
  if (age >= AGEING_WARNING_DAYS && base === 'INFO') return 'WARNING';
  return base;
}

/**
 * The approvals panel: only the queues this role may act on, and only the ones
 * that are not empty.
 *
 * The `buildAttention` idiom from the payroll hub. An empty queue is DROPPED
 * rather than drawn as a green nought: a panel with six permanent rows on it
 * stops being read, and the entire point is that something appearing here means
 * somebody has to act.
 *
 * `total` counts only what survives that filter, so it is the amount of work
 * THIS reader is being asked to do — not the company's backlog, most of which
 * they may not open.
 *
 * Ranked by severity, then by how long the oldest item has waited, then by
 * size, then by key. The last tiebreak is there so two identical queues never
 * swap places between two requests and make the panel look like it changed.
 */
export function buildApprovals(
  role: UserRole,
  counts: readonly ApprovalQueueCount[],
): DashboardApprovals {
  const byKey = new Map(counts.map((entry) => [entry.key, entry]));

  const items = APPROVAL_QUEUES.filter((queue) =>
    queue.roles.includes(role),
  ).flatMap<DashboardApprovalItem>((queue) => {
    const found = byKey.get(queue.key);
    if (!found || found.count <= 0) return [];
    return [
      {
        key: queue.key,
        label: queue.label,
        count: found.count,
        href: queue.href,
        severity: escalate(queue.baseSeverity, found.oldestDays),
        oldestDays: found.oldestDays,
      },
    ];
  });

  items.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (b.oldestDays ?? -1) - (a.oldestDays ?? -1) ||
      b.count - a.count ||
      a.key.localeCompare(b.key),
  );

  return {
    total: items.reduce((sum, item) => sum + item.count, 0),
    items,
  };
}

/**
 * Whole days something has been waiting — 0 on the day it was raised.
 *
 * The inverse of `daysUntil`, floored at zero. A `createdAt` a few milliseconds
 * in the future (two servers, one clock skew) is a queue of age nought, never
 * a queue that will exist tomorrow.
 */
export function ageInDays(since: Date, now: Date): number {
  return Math.max(0, -daysUntil(since, now));
}

// ── Compliance ───────────────────────────────────────────────────────────────

export interface DashboardExpiryItem {
  id: string;
  employeeName: string;
  /** What is expiring — a document category, a contract type, "Probation". */
  kind: string;
  /** Date-only. Never put through an instant parse on either side. */
  expiryDate: string;
  /** Negative when the date has already passed. */
  daysLeft: number;
  href: string;
}

export interface DashboardExpiryGroup {
  /** The true total, counted in the database. */
  count: number;
  /** A capped sample of `count`, soonest first. Never read its length. */
  items: DashboardExpiryItem[];
}

/** One expiring thing, before the days and the label are worked out. */
export interface ExpiryRowInput {
  id: string;
  employeeName: string;
  kind: string;
  /** A `@db.Date`, at UTC midnight. */
  expiryDate: Date;
  href: string;
}

/**
 * A capped, ordered sample under a true total.
 *
 * `count` comes from the caller's own database count and is never `items.length`
 * — the whole reason the sample is capped is that the list can be longer than
 * the panel, and a card that reported the sample size would under-report the
 * one number it exists to give.
 *
 * Sorted soonest-first with already-lapsed rows at the head, because a negative
 * `daysLeft` is the row somebody has to deal with today.
 */
export function buildExpiryGroup(
  count: number,
  rows: readonly ExpiryRowInput[],
  today: Date,
  cap: number,
): DashboardExpiryGroup {
  const items = rows
    .map((row) => ({
      id: row.id,
      employeeName: row.employeeName,
      kind: row.kind,
      expiryDate: dayKeyOf(row.expiryDate),
      daysLeft: daysUntil(row.expiryDate, today),
      href: row.href,
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, cap));

  return { count, items };
}

/**
 * `YYYY-MM-DD` from a date-only column, read with UTC getters.
 *
 * Prisma hands a `@db.Date` back as midnight UTC. Reading it with local getters
 * moves an expiry on the first of the month into the previous month for any
 * server west of Greenwich, and the panel then counts down to the wrong day.
 */
export function dayKeyOf(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Title case from a SCREAMING_SNAKE enum — `LABOUR_CARD` → `Labour card`.
 *
 * The server owns every label, so the browser never has to know what an enum
 * member is called. Deliberately the same transformation as `humanise` in the
 * frontend's `contractFacts.ts`, so a contract type reads identically on the
 * dashboard and on the contract screen it links to.
 */
export function humaniseEnum(value: string): string {
  if (!value) return '';
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}

// ── Attendance ───────────────────────────────────────────────────────────────

export interface DashboardAttendance {
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  /** Expected today and not yet clocked in. Only meaningful while `!settled`. */
  notCheckedIn: number;
  /** The working calendar minus approved leave — never headcount. */
  expected: number;
  /** `null` when nobody was expected: a closed branch is not a failed one. */
  attendanceRate: number | null;
  settled: boolean;
}

/** What the day's rows and the day's calendar together already established. */
export interface AttendanceSnapshotInput {
  /** Already reconciled against what happened — see `reconcileExpected`. */
  expected: number;
  /** Anybody at work in some measure: PRESENT, LATE or HALF_DAY. */
  present: number;
  /** A SUBSET of `present` — a late arrival still turned up. */
  late: number;
  onLeave: number;
  /** Rows explicitly stamped ABSENT, as opposed to inferred absences. */
  recordedAbsent: number;
  /** False until every branch's office end has passed. */
  settled: boolean;
}

/**
 * Today's attendance, with "absent" treated as a prediction until it is a fact.
 *
 * Before the branch's office day is over, somebody who has not arrived at 09:30
 * may still arrive. So an unsettled day reports only the absences somebody
 * actually recorded, and everyone else expected-but-missing is `notCheckedIn` —
 * a different word for a different claim. After settlement the two collapse:
 * whoever was expected and never turned up is absent.
 *
 * The same arithmetic the Time & Attendance hub's day snapshot uses, so the two
 * pages cannot report a different number of absentees for the same morning.
 *
 * `attendanceRate` divides by `expected` — the working calendar minus approved
 * leave — never by headcount, and is `null` rather than `0` when nobody was
 * expected. A closed branch has not failed to turn up.
 */
export function attendanceSnapshot(
  input: AttendanceSnapshotInput,
): DashboardAttendance {
  const { expected, present, late, onLeave, recordedAbsent, settled } = input;

  const absent = settled
    ? Math.max(recordedAbsent, Math.max(0, expected - present - onLeave))
    : recordedAbsent;

  return {
    present,
    late,
    absent,
    onLeave,
    notCheckedIn: settled
      ? absent
      : Math.max(0, expected - present - onLeave - recordedAbsent),
    expected,
    attendanceRate: rate(present, expected),
    settled,
  };
}

// ── Payroll ──────────────────────────────────────────────────────────────────

/**
 * One department's payroll cost, in the shape `DepartmentCostChart` already
 * takes. Mirrors `DashboardDepartmentRow` in `types/payrollDashboard.ts`.
 */
export interface DashboardDepartmentRow {
  /** `null` for the Unassigned row — employees in no department. */
  id: string | null;
  name: string;
  headcount: number;
  gross: number;
  deductions: number;
  net: number;
  employerCost: number;
  totalCost: number;
  /** Share of total cost; `null` when the total is zero. */
  share: number | null;
  avgNet: number | null;
}

/** A payslip as the department rollup needs to read it, money already unwrapped. */
export interface DepartmentPayslipInput {
  gross: number;
  deductions: number;
  net: number;
  employerCost: number;
  department: { id: string; name: string } | null;
}

/**
 * Payslips folded onto their department, ordered by cost.
 *
 * An employee with no department goes into an explicit `Unassigned` row rather
 * than being dropped: those are usually the records somebody needs to go and
 * fix, and a chart that omits them makes the dashboard's total disagree with
 * the run's.
 *
 * `share` and `avgNet` are `null`, not `0`, when there is nothing to divide by —
 * a department that cost nothing has no share of a total of nothing, and the
 * page draws an em dash rather than claiming it accounted for 0.0% of the bill.
 */
export function rollUpDepartments(
  rows: readonly DepartmentPayslipInput[],
): DashboardDepartmentRow[] {
  const groups = new Map<string, DashboardDepartmentRow>();

  for (const row of rows) {
    const unit = row.department;
    const key = unit?.id ?? UNASSIGNED_DEPARTMENT;
    const group: DashboardDepartmentRow = groups.get(key) ?? {
      id: unit?.id ?? null,
      name: unit?.name ?? UNASSIGNED_LABEL,
      headcount: 0,
      gross: 0,
      deductions: 0,
      net: 0,
      employerCost: 0,
      totalCost: 0,
      share: null,
      avgNet: null,
    };

    group.headcount += 1;
    group.gross = roundMoney(group.gross + row.gross);
    group.deductions = roundMoney(group.deductions + row.deductions);
    group.net = roundMoney(group.net + row.net);
    group.employerCost = roundMoney(group.employerCost + row.employerCost);
    group.totalCost = roundMoney(group.gross + group.employerCost);
    groups.set(key, group);
  }

  const grandTotal = roundMoney(
    [...groups.values()].reduce((sum, group) => sum + group.totalCost, 0),
  );

  return [...groups.values()]
    .map((group) => ({
      ...group,
      share: rate(group.totalCost, grandTotal),
      avgNet:
        group.headcount > 0 ? roundMoney(group.net / group.headcount) : null,
    }))
    .sort((a, b) => b.totalCost - a.totalCost || a.name.localeCompare(b.name));
}

// ── Me ───────────────────────────────────────────────────────────────────────

/** One year's entitlement to one kind of leave. */
export interface LeaveTypeBalanceInput {
  allocated: number;
  used: number;
  carriedOver: number;
}

/** The headline annual/sick row, which exists whether or not the per-type does. */
export interface LeaveHeadlineInput {
  annualLeave: number;
  usedAnnual: number;
  sickLeave: number;
  usedSick: number;
  carriedOver: number;
}

/**
 * Days of leave the caller has left, across every type.
 *
 * `allocated + carriedOver - used`, summed. There is no `remaining` column on
 * `LeaveTypeBalance` on purpose — a stored copy is a fourth number that can
 * disagree with the three it is made of — so it is derived here.
 *
 * The per-type rows WIN when there are any. The headline `LeaveBalance` row
 * carries annual and sick, which are usually two of the per-type rows as well;
 * adding both sources would count the same fortnight twice and tell somebody
 * they have double the holiday they do.
 *
 * `null`, never `0`, when neither exists. A new joiner whose balances have not
 * been allocated yet has an unanswered question, not an exhausted entitlement,
 * and a card reading "0 days left" would send them to HR about nothing.
 */
export function remainingLeaveDays(
  typeBalances: readonly LeaveTypeBalanceInput[],
  headline: LeaveHeadlineInput | null,
): number | null {
  if (typeBalances.length > 0) {
    return typeBalances.reduce(
      (sum, row) => sum + row.allocated + row.carriedOver - row.used,
      0,
    );
  }
  if (headline) {
    return (
      headline.annualLeave +
      headline.carriedOver -
      headline.usedAnnual +
      (headline.sickLeave - headline.usedSick)
    );
  }
  return null;
}
