import { test, expect, ApiClient } from '../../fixtures';
import {
  addComponent,
  clearPayrollLane,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  featureSkipReason,
  flagFlipAllowed,
  itemsOf,
  linesOf,
  marker,
  runEdgePayroll,
  seedFullMonth,
  sumBucket,
  twinPair,
  withPayrollFeatures,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * Itemised payslips, with the feature ON.
 *
 * No browser case here on purpose. What the payslip RENDERS is pinned at layer 0
 * by `utils/payslipLines.test.ts`, as an exact array equality over the rows and
 * their order — including the degradation contract, that with no lines the
 * output is byte-for-byte what the page showed before this feature existed. A
 * selector-based browser assertion would be a weaker claim taking a minute to
 * run instead of a millisecond.
 *
 * Tier 2 of the three-tier strategy: a couple of journeys that only mean
 * something end to end, run in the FLAGGED lane. The exhaustive matrix is not
 * here — it is in the backend Jest suite, which runs `maxWorkers: 1` where
 * flipping a global setting is safe by construction.
 *
 * Turning itemisation on moves a GLOBAL setting, so these cases skip in the
 * default lane with a reason rather than re-pricing every other spec's payroll.
 *
 * Decade 100–109.
 */
test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const P_SPLIT: Period = edgePeriod(100);
const P_RECONCILE: Period = edgePeriod(101);
const ALL: Period[] = [P_RECONCILE, P_SPLIT];

test.describe('itemised payslips', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee | null = null;
  let setupError = '';
  const MARK = marker('pw-payedge-items-');
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
      test.skip(!flagFlipAllowed(), featureSkipReason('itemLines'));
      expect(setupError).toBe('');
    });

    test('an aggregate allowance becomes the components behind it', async () => {
      // The question this feature exists to answer: "what is my 280 made of?"
      const pair = await twinPair(admin, { marker: nextMark(), branchId });
      await addComponent(admin, pair.subject.id, 'BASIC', 1000);
      await addComponent(admin, pair.subject.id, 'HOUSING', 200);
      await addComponent(admin, pair.subject.id, 'TRANSPORT', 80);
      await seedFullMonth(admin, branchId, pair.subject.id, P_SPLIT);

      await withPayrollFeatures(admin, ['itemLines'], async () => {
        const run = await runEdgePayroll(admin, {
          branchId,
          period: P_SPLIT,
          employeeIds: [pair.subject.id],
          carrier: carrier!,
        });

        const lines = await linesOf(admin, branchId, run.id, pair.subject.id);
        expect(lines.length).toBeGreaterThan(0);

        const allowanceCodes = lines
          .filter((l) => l.bucket === 'allowances')
          .map((l) => l.code)
          .sort();
        expect(allowanceCodes).toEqual(['HOUSING', 'TRANSPORT']);
      });
    });

    test('the lines add up to the columns they explain, bucket by bucket', async () => {
      // The invariant the whole design rests on. Checked per BUCKET, not per
      // category: `deduction`, `insurance` and `tax` are three separate
      // deduction columns, so a category-level check would let a PF line
      // reconcile against a garnishment and still balance.
      const pair = await twinPair(admin, { marker: nextMark(), branchId });
      await addComponent(admin, pair.subject.id, 'BASIC', 1000);
      await addComponent(admin, pair.subject.id, 'HOUSING', 200);
      await addComponent(admin, pair.subject.id, 'PHONE', 55.55);
      await seedFullMonth(admin, branchId, pair.subject.id, P_RECONCILE);

      await withPayrollFeatures(admin, ['itemLines'], async () => {
        const run = await runEdgePayroll(admin, {
          branchId,
          period: P_RECONCILE,
          employeeIds: [pair.subject.id],
          carrier: carrier!,
        });

        const items = await itemsOf(admin, run.id, branchId);
        const item = items.find((i) => i.employeeId === pair.subject.id)!;
        const lines = await linesOf(admin, branchId, run.id, pair.subject.id);

        for (const bucket of ['baseSalary', 'allowances', 'insurance', 'tax'] as const) {
          const column = Math.round(Number((item as unknown as Record<string, unknown>)[bucket] ?? 0) * 100) / 100;
          if (column === 0) continue;
          expect({ bucket, lines: sumBucket(lines, bucket) }).toEqual({ bucket, lines: column });
        }
      });
    });

  });
});
