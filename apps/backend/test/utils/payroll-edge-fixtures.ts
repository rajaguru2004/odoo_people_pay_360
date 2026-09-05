import { E2EContext } from './e2e-app';
import {
  setupPayrollFixtures,
  PayrollFixtures,
  Period,
  seedAttendance,
  workingDatesIn,
} from './payroll-fixtures';

/**
 * The Payroll EDGE-CASE fixture set.
 *
 * Layered on `setupPayrollFixtures`, which already supplies three branches
 * (including an Oman one), monthly / daily-wage / no-bank / migration-candidate
 * / terminated employees, seven users including a branch-scoped HR and a
 * supervisor, banks, banking-field config, attendance for its own period, and
 * FK-ordered teardown. None of that is rebuilt here.
 *
 * What this adds is the populations Phase 4 had no reason to create — the ones
 * whose employment or attendance does NOT span the period, which is where the
 * expensive defects were found:
 *
 *   • a joiner whose start date falls inside the period
 *   • a leaver whose end date falls inside it
 *   • an employee with NO attendance captured at all
 *   • an employee with no attendance AND approved leave — the G25 shape
 *
 * ## Periods
 *
 * Phase 4's fixtures own 6/2032 and step forward from it. This set works two
 * years later so the two cannot collide even when both suites run in the same
 * database: a payroll run claims rows for its whole branch and period, so two
 * suites sharing a month is not a slow test, it is a wrong one.
 */
export interface PayrollEdgeFixtures {
  base: PayrollFixtures;

  /** The period these fixtures seed attendance for. */
  period: Period;
  /** `period` shifted by n months, for a second or third run. */
  periodAt: (offset: number) => Period;

  /** ACTIVE, employed all period, attendance fully captured. The control. */
  fullMonthEmpId: string;
  /** ACTIVE, employed all period, NO attendance captured at all (the F36 shape). */
  noAttendanceEmpId: string;
  /** No attendance captured AND one day of approved PAID leave (the G25 shape). */
  leaveNoAttendanceEmpId: string;
  /** Start date falls on the last working day of `period`. */
  joinerEmpId: string;
  /** End date falls mid-period. */
  leaverEmpId: string;

  /** The working day the joiner starts on, and the leaver's last day. */
  joinerStartsOn: Date;
  leaverEndsOn: Date;

  cleanup: () => Promise<void>;
}

/** Working days of `period` that are NOT Sundays, as the base fixtures define them. */
function lastWorkingDate(period: Period): Date {
  const dates = workingDatesIn(period);
  return dates[dates.length - 1];
}

export async function setupPayrollEdgeFixtures(
  ctx: E2EContext,
): Promise<PayrollEdgeFixtures> {
  const { prisma } = ctx;
  const base = await setupPayrollFixtures(ctx);

  // Two years clear of the base set's 6/2032.
  const period: Period = { month: 6, year: 2034 };
  const periodAt = (offset: number): Period => {
    const zero = period.year * 12 + (period.month - 1) + offset;
    return { month: (zero % 12) + 1, year: Math.floor(zero / 12) };
  };

  const periodStart = new Date(Date.UTC(period.year, period.month - 1, 1));
  const joinerStartsOn = lastWorkingDate(period);
  const leaverEndsOn = workingDatesIn(period)[5];

  const suffix = `edge${Date.now()}`;
  // Shaped like `mkEmployee` in the base fixtures, including `idCard`, which is
  // required and unique. Typed `any` for the same reason that one is: the
  // generated Prisma create type is a union that a spread cannot satisfy.
  const mk = async (
    tag: string,
    extra: Record<string, any> = {},
  ): Promise<string> => {
    const data: any = {
      employeeCode: `EDG-${tag}-${suffix}`.slice(0, 30),
      fullName: `Edge ${tag} ${suffix}`,
      dateOfBirth: new Date('1990-01-01'),
      idCard: `EDG-ID-${tag}-${suffix}`,
      email: `edge.${tag}.${suffix}@test.local`,
      departmentId: base.deptId,
      branchId: base.branchA,
      position: 'Tester',
      // Employed well before the period unless a case overrides it.
      startDate: new Date('2020-01-01'),
      baseSalary: 1500,
      salaryType: 'MONTHLY',
      status: 'ACTIVE',
      ...extra,
    };
    const row = await prisma.employee.create({ data, select: { id: true } });
    return row.id;
  };

  const fullMonthEmpId = await mk('full');
  const noAttendanceEmpId = await mk('noatt');
  const leaveNoAttendanceEmpId = await mk('lvnoatt');
  const joinerEmpId = await mk('joiner', { startDate: joinerStartsOn });
  const leaverEmpId = await mk('leaver', { endDate: leaverEndsOn });

  // Only the control gets attendance. The others are deliberately uncaptured —
  // that gap IS the subject of the cases built on this set.
  await seedAttendance(prisma, [fullMonthEmpId], base.branchA, period);

  // One day of approved PAID leave, with no attendance captured. Before the fix
  // this combination cost the employee ~95% of the month, because approving
  // leave writes attendance rows and those rows made the missing-attendance
  // protection switch off.
  const paidLeaveDay = workingDatesIn(period)[7];
  const leave = await prisma.leaveRequest.create({
    data: {
      employeeId: leaveNoAttendanceEmpId,
      leaveType: 'ANNUAL',
      startDate: paidLeaveDay,
      endDate: paidLeaveDay,
      totalDays: 1,
      reason: 'edge fixtures: a single paid day',
      status: 'APPROVED',
    },
    select: { id: true },
  });
  // The row approving leave would have written. Created explicitly so the
  // fixture does not depend on the approval endpoint's side effects.
  await prisma.attendance.createMany({
    data: [
      {
        employeeId: leaveNoAttendanceEmpId,
        branchId: base.branchA,
        date: paidLeaveDay,
        status: 'LEAVE',
        workHours: 0,
        source: 'LEAVE',
      },
    ],
    skipDuplicates: true,
  });

  const ids = [
    fullMonthEmpId,
    noAttendanceEmpId,
    leaveNoAttendanceEmpId,
    joinerEmpId,
    leaverEmpId,
  ];

  return {
    base,
    period,
    periodAt,
    fullMonthEmpId,
    noAttendanceEmpId,
    leaveNoAttendanceEmpId,
    joinerEmpId,
    leaverEmpId,
    joinerStartsOn,
    leaverEndsOn,
    cleanup: async () => {
      // FK order: payroll items before payrolls, attendance and leave before
      // employees, employees before the base set's departments and branches.
      await prisma.payrollItem.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.payroll.deleteMany({
        where: { branchId: base.branchA, year: { gte: 2034 } },
      });
      await prisma.attendance.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: ids } } });
      await prisma.employee.deleteMany({ where: { id: { in: ids } } });
      await base.cleanup();
      void leave;
      void periodStart;
    },
  };
}
