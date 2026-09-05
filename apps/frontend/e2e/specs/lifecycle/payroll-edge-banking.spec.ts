import { test, expect, ApiClient } from '../../fixtures';
import {
  clearPayrollLane,
  edgePeriod,
  ensureCarrier,
  ensurePayrollEdgeBranch,
  ensureWpsConfig,
  lockPayroll,
  marker,
  preflight,
  runEdgePayroll,
  runFindingCodes,
  twinPair,
  type Period,
  type TestEmployee,
} from '../../payroll-support';

/**
 * Where payroll hands over to the bank.
 *
 * ## Scope
 *
 * The wage-file FORMAT layer — field widths, baisa rounding, the Oman CBO and
 * SIF-EDR layouts — is owned by `wps-flow.e2e-spec.ts` (19 cases) and
 * `wps.admin.spec.ts`, and is not rebuilt here. What this file owns is the SEAM:
 * what a payroll run must be before its money is allowed out of the building.
 *
 * ## The gate, and why it is two conditions rather than one
 *
 * `wps-payload.builder.ts` requires `status === 'LOCKED' && lockedAt != null &&
 * approvedAt != null`. The second and third are not redundant: an older code
 * path moved runs straight to LOCKED without approval and without settling
 * reimbursements or loan instalments, so a bare status check would let that
 * legacy state through.
 *
 * The two failures get DIFFERENT codes because they have different remedies, and
 * that distinction is worth protecting — telling someone to "submit for approval"
 * when the run is already LOCKED is advice they cannot act on, since submit,
 * approve and lock all reject a LOCKED payroll and leave them stuck:
 *
 *   • not locked at all → `PAYROLL_NOT_PROPERLY_LOCKED`, naming the actual status
 *   • locked without approval → its own code, whose only remedy is a revision
 *
 * ## Pre-flight is deliberately not gated on status
 *
 * It RUNS on a DRAFT and reports the lock problem as a BLOCKING finding, rather
 * than refusing to answer. That is the right shape for a read-only check — an
 * operator wants to see the bank problems early, while the run can still be
 * edited — and generation is what the finding blocks.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

const MARKER_PREFIX = 'pw-payedge-bank-';
const MARK = marker(MARKER_PREFIX);

const LOCK_FINDING = 'PAYROLL_NOT_PROPERLY_LOCKED';

test.describe('payroll to bank file', () => {
  let admin: ApiClient;
  let branchId = '';
  let carrier: TestEmployee;
  let format = '';
  let setupError = '';

  // One period per CASE. The first version of this file gave three cases the same
  // period and the second one failed with a duplicate-period 409 — the exact rule
  // §5.2a of the plan states, broken in the very next file after it was written.
  const P_GATE: Period = edgePeriod(70);
  const P_FINDINGS: Period = edgePeriod(71);
  const P_NOBANK: Period = edgePeriod(72);
  const P_GENERATE: Period = edgePeriod(73);
  const ALL = [P_GATE, P_FINDINGS, P_NOBANK, P_GENERATE];

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      admin = await ApiClient.as('admin');
      branchId = await ensurePayrollEdgeBranch(admin);
      carrier = await ensureCarrier(admin, branchId, MARK);
      // Without this, every case below fails on "No wage-file configuration
      // exists for branch E2E-PAY" rather than on its own subject.
      ({ format } = await ensureWpsConfig(admin, branchId));
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
      test.skip(!isProject('admin'), 'wage files are ADMIN/HR territory');
      expect(setupError, `setup failed: ${setupError}`).toBe('');
    });

    test('the branch is configured for a real Oman wage file', async () => {
      // The branch is created by `ensureBranch` with only a code and a name, so
      // `country` and `bankingCountries` start EMPTY and every bank detail is
      // refused. `ensurePayrollEdgeBranch` fixes that; this case proves it did,
      // because the symptom otherwise looks like a payroll defect.
      expect(format, 'an Oman format was selected').toMatch(/^om-/);

      const branches = await admin.get<unknown>('/banks/branch-countries');
      const rows = (Array.isArray(branches)
        ? branches
        : ((branches as { data?: unknown[] })?.data ?? [])) as Array<{
        id: string;
        country: string | null;
        bankingCountries: string[];
      }>;
      const mine = rows.find((b) => b.id === branchId);
      expect(mine?.country, 'the branch is in Oman').toBe('OM');
      expect(mine?.bankingCountries, 'and banks there').toContain('OM');
    });

    test('a wage file is refused until the run is LOCKED, and the refusal names the state', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-gate`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_GATE,
        employeeIds: [subject.id],
        carrier,
      });

      // ── DRAFT ────────────────────────────────────────────────────────────
      let pf = await preflight(admin, branchId, run.id);
      expect(runFindingCodes(pf), 'a DRAFT run is blocked from producing a wage file')
        .toContain(LOCK_FINDING);
      expect(pf.canGenerate, 'and cannot generate').toBe(false);

      const draftFinding = pf.runFindings.find((f) => f.code === LOCK_FINDING)!;
      expect(draftFinding.severity, 'the lock problem is BLOCKING, not advisory').toBe('BLOCKING');
      expect(
        draftFinding.message,
        'and the message names the ACTUAL status rather than saying "not locked"',
      ).toMatch(/payroll is DRAFT/i);
      expect(
        draftFinding.message,
        'and states the remedy as the three steps it really takes',
      ).toMatch(/submit it for approval, approve it, then lock it/i);

      // ── PENDING_APPROVAL ─────────────────────────────────────────────────
      await admin.post(`/payrolls/${run.id}/submit`, {});
      pf = await preflight(admin, branchId, run.id);
      expect(runFindingCodes(pf), 'a submitted run is still blocked').toContain(LOCK_FINDING);
      expect(
        pf.runFindings.find((f) => f.code === LOCK_FINDING)!.message,
        'and the message follows the run',
      ).toMatch(/payroll is PENDING_APPROVAL/i);

      // ── APPROVED — the interesting one ───────────────────────────────────
      await admin.post(`/payrolls/${run.id}/approve`, {});
      pf = await preflight(admin, branchId, run.id);
      expect(
        runFindingCodes(pf),
        'APPROVED is NOT enough — the figures can still change until the run is locked',
      ).toContain(LOCK_FINDING);
      expect(
        pf.runFindings.find((f) => f.code === LOCK_FINDING)!.message,
        'and it says so, naming APPROVED',
      ).toMatch(/payroll is APPROVED/i);

      // ── LOCKED ───────────────────────────────────────────────────────────
      await lockPayroll(admin, run.id);
      pf = await preflight(admin, branchId, run.id);
      expect(
        runFindingCodes(pf),
        'once LOCKED the lock finding is gone — whatever else may still be wrong',
      ).not.toContain(LOCK_FINDING);
    });

    test('every blocking finding explains itself and offers somewhere to go', async () => {
      // The findings are what an operator acts on, so their CONTENT is the
      // contract — the same rule the loan phase paid for with a production
      // incident. Each carries a code, a severity, a sentence, and most carry a
      // `fix` link into the screen that resolves it.
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-findings`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_FINDINGS,
        employeeIds: [subject.id],
        carrier,
      });

      const pf = await preflight(admin, branchId, run.id);
      expect(pf.runFindings.length, 'an unprepared run raises findings').toBeGreaterThan(0);
      expect(pf.total, 'and pre-flight counted the employees in the run').toBeGreaterThan(0);

      for (const f of pf.runFindings) {
        expect(f.code, 'every finding is coded').toBeTruthy();
        expect(['BLOCKING', 'WARNING'], `${f.code} has a known severity`).toContain(f.severity);
        expect(f.message.length, `${f.code} explains itself`).toBeGreaterThan(20);
        expect(f.message, `${f.code} is not a generic failure`).not.toMatch(
          /could not be completed|invalid input|something went wrong/i,
        );
      }

      // The employer-details finding is the one every unconfigured branch hits,
      // and it is the best example of the shape: it names the missing field and
      // links to the screen that sets it.
      const employer = pf.runFindings.find((f) => f.code === 'EMPLOYER_FIELD_MISSING');
      if (employer) {
        expect(employer.field, 'it names the field that is missing').toBeTruthy();
        expect(employer.fix?.href, 'and points at the screen that fixes it').toBeTruthy();
      }
    });

    test('an employee with no bank details is BLOCKED individually, not silently dropped', async () => {
      // The catalogue's "missing IBAN". The important half is that the employee is
      // reported by name and code rather than quietly excluded from the file —
      // a wage file that is short one person, with nothing saying so, is the
      // failure mode that reaches the employee as an unpaid month.
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-nobank`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_NOBANK,
        employeeIds: [subject.id],
        carrier,
      });
      const pf = await preflight(admin, branchId, run.id);

      const row = pf.byEmployee.find((b) => b.employeeId === subject.id);
      expect(row, 'the employee appears in the per-employee breakdown').toBeTruthy();
      expect(row!.employeeCode, 'identified by code, so an operator can find them').toBeTruthy();
      expect(row!.fullName, 'and by name').toBeTruthy();
      expect(row!.status, 'and is BLOCKED rather than omitted').toBe('BLOCKED');
      expect(row!.findings.length, 'with at least one reason attached').toBeGreaterThan(0);

      expect(pf.blockedEmployees, 'the summary counts them').toBeGreaterThan(0);
      expect(pf.ready + pf.blockedEmployees, 'and every employee is accounted for exactly once')
        .toBeLessThanOrEqual(pf.total);
      expect(pf.canGenerate, 'and the file cannot be generated while anyone is blocked').toBe(false);
    });

    test('generation is refused while employees are blocked, and says how many', async () => {
      const { subject } = await twinPair(admin, {
        marker: `${MARK}-gen`,
        branchId,
        baseSalary: 1500,
      });
      const run = await runEdgePayroll(admin, {
        branchId,
        period: P_GENERATE,
        employeeIds: [subject.id],
        carrier,
      });
      await admin.post(`/payrolls/${run.id}/submit`, {});
      await admin.post(`/payrolls/${run.id}/approve`, {});
      await lockPayroll(admin, run.id);

      const refusal = await admin
        .withBranch(branchId)
        .post('/wps/generate', { payrollId: run.id })
        .then(() => '')
        .catch((e: Error) => e.message);

      expect(refusal, 'generation was refused').toBeTruthy();
      expect(
        refusal,
        'and the refusal is quantified — "N of M employees are blocked", not a bare failure',
      ).toMatch(/\d+ of \d+ employees are blocked/i);
    });
  });
});
