import { test, expect, ApiClient } from '../../fixtures';
import {
  clearPayrollLane,
  dateIn,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  itemsOf,
  lastDayOf,
  makeEmployee,
  marker,
  pastEdgePeriod,
  runEdgePayroll,
  seedAttendance,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * Joining, leaving, and the settlement run.
 *
 * ## Why this file lives in the PAST band
 *
 * Every case here turns on an employment date, and `POST /employees` refuses a
 * `startDate` more than 180 days ahead — *"Start date cannot be more than 180
 * days in the future"* (G30). The 2044–2049 lane buys isolation and costs
 * realism; anything recording a real-world event has to run in
 * `PAYROLL_EDGE_PAST_YEARS`, as attendance corrections already do.
 *
 * ## The finding: payroll does not know when someone joined
 *
 * `workDaysFor()` is computed per BRANCH, never per employee's tenure, and
 * nothing in `create()` consults `startDate`. Measured consequences, both wrong,
 * in opposite directions:
 *
 *   • a joiner with **no attendance captured** is paid a **FULL MONTH** for one
 *     day of employment — the F36 "treat as fully present" rule again;
 *   • the same joiner **with** their one day captured is paid the right money
 *     (one day) but the payslip explains it as `Loss of Pay (LOP): 22 day(s)
 *     deducted` — twenty-two days of "absence" on days the person did not work
 *     there. That is a sentence an employee disputes and HR cannot defend.
 *
 * Both are pinned as **G31**. When proration by tenure lands, both cases fail and
 * say what to change.
 *
 * ## What FINAL_SETTLEMENT actually is here
 *
 * A run type, and nothing more: there is no EOSB calculation, no gratuity
 * accrual, no service-years arithmetic and no settlement statement
 * (`docs/PAYROLL-GAP-REPORT.md` §1 — the schema says outright *"This is not an
 * F&F module"*). So this file asserts that the run type round-trips and behaves
 * like an ordinary run otherwise, and does not pretend to cover a final
 * settlement the product does not compute.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-settle-';
const MARK = marker(MARKER_PREFIX);

/** The last MONDAY-to-FRIDAY day of a period — a joiner's realistic first day. */
function lastWeekdayOf(p: Period): number {
  let d = lastDayOf(p);
  while ([0, 6].includes(new Date(Date.UTC(p.year, p.month - 1, d)).getUTCDay())) d--;
  return d;
}

function weekdaysIn(p: Period): number[] {
  const out: number[] = [];
  for (let d = 1; d <= lastDayOf(p); d++) {
    const dow = new Date(Date.UTC(p.year, p.month - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

test.describe('joiners, leavers and settlement runs', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  const P_JOINER_BLIND: Period = pastEdgePeriod(10);
  const P_JOINER_SEEN: Period = pastEdgePeriod(11);
  const P_SETTLEMENT: Period = pastEdgePeriod(12);
  const P_INACTIVE: Period = pastEdgePeriod(13);
  const P_INACTIVE_REGULAR: Period = pastEdgePeriod(14);
  const ALL = [
    P_JOINER_BLIND,
    P_JOINER_SEEN,
    P_SETTLEMENT,
    P_INACTIVE,
    P_INACTIVE_REGULAR,
  ];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      admin = await ApiClient.as('admin');
      branchId = await ensurePayrollEdgeBranch(admin);
      carrier = await ensureCarrier(admin, branchId, MARK);
      await clearPayrollLane(admin, branchId, ALL);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await clearPayrollLane(admin, branchId, ALL).catch(() => undefined);
    await admin?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'payroll is ADMIN/HR territory');
      expect(setupError, `setup failed: ${setupError}`).toBe('');
    });

    test('G31 FIXED: a joiner with no captured attendance is paid for their employed days only', async () => {
      // Payroll had no concept of an employment start date. `workDaysFor()` is
      // per BRANCH, so a joiner and a colleague of ten years were given the same
      // working month — and with no attendance captured, F36's "treat as fully
      // present" rule paid the joiner a FULL MONTH for one day of employment.
      // Measured before the fix: 1488.75, identical to the veteran.
      //
      // Fixed by `workDaysWithinEmployment()`: the missing-attendance fallback is
      // capped at the working days inside the employment dates.
      const joinDay = lastWeekdayOf(P_JOINER_BLIND);
      const joiner = await makeEmployee(admin, {
        marker: `${MARK}-joiner-blind`,
        branchId,
        baseSalary: 1500,
        startDate: dateIn(P_JOINER_BLIND, joinDay),
      });
      const veteran = await makeEmployee(admin, {
        marker: `${MARK}-veteran`,
        branchId,
        baseSalary: 1500,
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_JOINER_BLIND,
        employeeIds: [joiner.id, veteran.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const j = items.find((i) => i.employeeId === joiner.id)!;
      const v = items.find((i) => i.employeeId === veteran.id)!;

      expect(v.actualWorkDays, 'the veteran is employed all period and fully present')
        .toBe(v.workDays);
      expect(j.workDays, 'the working MONTH is still the branch calendar for both').toBe(v.workDays);

      expect(j.actualWorkDays, 'the joiner is credited only the days they were employed').toBe(1);
      expect(
        j.netSalary,
        'so someone employed for ONE day is no longer paid what a colleague of years is paid',
      ).toBeLessThan(v.netSalary / 5);
      expect(j.netSalary, 'but is still paid something').toBeGreaterThan(0);

      expect(j.notes ?? '', 'the item explains the short month as employment dates').toMatch(
        /Employed for 1 of \d+ working day\(s\)/i,
      );
      expect(
        j.notes ?? '',
        'and does NOT blame days before the hire date on loss of pay',
      ).not.toMatch(/Loss of Pay \(LOP\)/i);
    });

    test('G31 FIXED: with attendance captured, the money is right AND the reason is honest', async () => {
      // The other half. The amount was already defensible — one day worked, one
      // day paid — but the payslip explained it as `Loss of Pay (LOP): 22 day(s)
      // deducted`: twenty-two days of "absence" on days the person was not
      // employed. That is a sentence an employee disputes and HR cannot defend.
      const joinDay = lastWeekdayOf(P_JOINER_SEEN);
      const joiner = await makeEmployee(admin, {
        marker: `${MARK}-joiner-seen`,
        branchId,
        baseSalary: 1500,
        startDate: dateIn(P_JOINER_SEEN, joinDay),
      });
      const veteran = await makeEmployee(admin, {
        marker: `${MARK}-veteran-seen`,
        branchId,
        baseSalary: 1500,
      });

      await seedAttendance(admin, branchId, joiner.id, [dateIn(P_JOINER_SEEN, joinDay)]);
      await seedAttendance(
        admin,
        branchId,
        veteran.id,
        weekdaysIn(P_JOINER_SEEN).map((d) => dateIn(P_JOINER_SEEN, d)),
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_JOINER_SEEN,
        employeeIds: [joiner.id, veteran.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const j = items.find((i) => i.employeeId === joiner.id)!;
      const v = items.find((i) => i.employeeId === veteran.id)!;

      expect(j.actualWorkDays, 'one day worked').toBe(1);
      expect(j.netSalary, 'and roughly one day of pay — unchanged by the fix')
        .toBeLessThan(v.netSalary / 5);

      expect(j.notes ?? '', 'the payslip now states the employment window').toMatch(
        /Employed for 1 of \d+ working day\(s\).*not absence/i,
      );
      expect(
        j.notes ?? '',
        'and no longer claims 22 days of loss of pay for days before the hire date',
      ).not.toMatch(/Loss of Pay \(LOP\)/i);
    });

    test('a FINAL_SETTLEMENT run round-trips as its own run type', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-fs`,
        branchId,
        baseSalary: 1500,
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_SETTLEMENT,
        employeeIds: [subject.id],
        carrier,
        runType: 'FINAL_SETTLEMENT',
      });

      const full = await admin.withBranch(branchId).get<unknown>(`/payrolls/${run.id}`);
      const payroll = ((full as { data?: Record<string, unknown> })?.data ?? full) as {
        runType: string;
        status: string;
      };

      expect(payroll.runType, 'the run type is stored, not silently normalised').toBe(
        'FINAL_SETTLEMENT',
      );
      expect(payroll.status, 'and it is an ordinary DRAFT otherwise').toBe('DRAFT');

      // What it is NOT: there is no gratuity, no service-years figure and no
      // settlement statement — `PayrollItem` has no column that could carry one.
      // See `docs/PAYROLL-GAP-REPORT.md` §1.
      const item = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      expect(item.netSalary, 'the employee is simply paid, as in any other run').toBeGreaterThan(0);
    });

    test('G32 FIXED: a settlement run REACHES an employee already made INACTIVE', async () => {
      // The pin this replaces recorded the opposite, and it was the most
      // expensive exclusion in the module: a FINAL_SETTLEMENT run is where "pay
      // them what they are owed and close the file" happens, and every soft-exit
      // path in the product writes `INACTIVE` on the employee. So the one run
      // type that exists to settle a leaver could not reach one — the only
      // working order was settle first, deactivate second, which no screen said.
      //
      // A settlement run now admits INACTIVE staff, and only when the run NAMES
      // its population: an untargeted FINAL_SETTLEMENT would otherwise sweep up
      // every former employee the branch ever had. The REGULAR run type is
      // unchanged, which the next case proves.
      const leaver = await makeEmployee(admin, {
        marker: `${MARK}-leaver`,
        branchId,
        baseSalary: 1500,
      });
      const staying = await makeEmployee(admin, {
        marker: `${MARK}-staying`,
        branchId,
        baseSalary: 1500,
      });
      await admin.patch(`/employees/${leaver.id}`, { status: 'INACTIVE' });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_INACTIVE,
        employeeIds: [leaver.id, staying.id],
        carrier,
        runType: 'FINAL_SETTLEMENT',
      });
      const paid = new Set((await itemsOf(admin, run.id)).map((i) => i.employeeId));

      expect(paid.has(staying.id), 'the active colleague is paid').toBe(true);
      expect(
        paid.has(leaver.id),
        'and the leaver is reachable by the run type that exists to settle them',
      ).toBe(true);
    });

    test('and a REGULAR run still leaves that same INACTIVE employee out', async () => {
      // The other half of G32, and the reason the fix is scoped to the run type
      // rather than to the status: widening the population for every run would
      // have quietly put every former employee back on the monthly payroll.
      const leaver = await makeEmployee(admin, {
        marker: `${MARK}-reg-leaver`,
        branchId,
        baseSalary: 1500,
      });
      const staying = await makeEmployee(admin, {
        marker: `${MARK}-reg-staying`,
        branchId,
        baseSalary: 1500,
      });
      await admin.patch(`/employees/${leaver.id}`, { status: 'INACTIVE' });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_INACTIVE_REGULAR,
        employeeIds: [leaver.id, staying.id],
        carrier,
      });
      const paid = new Set((await itemsOf(admin, run.id)).map((i) => i.employeeId));

      expect(paid.has(staying.id), 'the active colleague is paid').toBe(true);
      expect(paid.has(leaver.id), 'the INACTIVE one is not').toBe(false);
    });

    test('an employee cannot be created starting more than 180 days ahead', async () => {
      // G30, asserted so the constraint is documented where it bites. It is why
      // every case in this file runs in the past band: a joiner inside the
      // 2044-2049 lane cannot be created at all.
      const far = { year: 2049, month: 6 } as Period;
      const refusal = await admin
        .post('/employees', {
          fullName: `${MARK} far-future joiner`,
          dateOfBirth: '1990-01-01',
          email: `${MARK}.far@e2e.local`,
          departmentId: (await admin.get<Array<{ id: string }>>('/departments'))[0]?.id,
          branchId,
          position: 'Tester',
          startDate: dateIn(far, 1),
          baseSalary: 1500,
          autoGenerateIdCard: true,
        })
        .then(() => '')
        .catch((e: Error) => e.message);

      expect(refusal, 'the create was refused').toBeTruthy();
      expect(refusal, 'and the rule is stated in days').toMatch(
        /start date cannot be more than 180 days in the future/i,
      );
    });
  });
});
