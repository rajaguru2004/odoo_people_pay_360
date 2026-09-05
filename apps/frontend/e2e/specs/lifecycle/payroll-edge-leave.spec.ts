import { test, expect, ApiClient } from '../../fixtures';
import {
  cancelLeave,
  clearPayrollLane,
  dateIn,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  itemsOf,
  lockPayroll,
  marker,
  runEdgePayroll,
  seedAttendance,
  seedLeave,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * Leave, where it meets payroll.
 *
 * ## How the engine actually decides loss of pay
 *
 * Established by measurement before any of these cases was written, because two
 * plausible-sounding assumptions turned out to be wrong:
 *
 *  1. `actualWorkDays` comes from ATTENDANCE rows, not from leave. Leave reduces
 *     pay only by leaving a working day uncovered.
 *  2. Approving leave WRITES attendance rows (`status: 'LEAVE'`,
 *     `source: 'LEAVE'`), so leave is not merely read at payroll time — it has
 *     already changed the attendance table by then.
 *
 * Consequence: marking a leave day PRESENT as well makes the leave invisible to
 * pay. A spec that seeds "a full month of attendance" AND leave on top measures
 * nothing at all — the first two attempts at this file did exactly that and
 * reported no effect, twice, for opposite reasons.
 *
 * So every case here seeds attendance for the working days the employee actually
 * WORKED, and leaves the leave days uncovered. That is also what really happens.
 *
 * ## The twin
 *
 * Each case runs an identical colleague who takes no leave, so the assertion is a
 * DIFFERENCE and never a hard-coded net. See `twinPair`.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-leave-';
const MARK = marker(MARKER_PREFIX);

/** Every UTC weekday in a period — the days the engine counts as working days. */
function weekdaysIn(p: Period): number[] {
  const out: number[] = [];
  const last = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(p.year, p.month - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

test.describe('leave against payroll', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  const P_LOP: Period = edgePeriod(20);
  const P_PAID: Period = edgePeriod(21);
  const P_NOATT: Period = edgePeriod(22);
  const P_LATE: Period = edgePeriod(23);
  const P_CANCEL: Period = edgePeriod(24);
  const ALL = [P_LOP, P_PAID, P_NOATT, P_LATE, P_CANCEL];

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

    test('unpaid leave costs exactly the days taken, to the cent', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-lop`,
        branchId,
        baseSalary: 1500,
      });

      const days = weekdaysIn(P_LOP);
      const leaveDays = days.slice(5, 8); // three consecutive working days
      const worked = days.filter((d) => !leaveDays.includes(d));

      // The twin works every working day; the subject works every day EXCEPT the
      // three it is on leave for. Anything else measures nothing — see the header.
      await seedAttendance(admin, branchId, twin.id, days.map((d) => dateIn(P_LOP, d)));
      await seedAttendance(admin, branchId, subject.id, worked.map((d) => dateIn(P_LOP, d)));

      await seedLeave(
        admin,
        branchId,
        subject.id,
        'UNPAID',
        dateIn(P_LOP, leaveDays[0]),
        dateIn(P_LOP, leaveDays[leaveDays.length - 1]),
        { reason: `${MARK} three unpaid days` },
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_LOP,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(t.actualWorkDays, 'the twin worked every working day').toBe(t.workDays);
      expect(
        s.actualWorkDays,
        'the subject worked three days fewer',
      ).toBe(t.actualWorkDays - leaveDays.length);

      // The arithmetic is asserted as a RATIO against the twin, so the case does
      // not depend on this environment's tax, PF or ESI configuration.
      const perDay = t.netSalary / t.workDays;
      const lost = t.netSalary - s.netSalary;
      expect(
        lost,
        `three unpaid days cost about three days of pay (${perDay.toFixed(2)}/day)`,
      ).toBeGreaterThan(perDay * leaveDays.length * 0.85);
      expect(lost, 'and not appreciably more').toBeLessThan(perDay * leaveDays.length * 1.15);

      expect(s.notes ?? '', 'and the payslip says so, in days').toMatch(
        new RegExp(`Loss of Pay \\(LOP\\): ${leaveDays.length} day`, 'i'),
      );
    });

    test('PAID leave costs nothing', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-paid`,
        branchId,
        baseSalary: 1500,
      });

      const days = weekdaysIn(P_PAID);
      const leaveDays = days.slice(4, 7);
      const worked = days.filter((d) => !leaveDays.includes(d));

      await seedAttendance(admin, branchId, twin.id, days.map((d) => dateIn(P_PAID, d)));
      await seedAttendance(admin, branchId, subject.id, worked.map((d) => dateIn(P_PAID, d)));
      await seedLeave(
        admin,
        branchId,
        subject.id,
        'ANNUAL',
        dateIn(P_PAID, leaveDays[0]),
        dateIn(P_PAID, leaveDays[leaveDays.length - 1]),
        { reason: `${MARK} three paid days` },
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_PAID,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      // The distinction between ANNUAL and UNPAID is `LibraryItem.isPaid`, read
      // at run time. This is the case that proves the engine consults it.
      expect(s.netSalary, 'paid leave leaves take-home untouched').toBe(t.netSalary);
    });

    test('G25 FIXED: a day of paid leave no longer destroys a month with no captured attendance', async () => {
      // ── Was the most serious finding in this phase; now an assertion that it
      //    cannot come back.
      //
      // F36 protects an employee whose attendance was never captured: missing
      // data is not absence, so they are treated as fully present. That
      // protection was keyed on "does this employee have ANY attendance row",
      // and approving leave WRITES rows (`status: 'LEAVE'`, `source: 'LEAVE'`).
      // So one approved holiday switched the protection off and turned every
      // uncaptured working day into loss of pay.
      //
      // Measured before the fix: 1500 base, ONE day of approved ANNUAL (paid)
      // leave, no attendance captured → **67.67 paid against 1488.75** for an
      // identical colleague, with a note reading "Loss of Pay (LOP): 21 day(s)
      // deducted" for one day of PAID leave.
      //
      // Fixed by excluding `source: 'LEAVE'` from the capture check
      // (`payrolls.service.ts`): a row the system wrote for itself is not
      // evidence that a human or a device recorded attendance.
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-noatt`,
        branchId,
        baseSalary: 1500,
      });

      // Deliberately NO attendance for either — the F36 scenario.
      //
      // The leave day MUST be a working day: `getWorkingDatesBetween` skips
      // weekends, so leave dated on a Saturday writes no attendance rows at all
      // and the case would exercise nothing. The first version of this test used
      // the 12th, which is a Sunday in this period, and passed for that reason.
      const leaveDay = weekdaysIn(P_NOATT)[7];
      await seedLeave(
        admin,
        branchId,
        subject.id,
        'ANNUAL',
        dateIn(P_NOATT, leaveDay),
        dateIn(P_NOATT, leaveDay),
        { reason: `${MARK} a single paid day` },
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_NOATT,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(t.actualWorkDays, 'the untouched twin is treated as fully present').toBe(t.workDays);
      expect(t.notes ?? '', 'and the item says why').toMatch(/no attendance was captured/i);

      // The fix, asserted: taking a day of PAID leave costs nothing.
      expect(
        s.netSalary,
        'an employee who took one day of PAID leave is paid exactly like the colleague ' +
          'who took none — the protection is no longer switched off by the leave rows ' +
          'the system writes for itself (G25)',
      ).toBe(t.netSalary);
      expect(
        s.actualWorkDays,
        'and they are still treated as fully present, because their attendance was ' +
          'never captured either',
      ).toBe(s.workDays);
      expect(s.notes ?? '', 'the missing-attendance flag still shows, so the gap is reviewable')
        .toMatch(/no attendance was captured/i);
      expect(
        s.notes ?? '',
        'and no loss of pay is claimed for a day of PAID leave',
      ).not.toMatch(/Loss of Pay \(LOP\)/i);
    });

    test('leave approved AFTER the run is generated does not change it', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-late`,
        branchId,
        baseSalary: 1500,
      });
      const days = weekdaysIn(P_LATE);
      await seedAttendance(admin, branchId, twin.id, days.map((d) => dateIn(P_LATE, d)));
      await seedAttendance(admin, branchId, subject.id, days.map((d) => dateIn(P_LATE, d)));

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_LATE,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const before = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;

      // Filed and approved after the fact. A run is a snapshot, not a live query.
      await seedLeave(
        admin,
        branchId,
        subject.id,
        'UNPAID',
        dateIn(P_LATE, days[3]),
        dateIn(P_LATE, days[4]),
        { reason: `${MARK} late-approved leave` },
      );

      const after = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      expect(
        after.netSalary,
        'an existing run is not recomputed when leave is approved behind it',
      ).toBe(before.netSalary);
      expect(after.actualWorkDays, 'nor are its days').toBe(before.actualWorkDays);
    });

    test('an ADMIN cannot cancel an employee\'s leave, and a LOCKED run is immutable anyway', async () => {
      // ── Two things at once, because the first prevents the second from being
      //    driven the way the catalogue describes it.
      //
      // The catalogue asks for "leave cancelled after payroll completion". It is
      // not reachable as written: `DELETE /leave-requests/:id` is owner-only —
      // *"You can only cancel your own requests"* — and `makeEmployee` cannot hand
      // back a login (see NO_LOGIN in `payroll-support.ts`), so no principal this
      // suite can create is able to cancel the leave it created. An ADMIN acting
      // on the employee's behalf is refused, which is the correct rule and is what
      // the first half asserts.
      //
      // The half that DOES matter for payroll is asserted directly instead: once a
      // run is LOCKED its figures are what was paid, and nothing behind it moves
      // them. Cancellation is only one of the ways that could be attempted.
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-cancel`,
        branchId,
        baseSalary: 1500,
      });
      const days = weekdaysIn(P_CANCEL);
      const leaveDays = days.slice(2, 4);
      const worked = days.filter((d) => !leaveDays.includes(d));

      await seedAttendance(admin, branchId, twin.id, days.map((d) => dateIn(P_CANCEL, d)));
      await seedAttendance(admin, branchId, subject.id, worked.map((d) => dateIn(P_CANCEL, d)));
      const leaveId = await seedLeave(
        admin,
        branchId,
        subject.id,
        'UNPAID',
        dateIn(P_CANCEL, leaveDays[0]),
        dateIn(P_CANCEL, leaveDays[leaveDays.length - 1]),
        { reason: `${MARK} to be cancelled` },
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_CANCEL,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});
      await lockPayroll(admin, run.id);

      const locked = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      expect(locked.actualWorkDays, 'the locked item carries the LOP it was paid with')
        .toBe(locked.workDays - leaveDays.length);

      // 1. The ownership rule, asserted on its sentence.
      const refusal = await cancelLeave(admin, leaveId)
        .then(() => '')
        .catch((e: Error) => e.message);
      expect(refusal, 'an ADMIN is refused the cancellation').toBeTruthy();
      expect(refusal, 'and told it is an ownership rule, not a payroll one').toMatch(
        /only cancel your own requests/i,
      );

      // 2. The locked run is unchanged — the figure a payslip already showed.
      const after = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      expect(after.netSalary, 'a locked payslip does not move').toBe(locked.netSalary);
      expect(after.actualWorkDays, 'and neither do its days').toBe(locked.actualWorkDays);

      // 3. Nor can the item be edited directly while locked — the only correction
      //    path is a revision.
      const edit = await admin
        .patch(`/payrolls/${run.id}/items/${locked.id}`, { bonus: 100 })
        .then(() => '')
        .catch((e: Error) => e.message);
      expect(edit, 'a locked item refuses an edit').toBeTruthy();
      expect(edit, 'and says the run is locked').toMatch(/lock/i);
    });
  });
});
