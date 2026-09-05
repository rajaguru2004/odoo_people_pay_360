import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupPayrollEdgeFixtures,
  PayrollEdgeFixtures,
} from './utils/payroll-edge-fixtures';
import { bearer } from './utils/payroll-fixtures';
import { withSettings } from './utils/settings';

/**
 * `PE-CAL` — the payroll calendar, and `PE-VAL` — the pre-run checklist.
 *
 * A new prefix for the calendar because it is not a RUN: it is a configuration
 * object with its own lifecycle, the same reason `PE-BANK` owns the WPS
 * pre-flight matrix rather than `PE-RUN`.
 *
 * The property that matters most is the one asserted first: a branch with no
 * calendar behaves EXACTLY as it does today, so turning this on for one branch
 * cannot change what any other branch pays.
 */
describe('Payroll edge — calendar and pre-run validation (PE-CAL, PE-VAL)', () => {
  let ctx: E2EContext;
  let fx: PayrollEdgeFixtures;

  const api = () => ctx.http();
  const admin = () => bearer(fx.base.admin.token);
  const branch = () => fx.base.branchA;

  const ON = { payroll_calendar_enabled: 'true', payroll_preflight_enabled: 'true' };

  const saveCalendar = (body: Record<string, unknown>) =>
    api()
      .post('/payroll-calendars')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ branchId: branch(), ...body });

  const preflight = (body: Record<string, unknown>) =>
    api()
      .post('/payrolls/preflight')
      .set(admin())
      .set('X-Branch-Id', branch())
      .send({ branchId: branch(), ...body });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPayrollEdgeFixtures(ctx);
  }, 180_000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  afterEach(async () => {
    await ctx.prisma.payrollCalendar.deleteMany({ where: { branchId: branch() } });
  });

  describe('PE-CAL-01..06 — the calendar', () => {
    it('PE-CAL-01: with no calendar the window is the calendar month, exactly', async () => {
      // The whole additive argument. `payrolls.service.ts` computes this window
      // inline in six places; if the two ever disagree, money moves.
      const res = await api()
        .get(`/payroll-calendars/window?branchId=${branch()}&month=6&year=2044`)
        .set(admin())
        .set('X-Branch-Id', branch());
      expect(res.status).toBe(200);
      expect(res.body.data.fromCalendar).toBe(false);
      expect(String(res.body.data.periodStart)).toContain('2044-06-01');
      expect(String(res.body.data.periodEnd)).toContain('2044-06-30');
      expect(res.body.data.cutOffDate).toBeNull();
    }, 60_000);

    it('PE-CAL-02: generates a whole year from a cut-off and a pay day', async () => {
      await withSettings(ctx, ON, async () => {
        const res = await saveCalendar({ year: 2044, cutOffDay: 25, paymentDay: 28 });
        expect(res.status).toBe(201);
        // Whole-year at a time: a calendar with three of twelve months set is
        // worse than none, because an unconfigured month behaves differently
        // from its neighbours without saying so.
        expect(res.body.data.periods).toHaveLength(12);
      });
    }, 60_000);

    it('PE-CAL-03: every generated period satisfies the database constraints', async () => {
      // A calendar that cannot be saved is worse than one that is approximate,
      // so generation clamps rather than producing an invalid date.
      await withSettings(ctx, ON, async () => {
        const res = await saveCalendar({ year: 2044, cutOffDay: 31, paymentDay: 1 });
        expect(res.status).toBe(201);
        for (const p of res.body.data.periods) {
          expect(new Date(p.periodEnd).getTime()).toBeGreaterThanOrEqual(new Date(p.periodStart).getTime());
          expect(new Date(p.cutOffDate).getTime()).toBeGreaterThanOrEqual(new Date(p.periodStart).getTime());
          expect(new Date(p.paymentDate).getTime()).toBeGreaterThanOrEqual(new Date(p.periodEnd).getTime());
        }
      });
    }, 60_000);

    it('PE-CAL-04: a saved calendar supplies the window', async () => {
      await withSettings(ctx, ON, async () => {
        await saveCalendar({ year: 2044, cutOffDay: 20, paymentDay: 30 });
        const res = await api()
          .get(`/payroll-calendars/window?branchId=${branch()}&month=6&year=2044`)
          .set(admin())
          .set('X-Branch-Id', branch());
        expect(res.body.data.fromCalendar).toBe(true);
        expect(String(res.body.data.cutOffDate)).toContain('2044-06-20');
      });
    }, 60_000);

    it('PE-CAL-05: replacing a year does not leave the old periods behind', async () => {
      await withSettings(ctx, ON, async () => {
        await saveCalendar({ year: 2044, cutOffDay: 20, paymentDay: 30 });
        const again = await saveCalendar({ year: 2044, cutOffDay: 10, paymentDay: 28 });
        expect(again.body.data.periods).toHaveLength(12);
        const all = await ctx.prisma.payrollCalendarPeriod.count({
          where: { calendar: { branchId: branch(), year: 2044 } },
        });
        expect(all).toBe(12);
      });
    }, 60_000);

    it('PE-CAL-06: enforcement is per PERIOD, not a global switch', async () => {
      // Deliberately a column rather than a setting: settings are global, so a
      // branch could not pilot enforcement without changing it for everyone.
      await withSettings(ctx, ON, async () => {
        const cal = await saveCalendar({ year: 2044, cutOffDay: 20, paymentDay: 30 });
        const res = await api()
          .patch(`/payroll-calendars/${cal.body.data.id}/periods/6/enforcement`)
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({ enforceCutOff: true });
        expect(res.status).toBe(200);

        const periods = await ctx.prisma.payrollCalendarPeriod.findMany({
          where: { calendarId: cal.body.data.id },
        });
        expect(periods.filter((p) => p.enforceCutOff)).toHaveLength(1);
        expect(periods.find((p) => p.month === 6)!.enforceCutOff).toBe(true);
      });
    }, 60_000);
  });

  describe('PE-VAL-01..06 — is this run safe to generate?', () => {
    it('PE-VAL-01: reports ready before any payroll exists', async () => {
      await withSettings(ctx, ON, async () => {
        const period = fx.periodAt(80);
        await ctx.prisma.attendance.createMany({
          data: [
            {
              employeeId: fx.fullMonthEmpId,
              branchId: branch(),
              date: new Date(Date.UTC(period.year, period.month - 1, 3)),
              status: 'PRESENT',
              workHours: 8,
            },
          ],
          skipDuplicates: true,
        });

        const res = await preflight({
          month: period.month,
          year: period.year,
          employeeIds: [fx.fullMonthEmpId],
        });
        expect(res.status).toBe(201);
        expect(res.body.data.total).toBe(1);
        expect(res.body.data.canGenerate).toBe(true);
      });
    }, 90_000);

    it('PE-VAL-02: writes nothing', async () => {
      await withSettings(ctx, ON, async () => {
        const period = fx.periodAt(81);
        const before = await ctx.prisma.payroll.count({ where: { branchId: branch() } });
        await preflight({ month: period.month, year: period.year });
        const after = await ctx.prisma.payroll.count({ where: { branchId: branch() } });
        expect(after).toBe(before);
      });
    }, 60_000);

    it('PE-VAL-03: BLOCKS when no attendance was captured anywhere', async () => {
      // The expensive mistake: generating pays everybody a full month.
      await withSettings(ctx, ON, async () => {
        const period = fx.periodAt(82);
        const res = await preflight({
          month: period.month,
          year: period.year,
          employeeIds: [fx.noAttendanceEmpId],
        });
        expect(res.body.data.canGenerate).toBe(false);
        expect(
          res.body.data.runFindings.map((f: any) => f.code),
        ).toContain('NO_ATTENDANCE_CAPTURED');
      });
    }, 60_000);

    it('PE-VAL-04: BLOCKS when every named employee is unknown', async () => {
      await withSettings(ctx, ON, async () => {
        const period = fx.periodAt(83);
        const res = await preflight({
          month: period.month,
          year: period.year,
          employeeIds: ['00000000-0000-4000-8000-000000000000'],
        });
        expect(res.body.data.canGenerate).toBe(false);
        expect(
          res.body.data.runFindings.map((f: any) => f.code),
        ).toContain('ALL_EMPLOYEES_UNKNOWN');
      });
    }, 60_000);

    it('PE-VAL-05: BLOCKS on a period that already has a run, and links to it', async () => {
      await withSettings(ctx, ON, async () => {
        const period = fx.periodAt(84);
        await ctx.prisma.attendance.createMany({
          data: [
            {
              employeeId: fx.fullMonthEmpId,
              branchId: branch(),
              date: new Date(Date.UTC(period.year, period.month - 1, 3)),
              status: 'PRESENT',
              workHours: 8,
            },
          ],
          skipDuplicates: true,
        });
        const created = await api()
          .post('/payrolls')
          .set(admin())
          .set('X-Branch-Id', branch())
          .send({
            month: period.month,
            year: period.year,
            employeeIds: [fx.fullMonthEmpId],
          });

        const res = await preflight({ month: period.month, year: period.year });
        expect(res.body.data.canGenerate).toBe(false);
        const finding = res.body.data.runFindings.find(
          (f: any) => f.code === 'PERIOD_ALREADY_RUN',
        );
        expect(finding).toBeDefined();
        expect(finding.fix.href).toContain(created.body.data.id);

        await api()
          .delete(`/payrolls/${created.body.data.id}`)
          .set(admin())
          .set('X-Branch-Id', branch());
      });
    }, 120_000);

    it('PE-VAL-06: a warning does not block, and is listed for acknowledgement', async () => {
      // Reporting as BLOCKING something generation would happily accept is the
      // same failure as reporting ready about a run that then refuses.
      await withSettings(ctx, ON, async () => {
        const period = fx.periodAt(85);
        await ctx.prisma.attendance.createMany({
          data: [
            {
              employeeId: fx.fullMonthEmpId,
              branchId: branch(),
              date: new Date(Date.UTC(period.year, period.month - 1, 3)),
              status: 'PRESENT',
              workHours: 8,
            },
          ],
          skipDuplicates: true,
        });

        const res = await preflight({
          month: period.month,
          year: period.year,
          employeeIds: [fx.fullMonthEmpId, fx.noAttendanceEmpId],
        });
        const d = res.body.data;
        expect(d.canGenerate).toBe(true);
        expect(d.warningEmployees).toBeGreaterThan(0);
        expect(d.requiresAcknowledgement).toContain('EMPLOYEE_ATTENDANCE_MISSING');
      });
    }, 90_000);
  });
});
