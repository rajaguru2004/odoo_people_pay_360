import { UserRole } from '@prisma/client';
import {
  ageInDays,
  APPROVAL_QUEUES,
  attendanceSnapshot,
  buildApprovals,
  buildExpiryGroup,
  canSee,
  dayKeyOf,
  escalate,
  humaniseEnum,
  remainingLeaveDays,
  rollUpDepartments,
  SECTIONS_BY_ROLE,
  sectionsFor,
  type ApprovalQueueCount,
  type DashboardSection,
  type DepartmentPayslipInput,
  type ExpiryRowInput,
} from './dashboard.util';

const utc = (key: string) => new Date(`${key}T00:00:00.000Z`);

// ── Entitlement ──────────────────────────────────────────────────────────────

describe('sectionsFor', () => {
  it('gives an admin every block', () => {
    expect(sectionsFor(UserRole.ADMIN)).toEqual([
      'workforce',
      'attendance',
      'payroll',
      'approvals',
      'compliance',
    ]);
  });

  it('gives HR every block, because compliance is theirs to act on', () => {
    expect(sectionsFor(UserRole.HR_MANAGER)).toEqual(
      sectionsFor(UserRole.ADMIN),
    );
  });

  it('refuses compliance to a payroll officer', () => {
    // It answers BY NAME about visas and probation. A payroll officer reads
    // money, not somebody's immigration status.
    expect(sectionsFor(UserRole.PAYROLL_OFFICER)).not.toContain('compliance');
    expect(sectionsFor(UserRole.PAYROLL_OFFICER)).toContain('payroll');
  });

  it('refuses payroll to a manager', () => {
    expect(sectionsFor(UserRole.MANAGER)).toEqual([
      'workforce',
      'attendance',
      'approvals',
    ]);
  });

  it('gives an employee no workforce-wide block at all', () => {
    // The whole of an employee's dashboard is `me`, which is not in this table
    // because it carries no entitlement — it answers about the caller.
    expect(sectionsFor(UserRole.EMPLOYEE)).toEqual([]);
  });

  it('hands out a copy, so a caller cannot edit the entitlement table', () => {
    const sections = sectionsFor(UserRole.MANAGER);
    sections.push('payroll');
    expect(sectionsFor(UserRole.MANAGER)).not.toContain('payroll');
  });

  it('names every role, so a new one cannot default to seeing everything', () => {
    for (const role of Object.values(UserRole)) {
      expect(SECTIONS_BY_ROLE[role]).toBeDefined();
    }
  });
});

describe('canSee', () => {
  it('agrees with the resolver for every role and section', () => {
    const sections: DashboardSection[] = [
      'workforce',
      'attendance',
      'payroll',
      'approvals',
      'compliance',
    ];
    for (const role of Object.values(UserRole)) {
      for (const section of sections) {
        expect(canSee(role, section)).toBe(
          sectionsFor(role).includes(section),
        );
      }
    }
  });
});

// ── Approvals ────────────────────────────────────────────────────────────────

const queue = (
  key: string,
  count: number,
  oldestDays: number | null = 0,
): ApprovalQueueCount => ({ key, count, oldestDays });

const everyQueue = (count: number, oldestDays = 0): ApprovalQueueCount[] =>
  APPROVAL_QUEUES.map((definition) =>
    queue(definition.key, count, oldestDays),
  );

describe('buildApprovals', () => {
  it('drops the empty queues rather than drawing them as zeroes', () => {
    // A panel that always has six rows on it stops being read, and the whole
    // point is that something appearing here means somebody has to act.
    const out = buildApprovals(UserRole.ADMIN, [
      queue('LEAVE_REQUESTS', 0),
      queue('OVERTIME_REQUESTS', 2),
    ]);
    expect(out.items.map((item) => item.key)).toEqual(['OVERTIME_REQUESTS']);
  });

  it('drops a negative count as firmly as a zero', () => {
    const out = buildApprovals(UserRole.ADMIN, [queue('LEAVE_REQUESTS', -1)]);
    expect(out.items).toEqual([]);
  });

  it('shows a manager only the queues a manager may decide', () => {
    const out = buildApprovals(UserRole.MANAGER, everyQueue(3));
    expect(out.items.map((item) => item.key).sort()).toEqual([
      'LEAVE_REQUESTS',
      'OVERTIME_REQUESTS',
    ]);
  });

  it('shows a payroll officer the run gate and nothing else', () => {
    const out = buildApprovals(UserRole.PAYROLL_OFFICER, everyQueue(3));
    expect(out.items.map((item) => item.key)).toEqual([
      'PAYROLL_RUN_APPROVAL',
    ]);
  });

  it('shows an employee nothing, whatever is pending', () => {
    const out = buildApprovals(UserRole.EMPLOYEE, everyQueue(9));
    expect(out).toEqual({ total: 0, items: [] });
  });

  it('totals only what THIS reader was shown', () => {
    // Not the company's backlog: `total` is the amount of work being asked of
    // the person looking at it, and most of the backlog they may not open.
    const out = buildApprovals(UserRole.MANAGER, [
      queue('LEAVE_REQUESTS', 4),
      queue('OVERTIME_REQUESTS', 6),
      queue('TERMINATION_REQUESTS', 100),
    ]);
    expect(out.total).toBe(10);
  });

  it('ranks by severity, then by age, then by size', () => {
    const out = buildApprovals(UserRole.ADMIN, [
      queue('ATTENDANCE_CORRECTIONS', 50, 0),
      queue('LEAVE_REQUESTS', 1, 1),
      queue('PAYROLL_RUN_APPROVAL', 1, 0),
    ]);
    expect(out.items.map((item) => item.key)).toEqual([
      'PAYROLL_RUN_APPROVAL',
      'LEAVE_REQUESTS',
      'ATTENDANCE_CORRECTIONS',
    ]);
  });

  it('breaks a dead heat on the key, so the panel never reshuffles itself', () => {
    const first = buildApprovals(UserRole.ADMIN, [
      queue('TERMINATION_REQUESTS', 2, 1),
      queue('LEAVE_REQUESTS', 2, 1),
    ]);
    const second = buildApprovals(UserRole.ADMIN, [
      queue('LEAVE_REQUESTS', 2, 1),
      queue('TERMINATION_REQUESTS', 2, 1),
    ]);
    expect(first.items.map((i) => i.key)).toEqual(
      second.items.map((i) => i.key),
    );
  });

  it('carries the href of the screen that resolves the queue', () => {
    const out = buildApprovals(UserRole.MANAGER, everyQueue(1));
    const leave = out.items.find((item) => item.key === 'LEAVE_REQUESTS');
    expect(leave?.href).toBe('/dashboard/leaves/pending');
  });

  it('ignores a count for a queue that is not a queue', () => {
    const out = buildApprovals(UserRole.ADMIN, [queue('MADE_UP', 12)]);
    expect(out).toEqual({ total: 0, items: [] });
  });
});

describe('escalate', () => {
  it('leaves a fresh queue at its own severity', () => {
    expect(escalate('INFO', 0)).toBe('INFO');
    expect(escalate('WARNING', 1)).toBe('WARNING');
  });

  it('raises an ageing INFO queue to a warning', () => {
    expect(escalate('INFO', 3)).toBe('WARNING');
  });

  it('makes anything waiting a week critical', () => {
    // A correction raised this morning is administrative; the same correction
    // unanswered for a fortnight is somebody's pay being wrong.
    expect(escalate('INFO', 7)).toBe('CRITICAL');
    expect(escalate('WARNING', 30)).toBe('CRITICAL');
  });

  it('never lowers a severity', () => {
    expect(escalate('CRITICAL', 0)).toBe('CRITICAL');
    expect(escalate('CRITICAL', null)).toBe('CRITICAL');
  });

  it('treats an unknown age as no age rather than as an old one', () => {
    expect(escalate('INFO', null)).toBe('INFO');
  });
});

describe('ageInDays', () => {
  it('counts whole days from the moment something was raised', () => {
    expect(ageInDays(utc('2026-09-01'), utc('2026-09-08'))).toBe(7);
  });

  it('is zero on the day itself', () => {
    expect(ageInDays(utc('2026-09-08'), utc('2026-09-08'))).toBe(0);
  });

  it('floors clock skew at zero rather than reporting a future queue', () => {
    expect(ageInDays(utc('2026-09-09'), utc('2026-09-08'))).toBe(0);
  });
});

// ── Compliance ───────────────────────────────────────────────────────────────

const expiring = (id: string, key: string): ExpiryRowInput => ({
  id,
  employeeName: `Person ${id}`,
  kind: 'Visa',
  expiryDate: utc(key),
  href: `/dashboard/employees/${id}`,
});

describe('buildExpiryGroup', () => {
  const today = utc('2026-09-05');

  it('counts days to expiry from the day itself', () => {
    const out = buildExpiryGroup(1, [expiring('a', '2026-09-20')], today, 5);
    expect(out.items[0].daysLeft).toBe(15);
  });

  it('reports zero on the day a document lapses', () => {
    const out = buildExpiryGroup(1, [expiring('a', '2026-09-05')], today, 5);
    expect(out.items[0].daysLeft).toBe(0);
  });

  it('goes negative for something that has already lapsed', () => {
    // The row this panel exists to surface. Between an expiry at midnight and
    // the nightly job running, the document is still marked ACTIVE.
    const out = buildExpiryGroup(1, [expiring('a', '2026-09-01')], today, 5);
    expect(out.items[0].daysLeft).toBe(-4);
  });

  it('puts the most overdue row first', () => {
    const out = buildExpiryGroup(
      3,
      [
        expiring('c', '2026-10-01'),
        expiring('a', '2026-08-30'),
        expiring('b', '2026-09-06'),
      ],
      today,
      5,
    );
    expect(out.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the true total above a capped sample', () => {
    // A named sample is not a count. A card reporting `items.length` would
    // under-report the one number it exists to give.
    const rows = ['a', 'b', 'c', 'd'].map((id) => expiring(id, '2026-09-10'));
    const out = buildExpiryGroup(97, rows, today, 2);
    expect(out.count).toBe(97);
    expect(out.items).toHaveLength(2);
  });

  it('survives a cap of zero without dropping the count', () => {
    const out = buildExpiryGroup(4, [expiring('a', '2026-09-10')], today, 0);
    expect(out).toEqual({ count: 4, items: [] });
  });

  it('reports an empty group rather than throwing on one', () => {
    expect(buildExpiryGroup(0, [], today, 5)).toEqual({ count: 0, items: [] });
  });

  it('reads a date-only column with UTC getters', () => {
    // A `@db.Date` put through a local parse lands on the previous day for any
    // server west of Greenwich, and the panel counts down to the wrong date.
    const out = buildExpiryGroup(1, [expiring('a', '2026-01-01')], today, 5);
    expect(out.items[0].expiryDate).toBe('2026-01-01');
  });
});

describe('dayKeyOf', () => {
  it('pads a single-digit month and day', () => {
    expect(dayKeyOf(utc('2026-03-07'))).toBe('2026-03-07');
  });
});

describe('humaniseEnum', () => {
  it('title-cases a SCREAMING_SNAKE member', () => {
    expect(humaniseEnum('LABOUR_CARD')).toBe('Labour card');
    expect(humaniseEnum('FIXED_TERM')).toBe('Fixed term');
  });

  it('leaves a single word readable', () => {
    expect(humaniseEnum('VISA')).toBe('Visa');
  });

  it('returns an empty string rather than throwing on one', () => {
    expect(humaniseEnum('')).toBe('');
  });
});

// ── Attendance ───────────────────────────────────────────────────────────────

describe('attendanceSnapshot', () => {
  it('does not call anybody absent before the office day is over', () => {
    // Somebody who has not arrived at 09:30 may still arrive. Only the rows
    // somebody actually stamped ABSENT are absences; the rest are missing.
    const out = attendanceSnapshot({
      expected: 10,
      present: 6,
      late: 2,
      onLeave: 1,
      recordedAbsent: 0,
      settled: false,
    });
    expect(out.absent).toBe(0);
    expect(out.notCheckedIn).toBe(3);
    expect(out.settled).toBe(false);
  });

  it('turns the prediction into a fact once the day has settled', () => {
    const out = attendanceSnapshot({
      expected: 10,
      present: 6,
      late: 2,
      onLeave: 1,
      recordedAbsent: 0,
      settled: true,
    });
    expect(out.absent).toBe(3);
    expect(out.notCheckedIn).toBe(3);
  });

  it('keeps a recorded absence even when the arithmetic infers fewer', () => {
    const out = attendanceSnapshot({
      expected: 4,
      present: 4,
      late: 0,
      onLeave: 0,
      recordedAbsent: 2,
      settled: true,
    });
    expect(out.absent).toBe(2);
  });

  it('never reports a negative count of people', () => {
    const out = attendanceSnapshot({
      expected: 2,
      present: 5,
      late: 0,
      onLeave: 1,
      recordedAbsent: 0,
      settled: false,
    });
    expect(out.absent).toBe(0);
    expect(out.notCheckedIn).toBe(0);
  });

  it('divides the rate by expected, not by who turned up', () => {
    const out = attendanceSnapshot({
      expected: 8,
      present: 6,
      late: 1,
      onLeave: 2,
      recordedAbsent: 0,
      settled: true,
    });
    expect(out.attendanceRate).toBe(75);
  });

  it('reports a null rate, never a zero, when nobody was expected', () => {
    // A closed branch is not a branch where everybody failed to turn up. The
    // frontend draws `null` as an em dash.
    const out = attendanceSnapshot({
      expected: 0,
      present: 0,
      late: 0,
      onLeave: 0,
      recordedAbsent: 0,
      settled: true,
    });
    expect(out.attendanceRate).toBeNull();
  });

  it('treats late arrivals as a subset of present', () => {
    const out = attendanceSnapshot({
      expected: 5,
      present: 5,
      late: 5,
      onLeave: 0,
      recordedAbsent: 0,
      settled: true,
    });
    expect(out.present).toBe(5);
    expect(out.late).toBe(5);
    expect(out.attendanceRate).toBe(100);
  });
});

// ── Payroll ──────────────────────────────────────────────────────────────────

const payslip = (
  department: { id: string; name: string } | null,
  net: number,
  employerCost = 0,
): DepartmentPayslipInput => ({
  gross: net,
  deductions: 0,
  net,
  employerCost,
  department,
});

describe('rollUpDepartments', () => {
  const finance = { id: 'f', name: 'Finance' };
  const ops = { id: 'o', name: 'Operations' };

  it('folds payslips onto their department and counts heads', () => {
    const out = rollUpDepartments([
      payslip(finance, 100),
      payslip(finance, 300),
      payslip(ops, 200),
    ]);
    expect(out.map((row) => [row.name, row.headcount, row.net])).toEqual([
      ['Finance', 2, 400],
      ['Operations', 1, 200],
    ]);
  });

  it('gives employees in no department an explicit Unassigned row', () => {
    // Dropping them makes the dashboard's total disagree with the run's, and
    // those are usually the records somebody needs to go and fix.
    const out = rollUpDepartments([payslip(null, 50)]);
    expect(out[0].id).toBeNull();
    expect(out[0].name).toBe('Unassigned');
  });

  it('orders by total cost, descending', () => {
    const out = rollUpDepartments([
      payslip(finance, 10, 0),
      payslip(ops, 5, 100),
    ]);
    expect(out.map((row) => row.name)).toEqual(['Operations', 'Finance']);
  });

  it('shares add up to a hundred per cent', () => {
    const out = rollUpDepartments([payslip(finance, 300), payslip(ops, 100)]);
    expect(out.map((row) => row.share)).toEqual([75, 25]);
  });

  it('reports a null share, never a zero, when nothing was paid', () => {
    const out = rollUpDepartments([payslip(finance, 0)]);
    expect(out[0].share).toBeNull();
  });

  it('averages a net over the heads that earned it', () => {
    const out = rollUpDepartments([payslip(finance, 100), payslip(finance, 50)]);
    expect(out[0].avgNet).toBe(75);
  });

  it('rounds to the thousandths the money column stores', () => {
    const out = rollUpDepartments([
      payslip(finance, 0.0005),
      payslip(finance, 0.0005),
    ]);
    expect(Number.isInteger(out[0].net * 1000)).toBe(true);
  });

  it('returns no rows rather than throwing on an unrun month', () => {
    expect(rollUpDepartments([])).toEqual([]);
  });
});

// ── Me ───────────────────────────────────────────────────────────────────────

describe('remainingLeaveDays', () => {
  it('derives the remainder from allocated, carried and used', () => {
    // There is no `remaining` column on purpose: a stored copy is a fourth
    // number that can disagree with the three it is made of.
    expect(
      remainingLeaveDays([{ allocated: 30, used: 4, carriedOver: 2 }], null),
    ).toBe(28);
  });

  it('sums every type the employee holds', () => {
    expect(
      remainingLeaveDays(
        [
          { allocated: 30, used: 10, carriedOver: 0 },
          { allocated: 15, used: 0, carriedOver: 5 },
        ],
        null,
      ),
    ).toBe(40);
  });

  it('prefers the per-type rows over the headline row', () => {
    // The headline carries annual and sick, which are usually two of the
    // per-type rows as well. Adding both would tell somebody they have double
    // the holiday they do.
    expect(
      remainingLeaveDays([{ allocated: 10, used: 0, carriedOver: 0 }], {
        annualLeave: 30,
        usedAnnual: 0,
        sickLeave: 30,
        usedSick: 0,
        carriedOver: 0,
      }),
    ).toBe(10);
  });

  it('falls back to the headline row when no per-type row exists', () => {
    expect(
      remainingLeaveDays([], {
        annualLeave: 30,
        usedAnnual: 5,
        sickLeave: 10,
        usedSick: 1,
        carriedOver: 2,
      }),
    ).toBe(36);
  });

  it('reports null, never zero, when no balance exists at all', () => {
    // A new joiner whose balances have not been allocated has an unanswered
    // question, not an exhausted entitlement.
    expect(remainingLeaveDays([], null)).toBeNull();
  });

  it('reports a genuine zero as zero', () => {
    expect(
      remainingLeaveDays([{ allocated: 10, used: 10, carriedOver: 0 }], null),
    ).toBe(0);
  });
});
