import { test, expect, ApiClient } from '../../fixtures';
import {
  clearPayrollLane,
  dateIn,
  edgePeriod,
  ensureBranchWithWeekend,
  ensureCarrier,
  ensureHoliday,
  itemsOf,
  lastDayOf,
  makeEmployee,
  marker,
  runEdgePayroll,
  seedAttendance,
  workDaysFor,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * The working calendar as configuration — the Oman half of the requirement.
 *
 * ## Why only the calendar, and not the country preset
 *
 * The catalogue asks for statutory rules to be configurable rather than
 * hardcoded, and they largely are: `SystemSettingsService` holds per-country
 * presets (OM among them) covering work hours, overtime rate, PF and tax
 * brackets. But those are **global** settings, shared by every Playwright
 * worker, and this suite runs six in parallel. Flipping one mid-run re-prices
 * every other spec's payroll — the failure lands in a file that never touched the
 * setting, which is the worst attribution failure available here.
 *
 * So the global cases sit behind `E2E_ALLOW_FLAG_FLIP=1` in the plan, and this
 * file asserts the one axis of statutory configuration that is **per-branch** and
 * therefore safe to vary in the default run: the weekly-off calendar.
 *
 * ## What it establishes
 *
 * A Gulf branch (Fri/Sat) and a Western one (Sat/Sun) produce genuinely different
 * working months — measured at 23 against 22 days for May 2044 — and payroll uses
 * the branch's own figure rather than a global one.
 *
 * The consequence is the part that reaches an employee: a fully-present MONTHLY
 * earner takes home the same either way, but **a day of absence costs more where
 * there are fewer working days**, because loss of pay is a per-day share of the
 * month. Same salary, same absence, different deduction, decided by the branch's
 * weekend.
 *
 * ## A trap worth stating
 *
 * `GET /holidays/work-days/:month/:year` takes `branchId` as a QUERY parameter.
 * Passing only the `X-Branch-Id` header returns the GLOBAL calendar with
 * `branchId: null`, and two differently-configured branches then look identical —
 * which is exactly what the first version of this file measured.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-cfg-';
const MARK = marker(MARKER_PREFIX);

/** Friday + Saturday — the Gulf working week. */
const GULF_WEEKEND = '5,6';
/** Saturday + Sunday. */
const WESTERN_WEEKEND = '0,6';

/**
 * A period whose two weekend conventions give DIFFERENT working-day counts.
 *
 * Not every month discriminates: in March 2050 both give 23, because the day
 * numbers happen to line up. Choosing a month by hand is how this case ends up
 * proving nothing, so the period is searched for rather than assumed.
 */
function findDiscriminatingPeriod(candidates: Period[]): { period: Period; gulf: number; western: number } | null {
  const workDays = (p: Period, off: number[]): number => {
    const last = lastDayOf(p);
    let offCount = 0;
    for (let d = 1; d <= last; d++) {
      if (off.includes(new Date(Date.UTC(p.year, p.month - 1, d)).getUTCDay())) offCount++;
    }
    return last - offCount;
  };
  for (const p of candidates) {
    const gulf = workDays(p, [5, 6]);
    const western = workDays(p, [0, 6]);
    if (gulf !== western) return { period: p, gulf, western };
  }
  return null;
}

test.describe('the working calendar as configuration', () => {
  let admin: ApiClient;
  let gulfBranch = '';
  let westernBranch = '';
  let gulfCarrier: TestEmployee;
  let westernCarrier: TestEmployee;
  let setupError = '';

  // Searched, not chosen — see `findDiscriminatingPeriod`.
  const CANDIDATES: Period[] = [90, 91, 92, 93, 94, 95].map((i) => edgePeriod(i));
  let chosen: { period: Period; gulf: number; western: number } | null = null;

  const P_HOLIDAY: Period = edgePeriod(96);
  // A SECOND search band for the absence case, so it never has to share a period
  // with the case above — and never has to skip. Roughly half the months in any
  // band fail to discriminate between the two weekends, so hardcoding one is how
  // this case quietly stops running.
  const ABSENCE_CANDIDATES: Period[] = [97, 98, 99, 100, 101, 102].map((i) => edgePeriod(i));
  let absencePeriod: { period: Period; gulf: number; western: number } | null = null;
  const ALL = [...CANDIDATES, P_HOLIDAY, ...ABSENCE_CANDIDATES];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      admin = await ApiClient.as('admin');
      chosen = findDiscriminatingPeriod(CANDIDATES);
      absencePeriod = findDiscriminatingPeriod(ABSENCE_CANDIDATES);

      gulfBranch = await ensureBranchWithWeekend(
        admin,
        'E2E-PAY-GULF',
        'Payroll Edge — Gulf week (Fri/Sat)',
        GULF_WEEKEND,
      );
      westernBranch = await ensureBranchWithWeekend(
        admin,
        'E2E-PAY-WEST',
        'Payroll Edge — Western week (Sat/Sun)',
        WESTERN_WEEKEND,
      );
      gulfCarrier = await ensureCarrier(admin, gulfBranch, `${MARK}-gulf`);
      westernCarrier = await ensureCarrier(admin, westernBranch, `${MARK}-west`);

      await clearPayrollLane(admin, gulfBranch, ALL);
      await clearPayrollLane(admin, westernBranch, ALL);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await clearPayrollLane(admin, gulfBranch, ALL).catch(() => undefined);
    await clearPayrollLane(admin, westernBranch, ALL).catch(() => undefined);
    await admin?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'payroll is ADMIN/HR territory');
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      expect(
        chosen,
        'no period in the allocated band gives Fri/Sat and Sat/Sun different working-day ' +
          'counts — widen CANDIDATES rather than asserting on a month that cannot discriminate',
      ).toBeTruthy();
    });

    test('two branches, one month, two different working weeks', async () => {
      const gulf = await workDaysFor(admin, gulfBranch, chosen!.period);
      const western = await workDaysFor(admin, westernBranch, chosen!.period);

      expect(gulf.branchId, 'the breakdown is scoped to the branch that was asked for').toBeTruthy();
      expect(western.branchId, 'and so is the other').toBeTruthy();

      // Compared against an INDEPENDENT calculation, not against each other only:
      // two wrong figures can still differ.
      expect(gulf.workDays, 'the Gulf branch works its own week').toBe(chosen!.gulf);
      expect(western.workDays, 'and the Western branch works its own').toBe(chosen!.western);
      expect(gulf.workDays, 'and they genuinely differ for this month').not.toBe(western.workDays);

      expect(gulf.totalDays, 'both are looking at the same calendar month').toBe(western.totalDays);
      expect(
        gulf.workDays + gulf.weekends,
        'and every day is either worked or a weekend, with no holidays in play',
      ).toBe(gulf.totalDays);
    });

    test('payroll uses the branch’s own calendar, not a global one', async () => {
      const period = chosen!.period;

      const gulfEmployee = await makeEmployee(admin, {
        marker: `${MARK}-gulf-emp`,
        branchId: gulfBranch,
        baseSalary: 1500,
      });
      const westernEmployee = await makeEmployee(admin, {
        marker: `${MARK}-west-emp`,
        branchId: westernBranch,
        baseSalary: 1500,
      });

      const gulfRun = await runEdgePayroll(admin, {
        branchId: gulfBranch,
        period,
        employeeIds: [gulfEmployee.id],
        carrier: gulfCarrier,
      });
      const westernRun = await runEdgePayroll(admin, {
        branchId: westernBranch,
        period,
        employeeIds: [westernEmployee.id],
        carrier: westernCarrier,
      });

      const g = (await itemsOf(admin, gulfRun.id, gulfBranch)).find((i) => i.employeeId === gulfEmployee.id)!;
      const w = (await itemsOf(admin, westernRun.id, westernBranch)).find((i) => i.employeeId === westernEmployee.id)!;

      expect(g.workDays, 'the Gulf payslip carries the Gulf working month').toBe(chosen!.gulf);
      expect(w.workDays, 'the Western payslip carries the Western one').toBe(chosen!.western);

      // A fully-present MONTHLY earner is paid their salary either way — which is
      // correct, and is why the working-day count looks harmless until someone is
      // absent.
      expect(g.netSalary, 'a fully-present monthly earner takes home the same in both')
        .toBe(w.netSalary);
    });

    test('the same single absence costs MORE where the working month is shorter', async () => {
      // The consequence that reaches an employee. Loss of pay is a per-day share
      // of the month, so the same one day off is worth 1/22 of salary in one
      // branch and 1/23 in the other — identical people, identical absence,
      // different deduction, decided entirely by the branch's weekend.
      expect(
        absencePeriod,
        'no period in ABSENCE_CANDIDATES gives the two weekends different working-day ' +
          'counts — widen the band rather than letting this case skip, because it is the ' +
          'one that shows what the calendar costs an employee',
      ).toBeTruthy();
      const local = absencePeriod!;
      const period = local.period;
      await clearPayrollLane(admin, gulfBranch, [period]);
      await clearPayrollLane(admin, westernBranch, [period]);

      const shortWeek = local.gulf < local.western ? 'gulf' : 'western';
      const shortBranch = shortWeek === 'gulf' ? gulfBranch : westernBranch;
      const longBranch = shortWeek === 'gulf' ? westernBranch : gulfBranch;
      const shortCarrier = shortWeek === 'gulf' ? gulfCarrier : westernCarrier;
      const longCarrier = shortWeek === 'gulf' ? westernCarrier : gulfCarrier;
      const shortDays = Math.min(local.gulf, local.western);
      const longDays = Math.max(local.gulf, local.western);

      const mk = async (branchId: string, tag: string) =>
        makeEmployee(admin, { marker: `${MARK}-${tag}`, branchId, baseSalary: 1500 });

      const shortEmp = await mk(shortBranch, 'short');
      const longEmp = await mk(longBranch, 'long');

      // Each works every day of their own month except ONE, marked absent.
      const workingDays = (p: Period, off: number[]) => {
        const out: number[] = [];
        for (let d = 1; d <= lastDayOf(p); d++) {
          if (!off.includes(new Date(Date.UTC(p.year, p.month - 1, d)).getUTCDay())) out.push(d);
        }
        return out;
      };
      const shortOff = shortWeek === 'gulf' ? [5, 6] : [0, 6];
      const longOff = shortWeek === 'gulf' ? [0, 6] : [5, 6];

      const seedAllBut = async (branchId: string, id: string, days: number[]) => {
        const absent = days[3];
        await seedAttendance(admin, branchId, id, days.filter((d) => d !== absent).map((d) => dateIn(period, d)));
        await seedAttendance(admin, branchId, id, [dateIn(period, absent)], { status: 'ABSENT' });
      };
      await seedAllBut(shortBranch, shortEmp.id, workingDays(period, shortOff));
      await seedAllBut(longBranch, longEmp.id, workingDays(period, longOff));

      const shortRun = await runEdgePayroll(admin, {
        branchId: shortBranch,
        period,
        employeeIds: [shortEmp.id],
        carrier: shortCarrier,
      });
      const longRun = await runEdgePayroll(admin, {
        branchId: longBranch,
        period,
        employeeIds: [longEmp.id],
        carrier: longCarrier,
      });

      const s = (await itemsOf(admin, shortRun.id, shortBranch)).find((i) => i.employeeId === shortEmp.id)!;
      const l = (await itemsOf(admin, longRun.id, longBranch)).find((i) => i.employeeId === longEmp.id)!;

      expect(s.workDays, 'the short month is the short one').toBe(shortDays);
      expect(l.workDays, 'and the long month is the long one').toBe(longDays);
      expect(s.actualWorkDays, 'each lost exactly one day').toBe(shortDays - 1);
      expect(l.actualWorkDays, 'each lost exactly one day').toBe(longDays - 1);

      expect(
        s.netSalary,
        `one day off costs MORE in a ${shortDays}-day month than in a ${longDays}-day one — ` +
          'same salary, same absence, different branch calendar',
      ).toBeLessThan(l.netSalary);

      await clearPayrollLane(admin, gulfBranch, [period]);
      await clearPayrollLane(admin, westernBranch, [period]);
    });

    test('a public holiday shortens the working month for that branch alone', async () => {
      // Branch-scoped holidays are the other half of the configurable calendar,
      // and the isolation is the point: a national day in one branch must not
      // shorten another branch's month.
      const before = await workDaysFor(admin, gulfBranch, P_HOLIDAY);
      const otherBefore = await workDaysFor(admin, westernBranch, P_HOLIDAY);

      // Pick a day that is a WORKING day in the Gulf branch, or the holiday
      // changes nothing and the case proves nothing.
      let day = 0;
      for (let d = 1; d <= lastDayOf(P_HOLIDAY); d++) {
        const dow = new Date(Date.UTC(P_HOLIDAY.year, P_HOLIDAY.month - 1, d)).getUTCDay();
        if (![5, 6].includes(dow)) {
          day = d;
          break;
        }
      }
      expect(day, 'the period has at least one Gulf working day').toBeGreaterThan(0);

      await ensureHoliday(admin, dateIn(P_HOLIDAY, day), `${MARK} branch national day`, {
        branchId: gulfBranch,
      });

      const after = await workDaysFor(admin, gulfBranch, P_HOLIDAY);
      const otherAfter = await workDaysFor(admin, westernBranch, P_HOLIDAY);

      expect(after.holidays, 'the branch now has a holiday').toBeGreaterThan(before.holidays);
      expect(after.workDays, 'and one fewer working day').toBe(before.workDays - 1);
      expect(
        otherAfter.workDays,
        'while the other branch is untouched — a branch holiday is not a company holiday',
      ).toBe(otherBefore.workDays);
    });
  });
});
