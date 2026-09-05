import { test, expect, ApiClient } from '../../fixtures';
import {
  addRecovery,
  clearPayrollLane,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  featureSkipReason,
  flagFlipAllowed,
  itemsOf,
  marker,
  preflightCodes,
  preflightRun,
  recoveriesOf,
  runEdgePayroll,
  seedFullMonth,
  twinPair,
  withPayrollFeatures,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * The remaining extensions, driven with their switches on.
 *
 * Recoveries and the pre-run checklist share a file because each contributes
 * two or three journeys rather than a suite, and the setup they need — a branch,
 * a carrier, a full month of attendance — is identical. The exhaustive matrix
 * for both lives in the backend Jest suite.
 *
 * Decade 140–149.
 */
test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const P_RECOVER: Period = edgePeriod(140);
const P_PREFLIGHT: Period = edgePeriod(141);
const P_BLOCKED: Period = edgePeriod(142);
const ALL: Period[] = [P_BLOCKED, P_PREFLIGHT, P_RECOVER];

test.describe('payroll extensions, switched on', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee | null = null;
  let setupError = '';
  const MARK = marker('pw-payedge-ext-');
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
      test.skip(!flagFlipAllowed(), featureSkipReason('recovery', 'preflight'));
      expect(setupError).toBe('');
    });

    test('a recovery reaches the payslip, and says so in words', async () => {
      // An unexplained deduction is the thing employees escalate, so the note
      // is as much the feature as the number.
      const pair = await twinPair(admin, { marker: nextMark(), branchId });
      await seedFullMonth(admin, branchId, pair.subject.id, P_RECOVER);

      await withPayrollFeatures(admin, ['recovery'], async () => {
        await addRecovery(admin, branchId, {
          employeeId: pair.subject.id,
          totalAmount: 600,
          instalmentAmount: 200,
          reference: 'AST-PW-1',
        });

        const run = await runEdgePayroll(admin, {
          branchId,
          period: P_RECOVER,
          employeeIds: [pair.subject.id],
          carrier: carrier!,
        });
        const items = await itemsOf(admin, run.id, branchId);
        const item = items.find((i) => i.employeeId === pair.subject.id)!;

        const taken = Number(
          (item as unknown as Record<string, unknown>).otherRecovery ?? 0,
        );
        expect(taken).toBeGreaterThan(0);
        expect(String(item.notes ?? '')).toMatch(/Asset damage recovery AST-PW-1/);

        // The ledger advanced by exactly what the payslip took.
        const rows = await recoveriesOf(admin, branchId, pair.subject.id);
        expect(Number(rows[0].amountRecovered)).toBe(taken);
      });
    });

    test('the checklist says a well-formed run is safe', async () => {
      const pair = await twinPair(admin, { marker: nextMark(), branchId });
      await seedFullMonth(admin, branchId, pair.subject.id, P_PREFLIGHT);

      await withPayrollFeatures(admin, ['preflight'], async () => {
        const r = await preflightRun(admin, {
          branchId,
          period: P_PREFLIGHT,
          employeeIds: [pair.subject.id],
        });
        expect(r.total).toBe(1);
        expect(r.canGenerate).toBe(true);
        // It reports the window it validated against, so "safe" is a statement
        // about a period somebody can see rather than an unqualified yes.
        expect(r.window.periodStart).toContain(String(P_PREFLIGHT.year));
      });
    });

    test('the checklist BLOCKS a period with no attendance captured', async () => {
      // The expensive mistake: generating would pay everybody a full month.
      const pair = await twinPair(admin, { marker: nextMark(), branchId });

      await withPayrollFeatures(admin, ['preflight'], async () => {
        const r = await preflightRun(admin, {
          branchId,
          period: P_BLOCKED,
          employeeIds: [pair.subject.id],
        });
        expect(r.canGenerate).toBe(false);
        expect(preflightCodes(r)).toContain('NO_ATTENDANCE_CAPTURED');
      });
    });

    test('it writes nothing, however many times it is asked', async () => {
      const pair = await twinPair(admin, { marker: nextMark(), branchId });

      await withPayrollFeatures(admin, ['preflight'], async () => {
        for (let i = 0; i < 3; i++) {
          await preflightRun(admin, {
            branchId,
            period: P_BLOCKED,
            employeeIds: [pair.subject.id],
          });
        }
        // A checklist that created something would be a checklist nobody dared
        // run twice.
        const rows = await recoveriesOf(admin, branchId, pair.subject.id);
        expect(rows).toEqual([]);
      });
    });
  });
});
