import { test, expect, settle, ApiClient } from '../../fixtures';
import { PayrollDetailPage } from '../../pages';
import { selectBranch } from '../../pages';
import {
  asList,
  clearPayrollLane,
  dateIn,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  itemsOf,
  lockPayroll,
  makeEmployee,
  marker,
  runEdgePayroll,
  seedAttendance,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * The nine "Payroll Processing" edge cases, driven end to end.
 *
 * ## What this file is for
 *
 * A payroll run is the one operation in this product that turns records into
 * money leaving a bank account, and it is not undoable in the way an ordinary
 * CRUD write is — an unlock is a *compensating* action, not an erase. So the
 * guards around generating one are the highest-value assertions in the module,
 * and each of them is asserted on the SERVER'S OWN SENTENCE rather than on a
 * status code: a 409 tells a user nothing, and the string is the only part of a
 * refusal they can act on. That lesson is `docs/LOAN-ADVANCES-TEST-CASES.md`'s,
 * paid for by a production incident.
 *
 * ## Two behaviours here are worth knowing before reading the cases
 *
 * **Regenerating over a LOCKED run is refused as a DUPLICATE, not as a lock.**
 * The message is "Payroll for M/YYYY already exists", the same one an unlocked
 * duplicate gets. That is defensible — the period is occupied either way — but it
 * means the lock is not what the user is told about, and a spec that expected the
 * word "locked" would be asserting a message the product never sends.
 *
 * **An empty run is created, not refused.** A branch with no ACTIVE employees, an
 * `employeeIds: []`, and an `employeeIds` naming only unknown ids all answer
 * **201** with a DRAFT run of zero items and `totalAmount: 0`. Recorded as G23
 * rather than asserted as correct.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-run-';
const MARK = marker(MARKER_PREFIX);

/** The message the server uses for an occupied period. */
const OCCUPIED = /Payroll for \d+\/\d+ already exists/i;

test.describe('payroll run guards', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  // One period per case: a leftover run from one must never decide another's
  // outcome, and every case here is ABOUT what a period already holds.
  const P_POPULATION: Period = edgePeriod(10);
  const P_DUPLICATE: Period = edgePeriod(11);
  const P_PARALLEL: Period = edgePeriod(12);
  const P_LOCKED: Period = edgePeriod(13);
  const P_PARTIAL: Period = edgePeriod(14);
  const P_EMPTY: Period = edgePeriod(15);
  const P_ADJUSTMENT: Period = edgePeriod(16);
  const P_FUTURE: Period = edgePeriod(17);
  const ALL = [
    P_POPULATION, P_DUPLICATE, P_PARALLEL, P_LOCKED,
    P_PARTIAL, P_EMPTY, P_ADJUSTMENT, P_FUTURE,
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
      test.skip(!isProject('admin'), 'generating payroll is ADMIN/HR territory');
      expect(setupError, `setup failed: ${setupError}`).toBe('');
    });

    // ── who a run picks up ────────────────────────────────────────────────

    test('an INACTIVE and a TERMINATED employee are both left out of the run', async () => {
      const active = await makeEmployee(admin, {
        marker: `${MARK}-pop-active`,
        branchId,
        baseSalary: 1500,
      });
      const inactive = await makeEmployee(admin, {
        marker: `${MARK}-pop-inactive`,
        branchId,
        baseSalary: 1500,
      });
      const terminated = await makeEmployee(admin, {
        marker: `${MARK}-pop-terminated`,
        branchId,
        baseSalary: 1500,
      });

      // The two exit states are DIFFERENT records and the distinction is
      // counter-intuitive: every soft-exit path in `employees.service.ts` writes
      // INACTIVE on the Employee, while TERMINATED is a CONTRACT status that the
      // Employee row can also carry. Both populations are driven, because a rule
      // proven for one is not proven for the other.
      await admin.patch(`/employees/${inactive.id}`, { status: 'INACTIVE' });
      await admin.patch(`/employees/${terminated.id}`, { status: 'TERMINATED' });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_POPULATION,
        employeeIds: [active.id, inactive.id, terminated.id],
        carrier,
      });

      const items = await itemsOf(admin, run.id);
      const paid = new Set(items.map((i) => i.employeeId));

      expect(paid.has(active.id), 'the ACTIVE employee was paid').toBe(true);
      expect(paid.has(inactive.id), 'an INACTIVE employee is not paid').toBe(false);
      expect(paid.has(terminated.id), 'a TERMINATED employee is not paid').toBe(false);
      // Named explicitly: three ids were asked for and two were dropped in
      // silence. That is the right outcome and the wrong ergonomics, and a future
      // reader should not mistake the silence for the ids never having been sent.
      expect(items.length, 'only the carrier and the ACTIVE employee have items').toBe(2);
    });

    // ── the same period twice ─────────────────────────────────────────────

    test('a second run for the same period and branch is refused, and says which period', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-dup`,
        branchId,
        baseSalary: 1500,
      });
      await runEdgePayroll(admin, {
        branchId,
        period: P_DUPLICATE,
        employeeIds: [subject.id],
        carrier,
      });

      const second = await admin
        .withBranch(branchId)
        .post('/payrolls', {
          month: P_DUPLICATE.month,
          year: P_DUPLICATE.year,
          employeeIds: [subject.id],
        })
        .then(() => null)
        .catch((e: Error) => e.message);

      expect(second, 'the second run for an occupied period was refused').toBeTruthy();
      expect(second, 'and the refusal names the period').toMatch(OCCUPIED);
      expect(
        String(second),
        'the refusal is a sentence, not a bare status word',
      ).not.toMatch(/could not be completed|invalid input|something went wrong/i);
    });

    test('two SIMULTANEOUS creates leave exactly one run behind', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-par`,
        branchId,
        baseSalary: 1500,
      });
      // Open the period first, so the two racers are refused for the reason under
      // test rather than for missing attendance.
      await seedAttendance(admin, branchId, carrier.id, [dateIn(P_PARALLEL, 1)]);

      const body = {
        month: P_PARALLEL.month,
        year: P_PARALLEL.year,
        employeeIds: [carrier.id, subject.id],
      };
      const scoped = admin.withBranch(branchId);
      const settled = await Promise.allSettled([
        scoped.post('/payrolls', body),
        scoped.post('/payrolls', body),
      ]);

      const won = settled.filter((r) => r.status === 'fulfilled').length;
      const lost = settled.filter((r) => r.status === 'rejected');

      // This is the assertion that a duplicate-period INDEX exists at all. Phase 4
      // found (F30) that the e2e template database had none, because the real one
      // is an EXPRESSION index over COALESCE(...) that `prisma db push` cannot
      // create — so two simultaneous creates both returned 201 and a period could
      // be paid twice. Read a failure here as "the index is missing again", not as
      // a flaky race.
      expect(won, 'exactly one create won').toBe(1);
      expect(lost.length, 'exactly one create lost').toBe(1);
      expect(
        (lost[0] as PromiseRejectedResult).reason?.message ?? '',
        'the loser was told the period is taken',
      ).toMatch(OCCUPIED);

      const stored = await admin
        .withBranch(branchId)
        .get<unknown>(`/payrolls?year=${P_PARALLEL.year}`);
      const rows = (Array.isArray(stored) ? stored : ((stored as { data?: unknown[] })?.data ?? []))
        .filter(
          (r) =>
            (r as { month: number }).month === P_PARALLEL.month &&
            (r as { branchId?: string }).branchId === branchId,
        );
      expect(rows.length, 'and the database holds one run for the period, not two').toBe(1);
    });

    // ── a run that has already been locked ────────────────────────────────

    test('a LOCKED run cannot be regenerated over, deleted, or edited', async ({ page, problems }) => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-lock`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_LOCKED,
        employeeIds: [subject.id],
        carrier,
      });

      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});
      await lockPayroll(admin, run.id);

      // 1. Regenerating over it is refused, and the refusal NAMES THE LOCK and
      //    the way out (G24). It used to give the generic occupied-period
      //    sentence, which sent the reader looking for a run to delete — and
      //    deleting is the one thing a locked run does not allow.
      const regen = await admin
        .withBranch(branchId)
        .post('/payrolls', {
          month: P_LOCKED.month,
          year: P_LOCKED.year,
          employeeIds: [subject.id],
        })
        .then(() => null)
        .catch((e: Error) => e.message);
      expect(regen, 'regenerating over a locked period is refused').toBeTruthy();
      expect(regen, 'and the refusal names the lock').toMatch(/is LOCKED/i);
      expect(regen, 'and names the remedy, which is a revision').toMatch(/create a revision/i);

      // 2. Deleting it is refused, and THIS one does name the lock.
      const del = await admin
        .withBranch(branchId)
        .delete(`/payrolls/${run.id}`)
        .then(() => null)
        .catch((e: Error) => e.message);
      expect(del, 'a locked run cannot be deleted').toBeTruthy();
      expect(del, 'and the refusal names the lock').toMatch(/locked/i);

      // 3. The screen agrees: LOCKED, no submit, no lock, and a revision offered
      //    as the only way forward.
      await selectBranch(page, branchId);
      const detail = new PayrollDetailPage(page);
      await detail.open(run.id);
      await detail.expectStatus('LOCKED');
      expect(await detail.canSubmit(), 'a locked run is not submittable').toBe(false);
      expect(await detail.canLock(), 'a locked run is not lockable again').toBe(false);
      expect(await detail.canRevise(), 'a revision is the only way to correct it').toBe(true);
      settle(problems, 'the locked payroll detail screen');
    });

    // ── partial and empty runs ────────────────────────────────────────────

    test('a partial run covers the employees it was given and nobody else', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-part`,
        branchId,
        baseSalary: 1500,
      });
      const excluded = await makeEmployee(admin, {
        marker: `${MARK}-part-excluded`,
        branchId,
        baseSalary: 1500,
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_PARTIAL,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const paid = new Set((await itemsOf(admin, run.id)).map((i) => i.employeeId));

      expect(paid.has(subject.id), 'a named employee is in the run').toBe(true);
      expect(paid.has(twin.id), 'so is the other one').toBe(true);
      expect(
        paid.has(excluded.id),
        'an ACTIVE employee of the same branch who was NOT named stays out',
      ).toBe(false);
    });

    test('G23 FIXED: a run naming only unknown employees is REFUSED, and says how many missed', async () => {
      // The pin this replaces recorded a 201 with a DRAFT run of zero items and
      // totalAmount 0. What made that expensive was not the empty run but what
      // it hid: the run-level attendance guard is skipped when the population is
      // empty (`employees.length > 0` is one of its conditions), so "payroll
      // produced nothing" and "payroll was never given anyone" were
      // indistinguishable on screen. An operator who mistyped a filter got a
      // clean, approvable, zero-value payroll rather than a refusal.
      const refusal = await admin
        .withBranch(branchId)
        .post('/payrolls', {
          month: P_EMPTY.month,
          year: P_EMPTY.year,
          employeeIds: ['00000000-0000-0000-0000-000000000000'],
        })
        .then(() => null)
        .catch((e: Error) => e.message);

      expect(refusal, 'the run is refused rather than created empty').toBeTruthy();
      expect(refusal, 'and the refusal counts what was selected').toMatch(
        /None of the 1 selected employee/i,
      );
      expect(refusal, 'and states plainly that nothing was created').toMatch(
        /Payroll was not created/i,
      );

      // Nothing was left behind to approve. Filtered client-side because the
      // list endpoint takes no month/year query — `forbidNonWhitelisted` turns
      // an invented filter into a 400 rather than ignoring it.
      const runs = asList(await admin.withBranch(branchId).get<unknown>('/payrolls'));
      const forPeriod = runs.filter(
        (r) =>
          Number((r as { month: number }).month) === P_EMPTY.month &&
          Number((r as { year: number }).year) === P_EMPTY.year,
      );
      expect(forPeriod.length, 'and no run exists for the period').toBe(0);
    });

    // ── re-running after a statutory change ───────────────────────────────

    test('an ADJUSTMENT run is a separate run type, and the period still allows only one of each', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-adj`,
        branchId,
        baseSalary: 1500,
      });

      const regular = await runEdgePayroll(admin, {
        branchId,
        period: P_ADJUSTMENT,
        employeeIds: [subject.id],
        carrier,
      });
      expect(regular.id, 'the REGULAR run exists').toBeTruthy();

      // The catalogue asks for "payroll rerun after statutory adjustments". The
      // product's answer is `runType`, and the period index does NOT include it —
      // it is (month, year, branch, batch, version). So a second run for the same
      // period is refused whatever its type, and the way to re-run after a
      // statutory change is a REVISION of the existing run, not a new one.
      const adjustment = await admin
        .withBranch(branchId)
        .post('/payrolls', {
          month: P_ADJUSTMENT.month,
          year: P_ADJUSTMENT.year,
          runType: 'ADJUSTMENT',
          employeeIds: [subject.id],
        })
        .then(() => null)
        .catch((e: Error) => e.message);

      expect(
        adjustment,
        'an ADJUSTMENT run for an occupied period is refused like any other',
      ).toBeTruthy();
      expect(adjustment, 'with the same occupied-period sentence').toMatch(OCCUPIED);
    });

    // ── input validation, asserted on the message ─────────────────────────

    test('the create endpoint judges its own payload, in words', async () => {
      const scoped = admin.withBranch(branchId);
      const attempt = (body: Record<string, unknown>) =>
        scoped
          .post('/payrolls', body)
          .then(() => '')
          .catch((e: Error) => e.message);

      expect(
        await attempt({ month: 13, year: P_FUTURE.year }),
        'a thirteenth month is refused by name',
      ).toMatch(/month must not be greater than 12/i);

      expect(
        await attempt({ month: 0, year: P_FUTURE.year }),
        'and so is a zeroth',
      ).toMatch(/month/i);

      expect(
        await attempt({ month: 1, year: 2019 }),
        'a year before the product existed is refused by name',
      ).toMatch(/year must not be less than 2020/i);

      expect(
        await attempt({ month: P_FUTURE.month, year: P_FUTURE.year, runType: 'NOT_A_TYPE' }),
        'an unknown run type is refused and the valid set is listed',
      ).toMatch(/runType must be one of the following values[\s\S]*FINAL_SETTLEMENT/i);
    });

    test('a run with no branch selected is refused, and the message says what to do', async () => {
      // Payroll is per-branch by design; the header is the whole selection. The
      // sentence matters more than the code here, because the fix is a UI action
      // the user has to take.
      const noBranch = await ApiClient.as('admin');
      const failed = await noBranch
        .post('/payrolls', { month: P_FUTURE.month, year: P_FUTURE.year })
        .then(() => '')
        .catch((e: Error) => e.message);
      await noBranch.dispose();

      expect(failed, 'the run was refused').toBeTruthy();
      expect(failed, 'and the refusal tells the operator to choose a branch').toMatch(
        /select a specific branch/i,
      );
      expect(failed, 'and says why').toMatch(/per-branch/i);
    });

    test('a far-future period is allowed — the product has no cut-off concept to refuse it with', async () => {
      // Recorded as behaviour, not as approval. `Payroll` carries only `month` and
      // `year`; there is no payroll calendar, no cut-off date and no "open period"
      // state, so nothing exists that COULD refuse a period years ahead. See
      // `docs/PAYROLL-GAP-REPORT.md` §2. The only constraint is the DTO's floor of
      // year >= 2020.
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-fut`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_FUTURE,
        employeeIds: [subject.id],
        carrier,
      });
      expect(run.status, 'a run two decades out is an ordinary DRAFT').toBe('DRAFT');
      const items = await itemsOf(admin, run.id);
      expect(items.length, 'and it pays people').toBeGreaterThan(0);
    });
  });
});
