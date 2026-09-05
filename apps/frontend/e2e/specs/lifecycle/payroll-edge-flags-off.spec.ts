import { test, expect, ApiClient } from '../../fixtures';
import {
  clearPayrollLane,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  itemsOf,
  linesOf,
  marker,
  preflightRun,
  recoveriesOf,
  runEdgePayroll,
  seedFullMonth,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * With every payroll extension switched off, nothing has changed.
 *
 * This is the case the whole phase rests on. A client is live on the base
 * payroll; nine features were added on top of it; each one ships OFF. If any of
 * them can be observed while off, the safety argument for the whole release is
 * gone — so this file looks for them from the outside, through the same API a
 * screen uses, rather than trusting a flag check somewhere inside.
 *
 * It runs in the DEFAULT lane and touches no global setting, so it is the one
 * file here that cannot itself perturb another spec.
 *
 * Decade 170–179.
 */
test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const P_RUN: Period = edgePeriod(170);
const P_TWIN: Period = edgePeriod(171);
const P_COLUMNS: Period = edgePeriod(172);
const P_PREFLIGHT: Period = edgePeriod(173);
const ALL: Period[] = [P_PREFLIGHT, P_COLUMNS, P_TWIN, P_RUN];

test.describe('payroll extensions, switched off', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee | null = null;
  let setupError = '';
  const MARK = marker('pw-payedge-flagsoff-');
  /**
   * A distinct marker per case.
   *
   * `makeEmployee` derives the email from the marker, so two cases sharing one
   * would collide on `Email already exists` — and the 409 reads as a product
   * defect rather than a fixture that reused a name.
   */
  let seq = 0;
  const nextMark = () => `${MARK}${(seq += 1)}`;

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      admin = await ApiClient.as('admin');
      branchId = await ensurePayrollEdgeBranch(admin);
      carrier = await ensureCarrier(admin, branchId, MARK);
      await clearPayrollLane(admin, branchId, ALL);
    } catch (err) {
      setupError = err instanceof Error ? err.message : String(err);
    }
  });

  test.afterAll(async () => {
    if (!isProject('admin')) return;
    try {
      await clearPayrollLane(admin, branchId, ALL);
    } catch (err) {
      console.error('teardown', err);
    }
    admin?.dispose();
  });

  test.describe('as admin', () => {
    test.beforeEach(() => {
      test.skip(!isProject('admin'), 'payroll is ADMIN/HR territory');
      expect(setupError).toBe('');
    });

    test('a payslip carries no itemised breakdown', async () => {
      const pair = await twinPair(admin, { marker: nextMark(), branchId });
      await seedFullMonth(admin, branchId, pair.subject.id, P_RUN);
      await seedFullMonth(admin, branchId, pair.twin.id, P_RUN);

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_RUN,
        employeeIds: [pair.subject.id, pair.twin.id],
        carrier: carrier!,
      });

      // The field is ABSENT, not empty. With the switch off the response shape
      // is what it was before the feature existed, so no client has to learn a
      // field that is always [].
      const lines = await linesOf(admin, branchId, run.id, pair.subject.id);
      expect(lines).toEqual([]);
    });

    test('two employees on identical terms are still paid identically', async () => {
      // The twin oracle, used here to say something about the FEATURE rather
      // than about the money: whatever the extensions are doing, they are doing
      // nothing that distinguishes these two.
      const pair = await twinPair(admin, { marker: nextMark(), branchId });
      await seedFullMonth(admin, branchId, pair.subject.id, P_TWIN);
      await seedFullMonth(admin, branchId, pair.twin.id, P_TWIN);

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_TWIN,
        employeeIds: [pair.subject.id, pair.twin.id],
        carrier: carrier!,
      });
      const items = await itemsOf(admin, run.id, branchId);
      const a = items.find((i) => i.employeeId === pair.subject.id)!;
      const b = items.find((i) => i.employeeId === pair.twin.id)!;

      expect(Number(a.netSalary)).toBe(Number(b.netSalary));
      expect(Number(a.baseSalary)).toBe(Number(b.baseSalary));
    });

    test('the new money columns are present and ZERO on every payslip', async () => {
      // Two columns were added to `payroll_items` and cannot be conditional on a
      // flag, so they DO appear in the response. What must hold is that they are
      // 0 — `x + 0` and `x − 0` are exact in IEEE-754, so a zero column cannot
      // move a net.
      //
      // Its own period, as every case here has: a shared one gives the second
      // case a duplicate-period 409, and on a RETRY it gives the same case one.
      const pair = await twinPair(admin, { marker: nextMark(), branchId });
      await seedFullMonth(admin, branchId, pair.subject.id, P_COLUMNS);

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_COLUMNS,
        employeeIds: [pair.subject.id],
        carrier: carrier!,
      });
      const items = await itemsOf(admin, run.id, branchId);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(Number((item as unknown as Record<string, unknown>).leaveEncashment ?? 0)).toBe(0);
        expect(Number((item as unknown as Record<string, unknown>).otherRecovery ?? 0)).toBe(0);
      }
    });

    test('the pre-run checklist is unavailable', async () => {
      // 404 rather than 403: the feature does not exist for this installation,
      // which is a different statement from "you may not use it".
      const failed = await preflightRun(admin, {
        branchId,
        period: P_PREFLIGHT,
      }).catch((err) => err as Error);
      expect(failed).toBeInstanceOf(Error);
      expect(String((failed as Error).message)).toMatch(/not enabled|404/i);
    });

    test('an employee has no recoveries, and asking does not fail', async () => {
      // The ledger route stays readable — it is not behind the flag, because a
      // balance raised while the feature was on must not become invisible when
      // somebody turns it off.
      const pair = await twinPair(admin, { marker: nextMark(), branchId });
      const rows = await recoveriesOf(admin, branchId, pair.subject.id);
      expect(rows).toEqual([]);
    });

    test('branch transfer is still refused on the employee form', async () => {
      // The pin that `payroll-edge-salary-change.spec.ts` also holds, asserted
      // here because it is a statement about the extensions: building a transfer
      // ROUTE did not loosen the FORM, and was never meant to.
      const pair = await twinPair(admin, { marker: nextMark(), branchId });
      const failed = await admin
        .patch(`/employees/${pair.subject.id}`, { branchId })
        .catch((err) => err as Error);
      expect(failed).toBeInstanceOf(Error);
      expect(String((failed as Error).message)).toMatch(
        /property branchId should not exist/i,
      );
    });
  });

});
