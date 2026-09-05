import { test, expect, ApiClient } from '../../fixtures';
import {
  clearPayrollLane,
  dateIn,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  itemsOf,
  makeEmployee,
  marker,
  runEdgePayroll,
  seedAttendance,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * Two payroll administrators at once, and a run big enough to be a real one.
 *
 * ## What the races establish
 *
 * The lifecycle has three write points that matter under concurrency, and they
 * are **not equally guarded**:
 *
 *   • **generate** — protected by a real uniqueness index. Two simultaneous
 *     creates leave exactly one run (asserted in `payroll-edge-run-guards`; Phase
 *     4's F30 found the test database had no index at all, so a period could be
 *     paid twice).
 *   • **lock** — protected. One caller wins, the other gets a 409 saying
 *     *"Payroll is no longer in a lockable state (locked or changed
 *     concurrently)"*, and the money settles exactly once.
 *   • **approve** — **not protected**. Both callers get `201 "Payroll approved"`.
 *     Recorded as G35.
 *
 * The asymmetry is the interesting part: the money-moving step is guarded and the
 * authority step is not.
 *
 * ## What the scale case is, and is not
 *
 * It is a shape check at a realistic size, not a benchmark. Measured on this
 * machine, generating a 60-employee run takes **34 ms** and locking it **18 ms** —
 * the engine is not the cost, seeding the employees over HTTP is (~62 ms each).
 * So the assertions are about correctness holding at size: every employee gets
 * exactly one item, nobody is dropped or duplicated, and the run total equals the
 * sum of the items.
 *
 * Ten thousand and a hundred thousand employees are deliberately NOT attempted —
 * they need a seeded database of their own and a run budget nobody has set. That
 * is a load-testing task with its own harness (`docs/backend-benchmark-report-*`),
 * and pretending otherwise here would produce a slow test that proves nothing.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-conc-';
const MARK = marker(MARKER_PREFIX);

/** Employees in the default scale case. Raise with PAYROLL_SCALE=1. */
const SCALE_DEFAULT = 40;
const SCALE_LARGE = 200;
const scaleSize = (): number => (process.env.PAYROLL_SCALE === '1' ? SCALE_LARGE : SCALE_DEFAULT);

test.describe('two administrators, and a run at size', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  const P_APPROVE: Period = edgePeriod(110);
  const P_LOCK: Period = edgePeriod(111);
  const P_UNLOCK: Period = edgePeriod(112);
  const P_SCALE: Period = edgePeriod(113);
  const ALL = [P_APPROVE, P_LOCK, P_UNLOCK, P_SCALE];

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

    test('G35 FIXED: approve is atomic — exactly one of two simultaneous callers wins', async () => {
      // ── Pinned, and worded carefully, because the first version of this case
      //    over-claimed and the family run caught it.
      //
      // Run ALONE, two simultaneous approvals both return `201 "Payroll approved"`
      // — measured 8 times out of 8. Run inside the 6-worker family, one of them
      // is refused. That difference is the finding: `approvePayroll` checks the
      // status and then writes, without an atomic guard, so the check catches the
      // race only when the two requests happen to serialise. Under load they
      // often do; in isolation they never do.
      //
      // Same class as G27 (`POST /branches` 500ing on a concurrent duplicate) and
      // as the duplicate-payroll protection Phase 4 had to underwrite with a real
      // expression index: **a read-then-write check is not a guard under
      // concurrency.** `lockPayroll` next door does it properly and is asserted
      // below.
      //
      // The assertion here is therefore on the INVARIANT, not on the race
      // outcome — a test that asserts which caller wins is a flake by
      // construction. What must hold either way is that the run is approved once,
      // by one recorded approver.
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-approve`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_APPROVE,
        employeeIds: [subject.id],
        carrier,
      });
      await admin.post(`/payrolls/${run.id}/submit`, {});

      const scoped = admin.withBranch(branchId);
      const settled = await Promise.allSettled([
        scoped.post(`/payrolls/${run.id}/approve`, {}),
        scoped.post(`/payrolls/${run.id}/approve`, {}),
      ]);
      const won = settled.filter((r) => r.status === 'fulfilled').length;
      const lost = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      // The fix: the transition is now conditional in the DATABASE
      // (`updateMany ... where status='PENDING_APPROVAL'`), the way `lockPayroll`
      // already did it. Exactly one caller can claim it, whatever the timing.
      expect(won, 'exactly one approval succeeds, regardless of how the race falls').toBe(1);
      expect(lost.length, 'and exactly one is refused').toBe(1);
      // TWO refusal paths, both correct, and which one fires is a timing detail:
      //
      //   • slow race — the second caller's READ already sees APPROVED, so the
      //     status check at the top of `approvePayroll` refuses it:
      //     `400 "Can only approve payroll in PENDING_APPROVAL status"`
      //   • fast race — both reads see PENDING_APPROVAL, so the conditional
      //     `updateMany` is what refuses the loser:
      //     `409 "Payroll is no longer awaiting approval (approved or changed
      //     concurrently)"`
      //
      // Asserting only the second made this case fail under load, where the reads
      // serialise. What has to hold is that the loser is REFUSED and told why —
      // not which layer caught it.
      expect(
        lost[0].reason?.message ?? '',
        'the loser is refused with a sentence naming the state, from whichever guard caught it',
      ).toMatch(
        /no longer awaiting approval|approved or changed concurrently|can only approve payroll in PENDING_APPROVAL/i,
      );
      expect(
        lost[0].reason?.message ?? '',
        'and it is not a generic failure',
      ).not.toMatch(/could not be completed|invalid input|something went wrong/i);

      // The invariant, which must hold whichever way the race fell.
      const full = await admin.withBranch(branchId).get<unknown>(`/payrolls/${run.id}`);
      const payroll = ((full as { data?: Record<string, unknown> })?.data ?? full) as {
        status: string;
        approvedBy: string | null;
        approvedAt: string | null;
      };
      expect(payroll.status, 'the run is APPROVED, once').toBe('APPROVED');
      expect(payroll.approvedBy, 'and exactly one approver is on record').toBeTruthy();
      expect(payroll.approvedAt, 'with one approval timestamp').toBeTruthy();

      // The harm is bounded to the receipt: when both succeed, two people each
      // hold a success response for an approval only one of them is recorded as
      // having performed — and the audit trail cannot show it, because every
      // transition writes CREATE (G1) and no row carries both sides (G33).
      const items = await itemsOf(admin, run.id, branchId);
      expect(items.length, 'and the items are untouched by the race').toBe(2);
    });

    test('two simultaneous locks: one wins, the other is told why, money settles once', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-lock`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_LOCK,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});

      const before = await itemsOf(admin, run.id, branchId);
      const netBefore = before.find((i) => i.employeeId === subject.id)!.netSalary;

      const scoped = admin.withBranch(branchId);
      const settled = await Promise.allSettled([
        scoped.post(`/payrolls/${run.id}/lock`, {}),
        scoped.post(`/payrolls/${run.id}/lock`, {}),
      ]);
      const won = settled.filter((r) => r.status === 'fulfilled');
      const lost = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      expect(won.length, 'exactly one lock succeeded').toBe(1);
      expect(lost.length, 'and exactly one was refused').toBe(1);
      expect(
        lost[0].reason?.message ?? '',
        'the loser is told the state moved under them, not given a generic failure',
      ).toMatch(/no longer in a lockable state|locked or changed concurrently/i);

      // Locking is the step that settles the run's money — encashment, gratuity
      // accrual, garnishment collections. Doing it twice would pay twice.
      const after = await itemsOf(admin, run.id, branchId);
      expect(after.length, 'the item count is unchanged').toBe(before.length);
      expect(
        after.find((i) => i.employeeId === subject.id)!.netSalary,
        'and the figures did not move — the money settled exactly once',
      ).toBe(netBefore);

      const full = await admin.withBranch(branchId).get<unknown>(`/payrolls/${run.id}`);
      const payroll = ((full as { data?: Record<string, unknown> })?.data ?? full) as {
        status: string;
        unlockCount: number;
      };
      expect(payroll.status, 'the run is LOCKED').toBe('LOCKED');
      expect(Number(payroll.unlockCount), 'and was never reversed').toBe(0);
    });

    test('two simultaneous unlocks reverse the run exactly once', async () => {
      // Unlock is the compensating action: it reverses what the lock settled and
      // restores balances. Applying it twice would credit the employee twice.
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-unlock`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_UNLOCK,
        employeeIds: [subject.id],
        carrier,
      });
      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});
      await admin.post(`/payrolls/${run.id}/lock`, {});

      const scoped = admin.withBranch(branchId);
      const reason = `${MARK} simultaneous reversal probe`;
      const settled = await Promise.allSettled([
        scoped.post(`/payrolls/${run.id}/unlock`, { reason }),
        scoped.post(`/payrolls/${run.id}/unlock`, { reason }),
      ]);
      const won = settled.filter((r) => r.status === 'fulfilled').length;

      const full = await admin.withBranch(branchId).get<unknown>(`/payrolls/${run.id}`);
      const payroll = ((full as { data?: Record<string, unknown> })?.data ?? full) as {
        status: string;
        unlockCount: number;
      };

      expect(
        Number(payroll.unlockCount),
        `the run was reversed ONCE regardless of how many callers asked (${won} succeeded) — ` +
          'a second reversal would credit the employee twice',
      ).toBe(1);
      expect(payroll.status, 'and it is back to APPROVED').toBe('APPROVED');
    });

    test(`a ${SCALE_DEFAULT}-employee run pays everyone exactly once and reconciles`, async () => {
      // A shape check at a realistic size, not a benchmark. The engine is fast —
      // 60 employees generated in 34 ms when measured — so what is worth asserting
      // is that correctness holds when the population is not two people.
      const size = scaleSize();
      const staff: string[] = [];
      const started = Date.now();
      for (let i = 0; i < size; i++) {
        const e = await makeEmployee(admin, {
          marker: `${MARK}-bulk-${i}`,
          branchId,
          baseSalary: 1500,
        });
        staff.push(e.id);
      }
      const seedMs = Date.now() - started;

      // One employee is absent for a day, so the run is not uniform — a run where
      // every item is identical can hide an off-by-one that a mixed one exposes.
      const absentee = staff[Math.floor(size / 2)];
      await seedAttendance(admin, branchId, absentee, [dateIn(P_SCALE, 4)], { status: 'ABSENT' });

      const genStarted = Date.now();
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_SCALE,
        employeeIds: staff,
        carrier,
      });
      const genMs = Date.now() - genStarted;

      const items = await itemsOf(admin, run.id, branchId);

      // Everyone, exactly once. The carrier rides along, hence +1.
      expect(items.length, 'every employee in the run has an item, and only one').toBe(size + 1);
      const ids = new Set(items.map((i) => i.employeeId));
      expect(ids.size, 'no employee appears twice').toBe(items.length);
      for (const id of staff) {
        expect(ids.has(id), `employee ${id} was not dropped from the run`).toBe(true);
      }

      // The invariant that matters at any size.
      const full = await admin.withBranch(branchId).get<unknown>(`/payrolls/${run.id}`);
      const payroll = ((full as { data?: Record<string, unknown> })?.data ?? full) as {
        totalAmount: number | string;
      };
      const sum = items.reduce((a, i) => a + i.netSalary, 0);
      expect(
        Number(payroll.totalAmount),
        'the run total is the sum of its items — at size, not just for two people',
      ).toBeCloseTo(sum, 2);

      // The mixed population really is mixed.
      const absent = items.find((i) => i.employeeId === absentee)!;
      const present = items.find((i) => i.employeeId === staff[0])!;
      expect(absent.netSalary, 'the absentee is paid less than a full-month colleague')
        .toBeLessThan(present.netSalary);

      // Recorded rather than asserted: a timing budget on shared CI hardware is a
      // flake generator. The numbers are here so a future regression has something
      // to be compared against.
      console.log(
        `[scale] ${size} employees — seeded in ${seedMs} ms, run generated in ${genMs} ms`,
      );
      expect(genMs, 'generation finished in a time that is not pathological').toBeLessThan(60_000);
    });
  });
});
