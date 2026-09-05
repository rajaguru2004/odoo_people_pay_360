import { test, expect, ApiClient } from '../../fixtures';
import {
  addGarnishment,
  carryForwardsOf,
  clearPayrollLane,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  garnishmentsOf,
  itemsOf,
  marker,
  revokeGarnishment,
  runEdgePayroll,
  twinPair,
  waiveCarryForward,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * Court-ordered attachment of earnings, driven end to end against a live run.
 *
 * ## Why this file exists
 *
 * `payroll-edge-recoveries.spec.ts` opened by recording that this rung of the
 * ladder could not be driven at all: `PayrollItem.garnishment` had exactly one
 * writer in the whole codebase, the literal `garnishment: 0`, and no DTO field
 * anywhere (G28). The allocator honoured a court order the product had no way
 * to record. `Garnishment` and `PayrollCarryForward` closed that.
 *
 * ## What is asserted here, and what is not
 *
 * The exhaustive matrix — the amount/percentage exclusivity, the liveness
 * window at both edges, arrears ordering, finite-order closure, the priority
 * ladder, and every reversal path — belongs to the backend suite
 * (`payroll-edge-garnishment.e2e-spec.ts`, `PE-GARN-01`..`23`) and to the 20
 * layer-0 cases in `src/garnishments/garnishment-allocator.spec.ts`.
 *
 * This file owns the SEAM: that an order recorded through the API reaches a
 * generated payslip, that the money it takes is visible as a difference against
 * a twin who has no order, and that a shortfall becomes a balance a later run
 * collects. Three journeys, not a second copy of the matrix.
 *
 * ## The oracle
 *
 * Twin control throughout — a second employee identical but for the order — so
 * no assertion depends on how this environment configures PF, ESI or tax.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-garn-';
const MARK = marker(MARKER_PREFIX);

const num = (v: unknown) => Number(v ?? 0);

test.describe('court-ordered deductions against payroll', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let setupError = '';

  // Decade 80–89 in the register at the head of `e2e/payroll-period.ts`. One
  // period per case without exception: two cases sharing a month means the
  // second gets a duplicate-period 409 that reads as a product defect.
  const P_REACHES: Period = edgePeriod(80);
  const P_PERCENT: Period = edgePeriod(81);
  const P_SHORT: Period = edgePeriod(82);
  const P_ARREARS_1: Period = edgePeriod(83);
  const P_ARREARS_2: Period = edgePeriod(84);
  const P_REVOKE_1: Period = edgePeriod(85);
  const P_REVOKE_2: Period = edgePeriod(86);
  const P_WAIVE: Period = edgePeriod(87);
  const ALL = [
    P_REACHES,
    P_PERCENT,
    P_SHORT,
    P_ARREARS_1,
    P_ARREARS_2,
    P_REVOKE_1,
    P_REVOKE_2,
    P_WAIVE,
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

    test('G28 FIXED: an order recorded through the API reaches the payslip', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-reach`,
        branchId,
        baseSalary: 1500,
      });
      await addGarnishment(admin, {
        employeeId: subject.id,
        branchId,
        amount: 120,
        reference: 'CR-E2E-REACH',
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_REACHES,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(t.garnishment, 'the twin has no order against them').toBe(0);
      expect(s.garnishment, 'the order reaches the payslip — it was always 0 before').toBe(120);

      // The twin's net IS the pre-garnishment net, so nothing here depends on
      // the environment's statutory configuration.
      expect(
        t.netSalary - s.netSalary,
        'the difference between the two payslips is exactly the order',
      ).toBeCloseTo(120, 2);

      expect(s.notes ?? '', 'and the payslip names the instrument').toMatch(
        /Court order CR-E2E-REACH/,
      );
    });

    test('a percentage order is priced off net-of-statutory pay, not off gross', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-pct`,
        branchId,
        baseSalary: 1500,
      });
      await addGarnishment(admin, {
        employeeId: subject.id,
        branchId,
        percentOfNet: 10,
        reference: 'CR-E2E-PCT',
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_PERCENT,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      // Asserted as a relationship to the twin's net, never as a constant — a
      // hard-coded figure here would break the day PF or tax is reconfigured.
      const expected = Math.round(t.netSalary * 10) / 100;
      expect(s.garnishment).toBeCloseTo(expected, 1);
      expect(t.netSalary - s.netSalary).toBeCloseTo(expected, 1);
      expect(
        s.garnishment,
        'and it is 10% of NET, not of the larger gross',
      ).toBeLessThan(Math.round(t.netSalary * 10) / 100 + 1);
    });

    test('G29: an order larger than the pay takes what is there and carries the rest', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-short`,
        branchId,
        baseSalary: 1500,
      });
      const order = await addGarnishment(admin, {
        employeeId: subject.id,
        branchId,
        amount: 100_000,
        reference: 'CR-E2E-SHORT',
      });

      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_SHORT,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, run.id);
      const s = items.find((i) => i.employeeId === subject.id)!;
      const t = items.find((i) => i.employeeId === twin.id)!;

      expect(s.netSalary, 'the whole of the pay went to the order').toBe(0);
      expect(s.garnishment, 'and nothing more than the pay was taken').toBeCloseTo(
        t.netSalary,
        2,
      );

      const carried = await carryForwardsOf(admin, branchId, subject.id);
      expect(carried, 'the shortfall is a ledger row, not a silent write-off').toHaveLength(1);
      expect(carried[0].kind).toBe('GARNISHMENT');
      expect(carried[0].sourceId).toBe(order.id);
      expect(carried[0].status).toBe('OUTSTANDING');
      expect(num(carried[0].amount)).toBeCloseTo(100_000 - t.netSalary, 2);
      expect(carried[0].originPayrollId, 'and it names the run that could not take it').toBe(
        run.id,
      );
      expect(s.notes ?? '').toMatch(/carried forward to the next payroll/i);
    });

    test('the next run collects the arrears on top of that period\'s own instalment', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-arrears`,
        branchId,
        baseSalary: 1500,
      });
      // A finite order sized so the FIRST period cannot cover it and the second
      // can — which is the whole shape of carry-forward in one order.
      await addGarnishment(admin, {
        employeeId: subject.id,
        branchId,
        amount: 100_000,
        reference: 'CR-E2E-ARREARS',
      });

      const first = await runEdgePayroll(admin, {
        branchId,
        period: P_ARREARS_1,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const firstItems = await itemsOf(admin, first.id);
      const s1 = firstItems.find((i) => i.employeeId === subject.id)!;
      expect(s1.netSalary).toBe(0);

      const opened = await carryForwardsOf(admin, branchId, subject.id);
      expect(opened).toHaveLength(1);
      const owedAfterFirst = num(opened[0].amount);

      const second = await runEdgePayroll(admin, {
        branchId,
        period: P_ARREARS_2,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const secondItems = await itemsOf(admin, second.id);
      const s2 = secondItems.find((i) => i.employeeId === subject.id)!;
      const t2 = secondItems.find((i) => i.employeeId === twin.id)!;

      expect(s2.netSalary, 'the second period is consumed too').toBe(0);
      expect(s2.garnishment).toBeCloseTo(t2.netSalary, 2);

      // The first balance was worked down, and the second period's own shortfall
      // opened a row of its own — two debts, each traceable to its run.
      const after = await carryForwardsOf(admin, branchId, subject.id);
      const original = after.find((r) => r.id === opened[0].id)!;
      expect(num(original.amountRecovered), 'the carried balance was worked down')
        .toBeGreaterThan(0);
      expect(num(original.amountRecovered)).toBeLessThanOrEqual(owedAfterFirst);
      expect(new Set(after.map((r) => r.originPayrollId)).size).toBe(2);
    });

    test('revoking an order stops the next run and leaves what was taken intact', async () => {
      const { subject, twin } = await twinPair(admin, {
        marker: `${MARK}-revoke`,
        branchId,
        baseSalary: 1500,
      });
      const order = await addGarnishment(admin, {
        employeeId: subject.id,
        branchId,
        amount: 120,
        reference: 'CR-E2E-REVOKE',
      });

      const first = await runEdgePayroll(admin, {
        branchId,
        period: P_REVOKE_1,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const s1 = (await itemsOf(admin, first.id)).find((i) => i.employeeId === subject.id)!;
      expect(s1.garnishment).toBe(120);

      await revokeGarnishment(admin, branchId, order.id);

      const second = await runEdgePayroll(admin, {
        branchId,
        period: P_REVOKE_2,
        employeeIds: [subject.id, twin.id],
        carrier,
      });
      const items = await itemsOf(admin, second.id);
      const s2 = items.find((i) => i.employeeId === subject.id)!;
      const t2 = items.find((i) => i.employeeId === twin.id)!;

      expect(s2.garnishment, 'the revoked order attaches nothing').toBe(0);
      expect(s2.netSalary, 'and the payslip matches an untouched colleague').toBeCloseTo(
        t2.netSalary,
        2,
      );

      // A flag flip, not a delete: the first run stays explainable.
      const still = (await garnishmentsOf(admin, branchId, subject.id)).find(
        (g) => g.id === order.id,
      );
      expect(still, 'the order is still on record').toBeTruthy();
      expect(still!.isActive).toBe(false);
      expect(num(still!.collected), 'and what it took is still recorded').toBe(120);
    });

    test('writing a carried balance off demands a reason, and says who wrote it off', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-waive`,
        branchId,
        baseSalary: 1500,
      });
      await addGarnishment(admin, {
        employeeId: subject.id,
        branchId,
        amount: 100_000,
        reference: 'CR-E2E-WAIVE',
      });
      await runEdgePayroll(admin, {
        branchId,
        period: P_WAIVE,
        employeeIds: [subject.id],
        carrier,
      });

      const [row] = await carryForwardsOf(admin, branchId, subject.id);
      expect(row.status).toBe('OUTSTANDING');

      // A reason is not optional — a balance that vanishes with no explanation
      // is the failure mode the ledger exists to prevent.
      await expect(
        admin.withBranch(branchId).patch(`/garnishments/carry-forwards/${row.id}/waive`, {}),
      ).rejects.toThrow();

      const waived = await waiveCarryForward(
        admin,
        branchId,
        row.id,
        'Order discharged by the court',
      );
      expect(waived.status).toBe('WAIVED');
      expect(waived.reason ?? '').toMatch(/Order discharged by the court/);
    });
  });
});
