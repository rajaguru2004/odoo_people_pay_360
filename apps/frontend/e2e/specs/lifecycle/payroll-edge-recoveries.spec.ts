import { test, expect, ApiClient } from '../../fixtures';
import {
  clearPayrollLane,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  itemsOf,
  marker,
  runEdgePayroll,
  twinPair,
  type PayrollItemRow,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * What happens when deductions are larger than the pay they come out of.
 *
 * ## Scope, and what owns the rest
 *
 * The GARNISHMENT rung is owned by `payroll-edge-garnishment.e2e-spec.ts`
 * (`PE-GARN`) on the backend, where a court order can be recorded, priced and
 * carried. When this file was written that rung could not be driven at all —
 * `PayrollItem.garnishment` had exactly one writer, the literal `garnishment: 0`
 * (G28) — and the note that said so is gone with the gap.
 *
 * What this file owns is the rung anyone can reach through the UI's own API: an
 * ad-hoc `deduction` on the item, and what the engine does when it exceeds the
 * pay.
 *
 * ## The answer, measured
 *
 * **Net floors at zero. It never goes negative.** A deduction of 99,999 against
 * a gross of 1,500 produces a net of 0, not −98,499. Nobody is ever billed by
 * their own payslip.
 *
 * **And the payslip still adds up.** The floor is implemented by clamping the
 * INPUT rather than the answer: the item stores the largest deduction the pay
 * can bear, the remainder becomes a carried balance the next run collects, and
 * a note on the item says so. Before that fix the full deduction stayed on the
 * item and `gross - deductions` came to −97,940.26 against a stated net of 0,
 * with nothing anywhere recording that 97,940.26 had never been taken (G29).
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-rec-';
const MARK = marker(MARKER_PREFIX);

/** Everything the item adds, before anything is taken off. */
function grossOf(i: PayrollItemRow): number {
  return i.baseSalary + i.allowances + i.bonus + i.overtimePay + i.foodAllowance;
}

/** Everything the item takes off. */
function deductionsOf(i: PayrollItemRow): number {
  return i.deduction + i.insurance + i.tax + i.garnishment;
}

test.describe('recoveries against payroll', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  const P_FLOOR: Period = edgePeriod(50);
  const P_EXACT: Period = edgePeriod(51);
  const P_NEG: Period = edgePeriod(52);
  const P_REGEN: Period = edgePeriod(53);
  // One period per case, without exception. The first version of this file gave
  // the negative-deduction case and the regenerate case the SAME period, and the
  // run the first one left behind made the second fail with a duplicate-period
  // 409 — a failure that reads as a product defect and is a spec bug.
  const ALL = [P_FLOOR, P_EXACT, P_NEG, P_REGEN];

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

    test('a deduction larger than the pay floors net at zero — never negative', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-floor`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_FLOOR,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const before = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      expect(before.netSalary, 'the subject starts with real pay').toBeGreaterThan(0);

      // Sixty-six times the gross. Nothing subtle — the question is only whether
      // the floor holds.
      await admin.patch(`/payrolls/${run.id}/items/${before.id}`, { deduction: 99_999 });

      const after = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;
      const other = (await itemsOf(admin, run.id)).find((i) => i.employeeId === twin.id)!;

      expect(after.netSalary, 'net is floored at zero').toBe(0);
      expect(after.netSalary, 'and is never negative — nobody is billed by their own payslip')
        .toBeGreaterThanOrEqual(0);
      expect(other.netSalary, 'the colleague beside them is untouched').toBe(before.netSalary);

      // The run total follows the floored figure rather than the arithmetic one.
      const full = await admin.withBranch(branchId).get<unknown>(`/payrolls/${run.id}`);
      const payroll = ((full as { data?: Record<string, unknown> })?.data ?? full) as {
        totalAmount: number | string;
      };
      const sumOfNets = (await itemsOf(admin, run.id)).reduce((a, i) => a + i.netSalary, 0);
      expect(
        Number(payroll.totalAmount),
        'the run total is the sum of the floored nets, not of the arithmetic ones',
      ).toBeCloseTo(sumOfNets, 2);
    });

    test('G29 FIXED: the floored item still adds up, and names what it could not take', async () => {
      // The pin this replaces recorded the cost of implementing the floor by
      // clamping the ANSWER: the excess stayed on the item, `gross - deductions`
      // came to -97,940.26 against a stated net of 0, and no note said why.
      //
      // The input is clamped instead — the item stores what the pay could bear
      // and the remainder is carried — so the two figures agree again and the
      // shortfall is stated in words rather than left to be inferred.
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-exact`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_EXACT,
        employeeIds: [subject.id],
        carrier,
      });
      const item = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;

      // A control first: an ordinary item DOES reconcile. Without this, the
      // assertion below could pass because the arithmetic never held.
      expect(
        grossOf(item) - deductionsOf(item),
        'an ordinary item reconciles: gross - deductions = net',
      ).toBeCloseTo(item.netSalary, 2);

      const excessive = Math.round(grossOf(item) * 10);
      await admin.patch(`/payrolls/${run.id}/items/${item.id}`, { deduction: excessive });
      const after = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;

      expect(after.netSalary, 'net floored').toBe(0);
      const arithmetic = grossOf(after) - deductionsOf(after);
      expect(
        arithmetic,
        'the item reconciles: what it says it took is what it took',
      ).toBeCloseTo(after.netSalary, 1);

      // And the shortfall is stated, not inferred.
      expect(
        after.notes ?? '',
        'the note names the amount carried to the next payroll',
      ).toMatch(/carried forward to the next payroll/i);

      // The stored deduction is what the pay could bear — strictly less than
      // what was asked for, and strictly more than nothing.
      expect(after.deduction).toBeLessThan(excessive);
      expect(after.deduction).toBeGreaterThan(0);
    });

    test('a negative deduction is refused by name', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-neg`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_NEG,
        employeeIds: [subject.id],
        carrier,
      });
      const item = (await itemsOf(admin, run.id)).find((i) => i.employeeId === subject.id)!;

      // A negative deduction is a payment dressed as a recovery, and the DTO says
      // so rather than quietly increasing someone's pay.
      const refusal = await admin
        .patch(`/payrolls/${run.id}/items/${item.id}`, { deduction: -5 })
        .then(() => '')
        .catch((e: Error) => e.message);

      expect(refusal, 'the edit was refused').toBeTruthy();
      expect(refusal, 'and names the field and the rule').toMatch(
        /deduction must not be less than 0/i,
      );
      expect(refusal, 'and is not a generic failure').not.toMatch(
        /could not be completed|invalid input|something went wrong/i,
      );
    });

    test('deleting a DRAFT run and regenerating it charges exactly once', async () => {
      // The catalogue's "duplicate payroll execution causes duplicate deductions".
      // Driven on the reachable path: a DRAFT run is deleted and the period is
      // generated again, and the second run must be a replacement rather than an
      // addition — one item per employee, the same figures, and one row in the
      // period.
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-regen`,
        branchId,
        baseSalary: 1500,
      });

      const first = await runEdgePayroll(admin, {
        branchId,
        period: P_REGEN,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const firstItems = await itemsOf(admin, first.id);
      const firstNet = firstItems.find((i) => i.employeeId === subject.id)!.netSalary;

      await admin.withBranch(branchId).delete(`/payrolls/${first.id}`);

      const second = await runEdgePayroll(admin, {
        branchId,
        period: P_REGEN,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const secondItems = await itemsOf(admin, second.id);

      expect(second.id, 'the regenerated run is a new record').not.toBe(first.id);
      expect(secondItems.length, 'covering the same population, once each').toBe(firstItems.length);
      expect(
        secondItems.filter((i) => i.employeeId === subject.id).length,
        'exactly one item per employee — not two',
      ).toBe(1);
      expect(
        secondItems.find((i) => i.employeeId === subject.id)!.netSalary,
        'and the figures are the same, because nothing about the employee changed',
      ).toBe(firstNet);

      const stored = await admin
        .withBranch(branchId)
        .get<unknown>(`/payrolls?year=${P_REGEN.year}`);
      const rows = (Array.isArray(stored) ? stored : ((stored as { data?: unknown[] })?.data ?? []))
        .filter(
          (r) =>
            (r as { month: number }).month === P_REGEN.month &&
            (r as { branchId?: string }).branchId === branchId,
        );
      expect(rows.length, 'and the period holds one run, not the deleted one as well').toBe(1);
    });
  });
});
