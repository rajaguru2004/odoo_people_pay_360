import { test, expect, ApiClient } from '../../fixtures';
import {
  clearPayrollLane,
  dateIn,
  edgePeriod,
  ensureCarrier,
  ensureHoliday,
  ensurePayrollEdgeBranch,
  fileAttendanceCorrection,
  itemsOf,
  lockPayroll,
  marker,
  pastEdgePeriod,
  runEdgePayroll,
  seedAttendance,
  seedLeave,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * Attendance, where it meets payroll.
 *
 * ## The rule everything here turns on
 *
 * `actualWorkDays` is derived from attendance rows, and the engine draws a hard
 * line between two states that look the same from a distance:
 *
 *   • **no rows at all** → the employee is treated as FULLY PRESENT and the item
 *     carries a note saying so. This is Phase 4's F36 fix: missing data is not
 *     evidence of absence, and reading it as absence once paid an employee zero
 *     while the rest of the run looked normal.
 *   • **some rows** → the employee is paid for exactly the days those rows show,
 *     and every uncovered working day is loss of pay.
 *
 * The gap between those two states is where this module's sharpest edges live —
 * including G25, which belongs to the leave file but is caused here.
 *
 * ## Two catalogue cases resolve differently than they are written
 *
 * **"Duplicate attendance records"** cannot be produced. `Attendance` is
 * `@@unique([employeeId, date])`, so a repeat write is an UPSERT — no 409, no
 * second row. The honest assertion is that the second write REPLACED the first,
 * which is what this file checks.
 *
 * **"Attendance corrections after payroll approval"** must run in the PAST band:
 * `attendance-corrections.service.ts` refuses any correction dated after today,
 * so the far-future lane cannot host one. See `PAYROLL_EDGE_PAST_YEARS`.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-att-';
const MARK = marker(MARKER_PREFIX);

function weekdaysIn(p: Period): number[] {
  const out: number[] = [];
  const last = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(p.year, p.month - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

test.describe('attendance against payroll', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  const P_MISSING: Period = edgePeriod(40);
  const P_ABSENT: Period = edgePeriod(41);
  const P_UPSERT: Period = edgePeriod(42);
  const P_HOLIDAY: Period = edgePeriod(43);
  const P_CORRECTION: Period = pastEdgePeriod(3); // corrections cannot be dated forward
  const ALL = [P_MISSING, P_ABSENT, P_UPSERT, P_HOLIDAY, P_CORRECTION];

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

    test('an employee with NO attendance rows is paid in full, and the item says why', async () => {
      // F36, asserted from the side that matters: the figure is safe AND the gap
      // is visible. A run that silently paid these employees in full with no note
      // would be indistinguishable from one where attendance really was complete.
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-missing`,
        branchId,
        baseSalary: 1500,
      });
      // Only the twin gets rows; the subject gets none at all.
      await seedAttendance(
        admin,
        branchId,
        twin.id,
        weekdaysIn(P_MISSING).map((d) => dateIn(P_MISSING, d)),
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_MISSING,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(s.actualWorkDays, 'no rows is treated as fully present').toBe(s.workDays);
      expect(s.netSalary, 'so the pay matches the colleague who was fully present').toBe(t.netSalary);
      expect(s.notes ?? '', 'and the item flags the missing data for whoever reviews the run')
        .toMatch(/no attendance was captured/i);
      expect(t.notes ?? '', 'while the colleague with real rows carries no such flag')
        .not.toMatch(/no attendance was captured/i);
    });

    test('days marked ABSENT cost pay, in proportion', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-absent`,
        branchId,
        baseSalary: 1500,
      });
      const days = weekdaysIn(P_ABSENT);
      const absent = days.slice(3, 6);

      await seedAttendance(admin, branchId, twin.id, days.map((d) => dateIn(P_ABSENT, d)));
      await seedAttendance(
        admin,
        branchId,
        subject.id,
        days.filter((d) => !absent.includes(d)).map((d) => dateIn(P_ABSENT, d)),
      );
      await seedAttendance(admin, branchId, subject.id, absent.map((d) => dateIn(P_ABSENT, d)), {
        status: 'ABSENT',
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_ABSENT,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(s.actualWorkDays, 'three absences are three fewer worked days')
        .toBe(t.actualWorkDays - absent.length);

      const perDay = t.netSalary / t.workDays;
      const lost = t.netSalary - s.netSalary;
      expect(lost, 'and cost about three days of pay').toBeGreaterThan(perDay * absent.length * 0.85);
      expect(lost, 'and not appreciably more').toBeLessThan(perDay * absent.length * 1.15);
      expect(s.notes ?? '', 'the payslip names the loss in days').toMatch(
        new RegExp(`Loss of Pay \\(LOP\\): ${absent.length} day`, 'i'),
      );
    });

    test('a duplicate attendance write UPSERTS — the record cannot be doubled', async () => {
      // The catalogue asks about "duplicate attendance records". They are not
      // reachable: `@@unique([employeeId, date])` makes the second write replace
      // the first. What IS worth asserting is that the replacement happened and
      // that pay reflects the LAST write, not the first — a silent no-op would be
      // just as wrong and would look identical from the outside.
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-upsert`,
        branchId,
        baseSalary: 1500,
      });
      const days = weekdaysIn(P_UPSERT);
      const contested = days[4];

      await seedAttendance(admin, branchId, twin.id, days.map((d) => dateIn(P_UPSERT, d)));
      await seedAttendance(admin, branchId, subject.id, days.map((d) => dateIn(P_UPSERT, d)));

      // Same employee, same date, written twice — first PRESENT, then ABSENT.
      await seedAttendance(admin, branchId, subject.id, [dateIn(P_UPSERT, contested)], {
        status: 'ABSENT',
        notes: 'e2e: the second write wins',
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_UPSERT,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(
        s.actualWorkDays,
        'the day was counted ONCE, and as the second write left it — not twice, and not as the first',
      ).toBe(t.actualWorkDays - 1);
    });

    test('a public holiday is not a working day, and does not cost anyone pay', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-holiday`,
        branchId,
        baseSalary: 1500,
      });
      const days = weekdaysIn(P_HOLIDAY);
      const holiday = days[6];

      await ensureHoliday(admin, dateIn(P_HOLIDAY, holiday), `${MARK} national day`, { branchId });

      // Neither employee works the holiday; the twin works every other day, and so
      // does the subject. Nobody should lose anything for a day the company was shut.
      const worked = days.filter((d) => d !== holiday).map((d) => dateIn(P_HOLIDAY, d));
      await seedAttendance(admin, branchId, twin.id, worked);
      await seedAttendance(admin, branchId, subject.id, worked);

      // The subject additionally takes approved PAID leave on the holiday itself —
      // the catalogue's "public holiday overlaps with leave". It must be counted
      // once, as a holiday, and cost nothing.
      await seedLeave(
        admin,
        branchId,
        subject.id,
        'ANNUAL',
        dateIn(P_HOLIDAY, holiday),
        dateIn(P_HOLIDAY, holiday),
        { reason: `${MARK} leave landing on a holiday` },
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_HOLIDAY,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(s.netSalary, 'leave landing on a public holiday costs nothing extra').toBe(t.netSalary);
      expect(s.actualWorkDays, 'and the day is not double-counted against them')
        .toBe(t.actualWorkDays);
    });

    test('a correction approved after the run is APPROVED does not move the run', async () => {
      // Runs in the PAST band: a correction cannot be dated after today.
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-corr`,
        branchId,
        baseSalary: 1500,
      });
      const days = weekdaysIn(P_CORRECTION);
      const late = days[5];

      await seedAttendance(admin, branchId, twin.id, days.map((d) => dateIn(P_CORRECTION, d)));
      await seedAttendance(admin, branchId, subject.id, days.map((d) => dateIn(P_CORRECTION, d)));
      // The subject's clock-in on one day was recorded late.
      await seedAttendance(admin, branchId, subject.id, [dateIn(P_CORRECTION, late)], {
        checkIn: '11:30',
        checkOut: '17:00',
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_CORRECTION,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});

      const approved = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;

      // The correction lands after approval — the catalogue's case. Approving it
      // rewrites the ATTENDANCE row, which is the point: the question is whether
      // the already-approved payroll follows it. It must not.
      const day = dateIn(P_CORRECTION, late);
      await fileAttendanceCorrection(
        admin,
        branchId,
        subject.id,
        day,
        { requestedCheckIn: `${day}T09:00:00.000Z`, requestedCheckOut: `${day}T17:00:00.000Z` },
        { reason: `${MARK} device missed the real clock-in` },
      );

      const after = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      expect(after.netSalary, 'an approved run does not silently follow a later correction')
        .toBe(approved.netSalary);
      expect(after.actualWorkDays, 'nor do its days').toBe(approved.actualWorkDays);

      // And once locked it is final in the same way.
      await lockPayroll(admin, run.id);
      const locked = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      expect(locked.netSalary, 'and locking changes nothing either').toBe(approved.netSalary);
    });
  });
});
