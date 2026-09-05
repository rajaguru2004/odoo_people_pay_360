import { test, expect, ApiClient } from '../../fixtures';
import {
  addComponent,
  auditFor,
  clearPayrollLane,
  dateIn,
  edgePeriod,
  ensureCarrier,
  ensureHoliday,
  ensurePayrollEdgeBranch,
  fileAttendanceCorrection,
  historyOf,
  itemsOf,
  lastDayOf,
  lockPayroll,
  marker,
  pastEdgePeriod,
  retireComponent,
  runEdgePayroll,
  seedAttendance,
  seedLeave,
  seedOvertime,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * The fixtures prove themselves, before anything is built on them.
 *
 * Phase 4 did this with `payroll-fixtures.smoke.e2e-spec.ts` and the reason
 * holds here: every later spec in this family reads a figure off a payroll item
 * and asserts something about it. If `seedLeave` silently files a request nobody
 * approved, or `seedOvertime` posts a claim the run does not pick up, those
 * specs do not fail — they PASS, having asserted that an input which never
 * arrived had no effect. A green suite would then mean nothing at all.
 *
 * So each helper is exercised once here, and the assertion is always the same
 * shape: **the input reached the payslip**. Nothing below tests payroll; it
 * tests that this file can put payroll in a known state.
 *
 * ## The twin
 *
 * `twinPair` creates two employees identical in everything that pays. The twin
 * has nothing done to it, so its net IS the net the subject would have had, and
 * every assertion here is a difference between the two. That is what keeps this
 * file silent about PF rates, tax brackets and work-day counts — none of which
 * it should have an opinion on.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-fx-';
const MARK = marker(MARKER_PREFIX);

test.describe('payroll-edge fixtures', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  // Each case takes its own period, so a leftover run from one cannot decide
  // another's figures.
  const P_BASE: Period = edgePeriod(0);
  const P_LEAVE: Period = edgePeriod(1);
  const P_OT: Period = edgePeriod(2);
  const P_COMPONENT: Period = edgePeriod(3);
  // The correction case lives in the PAST band: attendance corrections are
  // refused for any date after today, so a 2044 period cannot host one. See
  // `PAYROLL_EDGE_PAST_YEARS`.
  const P_CORRECTION: Period = pastEdgePeriod(0);
  const ALL_PERIODS = [P_BASE, P_LEAVE, P_OT, P_COMPONENT, P_CORRECTION];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      admin = await ApiClient.as('admin');
      branchId = await ensurePayrollEdgeBranch(admin);
      // One carrier for the whole file. It holds the attendance row that opens
      // each period and is never asserted on — see `runEdgePayroll`.
      carrier = await ensureCarrier(admin, branchId, MARK);
      // Start from an empty lane: these periods are far enough out that nothing
      // else reaches them, but a previous run of THIS file will have.
      await clearPayrollLane(admin, branchId, ALL_PERIODS);
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    await clearPayrollLane(admin, branchId, ALL_PERIODS).catch(() => undefined);
    await admin?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'the fixtures are driven as ADMIN');
    });

    test('the lane exists: a branch of its own, in a year nothing else uses', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      expect(branchId, 'ensurePayrollEdgeBranch returned a branch').toBeTruthy();
      expect(P_BASE.year).toBeGreaterThanOrEqual(2044);
    });

    test('twinPair produces two employees a run pays identically', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-base`,
        branchId,
        baseSalary: 1500,
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_BASE,
        employeeIds: [subject.id, twin.id],
        carrier,
      });

      const items = await itemsOf(admin, run.id);
      // Three, not two: the carrier rides along to open the period. It is the
      // reason the other two can be compared at all — see `runEdgePayroll`.
      expect(items, 'the run covered the carrier and the two measured employees').toHaveLength(3);

      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;
      expect(s, 'the subject has an item').toBeTruthy();
      expect(t, 'the twin has an item').toBeTruthy();

      // The whole point of the twin: with nothing done to either, they agree.
      // If this ever fails, no money assertion in this family is trustworthy.
      //
      // The first version of this case DID fail — 70.89 against 1488.75 — because
      // `runPayroll` opens a closed period by booking one attendance day for
      // `employeeIds[0]`, and an employee WITH rows is paid for the days those
      // rows show while an employee with NONE is treated as fully present. List
      // position alone decided a 21x difference in pay. `runEdgePayroll` and the
      // carrier exist because of this line.
      expect(s.netSalary, 'an untouched subject and twin are paid the same').toBe(t.netSalary);
      expect(s.netSalary, 'a paid employee is not paid zero').toBeGreaterThan(0);
    });

    test('seedAttendance reaches the payslip: absent days cost a MONTHLY earner pay', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-att`,
        branchId,
        baseSalary: 1500,
      });

      // The subject is marked ABSENT for three working days. The twin has no
      // attendance rows at all, which the engine treats as fully present (F36) —
      // so the twin is still the clean baseline.
      await seedAttendance(
        admin,
        branchId,
        subject.id,
        [dateIn(P_LEAVE, 4), dateIn(P_LEAVE, 5), dateIn(P_LEAVE, 6)],
        { status: 'ABSENT' },
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_LEAVE,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(
        s.actualWorkDays,
        'the absent days were counted: the subject worked fewer days than the twin',
      ).toBeLessThan(t.actualWorkDays);
      expect(s.netSalary, 'and was therefore paid less').toBeLessThan(t.netSalary);
    });

    test('seedOvertime reaches the payslip as overtime pay', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-ot`,
        branchId,
        baseSalary: 1500,
      });

      const day = dateIn(P_OT, 8);
      await seedOvertime(
        admin,
        branchId,
        subject.id,
        day,
        `${day}T18:00:00.000Z`,
        `${day}T21:00:00.000Z`,
        3,
      );

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_OT,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      // Asserted as "more than the twin", never as a computed figure: what a
      // policy pays for three evening hours is the overtime engine's business,
      // and re-deriving it here would only pin this environment's config.
      expect(s.overtimeHours, 'the approved claim reached the run').toBeGreaterThan(0);
      expect(s.overtimePay, 'and was priced').toBeGreaterThan(0);
      expect(t.overtimePay, 'the twin claimed nothing and was paid nothing extra').toBe(0);
      expect(s.netSalary, 'so the subject took home more').toBeGreaterThan(t.netSalary);
    });

    test('addComponent reaches the payslip as an allowance, and retiring it removes it', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-cmp`,
        branchId,
        baseSalary: 1500,
      });

      const componentId = await addComponent(admin, subject.id, 'TRANSPORT', 120, {
        effectiveDate: dateIn(P_COMPONENT, 1),
        note: `${MARK} transport`,
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_COMPONENT,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(s.allowances - t.allowances, 'the component arrived at its full amount').toBe(120);
      expect(s.netSalary, 'and was paid').toBeGreaterThan(t.netSalary);

      // Retire it and re-run the same period: the allowance is gone. This is the
      // half that proves `retireComponent` does something — a helper that
      // silently no-ops would leave every later "component removed" case green
      // for the wrong reason.
      await retireComponent(admin, componentId);
      await clearPayrollLane(admin, branchId, [P_COMPONENT]);

      const rerun = await runEdgePayroll(admin, {
        branchId,
        period: P_COMPONENT,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const after = await itemsOf(admin, rerun.id);
      const s2 = after.find((i) => i.employeeId === subject.id)!;
      const t2 = after.find((i) => i.employeeId === twin.id)!;
      expect(s2.allowances - t2.allowances, 'the retired component is no longer paid').toBe(0);
    });

    test('seedLeave files AND approves — an unapproved request would be invisible', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-lv`,
        branchId,
        baseSalary: 1500,
      });

      const id = await seedLeave(
        admin,
        branchId,
        subject.id,
        'UNPAID',
        dateIn(P_LEAVE, 11),
        dateIn(P_LEAVE, 12),
        { reason: `${MARK} unpaid leave` },
      );
      expect(id, 'a leave request was created').toBeTruthy();

      const raw = await admin.get<unknown>(`/leave-requests/${id}`);
      const req = (raw as { data?: { status?: string } })?.data ?? (raw as { status?: string });
      expect(
        req.status,
        'seedLeave approved it — payroll only ever reads APPROVED leave',
      ).toBe('APPROVED');
    });

    test('ensureHoliday and lastDayOf agree with the calendar the run uses', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const day = lastDayOf(P_BASE);
      const id = await ensureHoliday(admin, dateIn(P_BASE, day), `${MARK} founders day`, {
        branchId,
      });
      expect(id, 'the holiday was created on this branch').toBeTruthy();

      const raw = await admin.get<unknown>(`/holidays/work-days/${P_BASE.month}/${P_BASE.year}`);
      expect(raw, 'the work-days endpoint answers for this period').toBeTruthy();
    });

    test('fileAttendanceCorrection upserts the day it names', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-corr`,
        branchId,
        baseSalary: 1500,
      });

      const day = dateIn(P_CORRECTION, 9);
      await seedAttendance(admin, branchId, subject.id, [day], {
        checkIn: '10:30',
        checkOut: '17:00',
      });

      const id = await fileAttendanceCorrection(
        admin,
        branchId,
        subject.id,
        day,
        { requestedCheckIn: `${day}T09:00:00.000Z`, requestedCheckOut: `${day}T17:00:00.000Z` },
        { reason: `${MARK} arrived on time, device missed it` },
      );
      expect(id, 'a correction was filed and approved').toBeTruthy();
    });

    test('a locked run leaves a history trail and an audit row', async () => {
      expect(setupError, `setup failed: ${setupError}`).toBe('');
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-audit`,
        branchId,
        baseSalary: 1500,
      });

      const period = edgePeriod(5);
      await clearPayrollLane(admin, branchId, [period]);
      const run = await runEdgePayroll(admin, {
        branchId,
        period: period,
        employeeIds: [subject.id],
        carrier,
      });

      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});
      await lockPayroll(admin, run.id);

      const history = await historyOf(admin, run.id);
      expect(history.length, 'the run reports its own approval trail').toBeGreaterThan(0);
      // Named steps, which is what makes the trail useful — and the contrast
      // with the audit log below is the whole point of this case.
      const steps = history.map((h) => h.action);
      expect(steps, 'the trail names the transitions it reconstructed').toContain('LOCKED');

      const audit = await auditFor(admin, 'Payroll', run.id);
      expect(audit.length, 'and the audit log holds rows for it').toBeGreaterThan(0);

      // Payroll writes NAMED verbs for its lifecycle transitions (G1, fixed), so
      // the trail can say which transition each row was. The global
      // `AuditInterceptor` still contributes its own HTTP-derived `CREATE` row
      // alongside them, which is why this asserts the named verbs are PRESENT
      // rather than that they are the only ones.
      const actions = new Set(audit.map((r) => r.action));
      for (const verb of ['PAYROLL_SUBMITTED', 'PAYROLL_APPROVED', 'PAYROLL_LOCKED']) {
        expect(
          actions.has(verb),
          `the trail names ${verb}; saw ${[...actions].join(', ')}`,
        ).toBe(true);
      }

      await clearPayrollLane(admin, branchId, [period]);
    });
  });
});
