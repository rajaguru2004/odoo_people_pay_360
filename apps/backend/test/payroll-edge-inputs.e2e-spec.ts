import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';

/**
 * `PE-IN` — the attendance and leave seams, over HTTP, against a real database.
 *
 * The browser suite drives these through the app; this file asserts the same
 * rules where they are cheapest to state exhaustively, and pins the arithmetic
 * that two production-shaped defects turned on:
 *
 *   • **G25** — approving leave WRITES attendance rows (`source: 'LEAVE'`), and
 *     counting them as "attendance was processed" switched off the protection
 *     for employees whose attendance was never captured. One day of PAID leave
 *     cost ~95% of a month.
 *   • **G31** — payroll had no concept of an employment start date, so a joiner
 *     was paid a full month for one day of employment, or was told they had lost
 *     22 days to "absence" on days before they were hired.
 *
 * Both are fixed. These cases assert the fixed behaviour and would fail if
 * either regressed.
 *
 * Money is asserted as a RELATIONSHIP to a control employee — never as a
 * hard-coded net — so the suite survives any change to this environment's tax,
 * PF or ESI configuration.
 */
describe('Payroll edge — the input seams (PE-IN)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);

  /**
   * Opens a period so a run can be generated for it.
   *
   * `PayrollsService.create()` refuses a period in which NOBODY in the run has an
   * attendance row — without that guard, missing data would read as absence and
   * loss of pay would wipe the whole payroll. The fixtures seed attendance for
   * `fx.period` only, so any case using a LATER period has to open it first, or
   * it fails with a 400 about attendance rather than on its own subject.
   *
   * One row for one employee is enough; everyone else in the run keeps no rows
   * and is treated as fully present, which is what keeps net a clean function of
   * `baseSalary`.
   */
  const openPeriod = async (employeeId: string, period: { month: number; year: number }) => {
    await ctx.prisma.attendance.createMany({
      data: [
        {
          employeeId,
          branchId: fx.base.branchA,
          date: new Date(Date.UTC(period.year, period.month - 1, 3)),
          status: 'PRESENT',
          workHours: 8,
        },
      ],
      skipDuplicates: true,
    });
  };

  /** Generates a run for the edge period covering exactly these employees. */
  const runFor = async (employeeIds: string[], period = fx.period) => {
    const res = await api()
      .post('/payrolls')
      .set(admin())
      .set('X-Branch-Id', fx.base.branchA)
      .send({ month: period.month, year: period.year, employeeIds });
    return res;
  };

  const itemsOf = async (payrollId: string) => {
    const res = await api()
      .get(`/payrolls/${payrollId}`)
      .set(admin())
      .set('X-Branch-Id', fx.base.branchA);
    const payroll = res.body?.data ?? res.body;
    return (payroll.items ?? []) as Array<Record<string, any>>;
  };

  const num = (v: unknown) => Number(v ?? 0);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  describe('PE-IN-01..05 — attendance capture and the missing-data guard', () => {
    let items: Array<Record<string, any>>;
    let control: Record<string, any>;

    beforeAll(async () => {
      const res = await runFor([
        fx.fullMonthEmpId,
        fx.noAttendanceEmpId,
        fx.leaveNoAttendanceEmpId,
        fx.joinerEmpId,
      ]);
      expect(res.status).toBe(201);
      items = await itemsOf(res.body?.data?.id ?? res.body?.id);
      control = items.find((i) => i.employeeId === fx.fullMonthEmpId)!;
    });

    it('PE-IN-01: the control is paid for a full, fully-captured month', () => {
      expect(control).toBeDefined();
      expect(num(control.actualWorkDays)).toBe(num(control.workDays));
      expect(num(control.netSalary)).toBeGreaterThan(0);
    });

    it('PE-IN-02: an employee with NO attendance is treated as fully present, and flagged', () => {
      // F36. Missing data is not absence — reading it as absence once paid an
      // employee zero while the rest of the run looked entirely normal.
      const row = items.find((i) => i.employeeId === fx.noAttendanceEmpId)!;
      expect(num(row.actualWorkDays)).toBe(num(row.workDays));
      expect(num(row.netSalary)).toBe(num(control.netSalary));
      expect(String(row.notes ?? '')).toMatch(/no attendance was captured/i);
    });

    it('PE-IN-03: G25 — a LEAVE-sourced row is not evidence that attendance was captured', () => {
      // The employee has exactly one attendance row and the system wrote it when
      // the leave was approved. Before the fix that row made the guard believe
      // attendance had been processed, so the other ~21 uncaptured days became
      // loss of pay and the employee was paid 67.67 instead of 1488.75.
      const row = items.find((i) => i.employeeId === fx.leaveNoAttendanceEmpId)!;
      expect(num(row.netSalary)).toBe(num(control.netSalary));
      expect(String(row.notes ?? '')).toMatch(/no attendance was captured/i);
      expect(String(row.notes ?? '')).not.toMatch(/Loss of Pay \(LOP\)/i);
    });

    it('PE-IN-04: G31 — a joiner is paid for the days they were employed', () => {
      const row = items.find((i) => i.employeeId === fx.joinerEmpId)!;
      // The working MONTH is still the branch calendar — proration flows through
      // loss of pay, because base pay is the full monthly rate with LOP taken
      // off. Shrinking `workDays` would pay a one-day joiner a full month.
      expect(num(row.workDays)).toBe(num(control.workDays));
      expect(num(row.actualWorkDays)).toBe(1);
      expect(num(row.netSalary)).toBeLessThan(num(control.netSalary) / 5);
      expect(num(row.netSalary)).toBeGreaterThan(0);
    });

    it('PE-IN-05: G31 — days before the hire date are not described as absence', () => {
      const row = items.find((i) => i.employeeId === fx.joinerEmpId)!;
      expect(String(row.notes ?? '')).toMatch(/Employed for 1 of \d+ working day\(s\)/i);
      expect(String(row.notes ?? '')).toMatch(/not absence/i);
      expect(String(row.notes ?? '')).not.toMatch(/Loss of Pay \(LOP\)/i);
    });
  });

  describe('PE-IN-10..12 — leave that arrives after the run', () => {
    it('PE-IN-10: leave approved after a run does not change it', async () => {
      const period = fx.periodAt(1);
      await openPeriod(fx.fullMonthEmpId, period);
      const created = await runFor([fx.fullMonthEmpId], period);
      expect(created.status).toBe(201);
      const id = created.body?.data?.id ?? created.body?.id;
      const before = (await itemsOf(id)).find(
        (i) => i.employeeId === fx.fullMonthEmpId,
      )!;

      await ctx.prisma.leaveRequest.create({
        data: {
          employeeId: fx.fullMonthEmpId,
          leaveType: 'UNPAID',
          startDate: new Date(Date.UTC(period.year, period.month - 1, 10)),
          endDate: new Date(Date.UTC(period.year, period.month - 1, 12)),
          totalDays: 3,
          reason: 'PE-IN-10: filed behind the run',
          status: 'APPROVED',
        },
      });

      const after = (await itemsOf(id)).find(
        (i) => i.employeeId === fx.fullMonthEmpId,
      )!;
      // A run is a snapshot. Leave approved behind it belongs to the next run or
      // to a revision, never retroactively to a figure already produced.
      expect(num(after.netSalary)).toBe(num(before.netSalary));
      expect(num(after.actualWorkDays)).toBe(num(before.actualWorkDays));
    });

    it('PE-IN-11: a second run for the same period is refused, naming the period', async () => {
      const period = fx.periodAt(1);
      const again = await runFor([fx.fullMonthEmpId], period);
      expect(again.status).toBe(409);
      expect(String(again.body?.message ?? '')).toMatch(
        new RegExp(`Payroll for ${period.month}/${period.year} already exists`, 'i'),
      );
    });

    it('PE-IN-12: the refusal is a sentence, not a bare status word', async () => {
      const period = fx.periodAt(1);
      const again = await runFor([fx.fullMonthEmpId], period);
      const msg = String(again.body?.message ?? '');
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toMatch(/could not be completed|invalid input|something went wrong/i);
    });
  });
});
