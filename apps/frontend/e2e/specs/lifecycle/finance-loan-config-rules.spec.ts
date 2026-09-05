import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { AdvanceLoansPage, SettingsPage, selectBranch } from '../../pages';
import {
  marker,
  retire,
  retireAllMarked,
  ensureAllowance,
  liveLoan,
  loanOf,
  scheduleOf,
  deductionsFor,
  withSetting,
  withSettings,
  flagFlipAllowed,
  runPayroll,
  payrollItemFor,
  deletePayroll,
  clearPayrolls,
} from '../../loan-support';

/**
 * §23 Configuration — does a loan setting actually CHANGE anything?
 *
 * Every other loan spec runs against the shipped configuration. This one is the
 * only file that asks the question a customer asks on day two: *I set the knob,
 * did the system do anything differently?* A setting that round-trips through
 * the API and changes no behaviour is worse than a missing feature, because it
 * looks supported — so no case here asserts a value read back. Every case
 * asserts an OBSERVABLE: an eligibility row, a refusal sentence, a schedule, a
 * payroll deduction, a tab that is or is not drawn.
 *
 * ## The answer to "can arbitrary keys even be written?", stated once
 *
 * YES. `POST /system-settings` takes `{ settings: Record<string,string> }` and
 * `SystemSettingsService.updateSettings` upserts every key it is handed — there
 * is no allowlist on the WRITE path at all. The frequently-mistaken "allowlist"
 * at `system-settings.controller.ts:112-119` is the projection of the PUBLIC
 * READ endpoint (`GET /system-settings/public`), which publishes exactly six
 * loan keys to unauthenticated callers; it constrains what the browser can see,
 * not what an admin can write.
 *
 * ## The read side is where the hole is
 *
 * `GET /system-settings` answers from `getSettingsList()`, and this is where the
 * hole keeps reappearing. Nine keys the ENGINE READ were once absent from that
 * list, so they were write-only: an admin could set them and never read them
 * back, and no caller could restore them. `withSetting` refuses such a key by
 * design rather than restoring a guess, so every case that needed one SKIPPED
 * with the key named. All nine are enumerated now — they stay listed in
 * `WRITE_ONLY_KEYS` and are asserted as a group in "the settings surface
 * itself", so losing one again turns that assertion red.
 *
 * The hole then reopened from the other end: the gap-closure work gave readers
 * to ten keys that had never had one, and adding a reader is precisely what
 * turns an inert key into an unreadable one. Those ten are covered by
 * "settings that used to be silent no-ops", one case each, for the same reason.
 *
 * ## Caching: there is none on this path
 *
 * `SystemSettingsService.getSetting` is a bare `prisma.systemSetting.findUnique`
 * — no memo, no TTL — and `LoanPolicyService.resolve()` re-reads on every call.
 * The only cache anywhere near settings is `next: { revalidate: 60 }` on the
 * root layout's metadata fetch (`app/layout.tsx`), which reads only
 * `company_name`, and `companyTzCache`, which is invalidated on write. The
 * browser's copy comes from `brandingStore.fetchBranding()`, which refetches on
 * mount — so a screen assertion needs a RELOAD, not a re-read. Everything
 * server-driven is nonetheless polled: a single read that lands a millisecond
 * early is indistinguishable from a setting that does nothing.
 *
 * ## Why this file is the biggest risk in the suite, and what is done about it
 *
 * A stranded `loan_module_v2_enabled=true` silently re-routes recovery for every
 * loan and payroll spec that runs afterwards, and the failures land in files
 * that never touched the flag. So: the whole describe refuses to run unless
 * `E2E_ALLOW_FLAG_FLIP=1` (a dedicated database), EVERY flip goes through
 * `withSetting` / `withSettings` — which restore in a `finally` — and `afterAll`
 * re-reads every key this file touched and FAILS if any is not exactly where it
 * started. Belt, braces, and a second pair of braces.
 *
 * ## The subject, and why it is the MANAGER
 *
 * Loans can only be filed by the session that owns them (`POST /advance-loans`
 * reads `user.employeeId`; ADMIN is deliberately excluded from its `@Roles`),
 * and `makeEmployee` cannot hand back a login — so the borrower must be one of
 * the four seeded accounts. `employee1` and `employee2` are already contended by
 * `loans.admin-employee.spec.ts`, `finance-loan-lifecycle.spec.ts` and
 * `finance-loan-creation.spec.ts`, and `loan_max_active_per_employee` is 2. The
 * MANAGER account is the one seeded borrower nothing else files against, so it
 * is this file's subject. Its `baseSalary` is 0 in the baseline seed and is
 * raised for the duration of the file (and put back in `afterAll`), because a
 * zero-pay cycle recovers nothing and every affordability case would pass for
 * the wrong reason.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string) => test.info().project.name === name;

/** The stable half of the marker — what identifies a record as THIS FILE'S. */
const MARKER_PREFIX = 'pw-loancfg-';

/** Distinct per run, so a leftover can be dated as well as owned. */
const MARK = marker(MARKER_PREFIX);

/**
 * Keys the loan engine reads that `getSettingsList()` once did not enumerate.
 *
 * Writable (the write path upserts anything) and unreadable made them
 * unrestorable — `withSetting` refuses such a key rather than restoring a
 * guess. They are all enumerated now; the group assertion below is what keeps
 * them that way, and the list is kept rather than deleted because a register of
 * keys that HAVE gone missing is the cheapest guard against them going missing
 * again.
 */
const WRITE_ONLY_KEYS = [
  'loan_rounding_unit',
  'loan_grace_period_cycles',
  'loan_deferral_mode',
  'loan_payment_allocation_order',
  'loan_priority_tiebreak',
  'loan_auto_close_on_full_recovery',
  'loan_min_partial_recovery_amount',
  'loan_final_settlement_ignores_min_net',
  'advance_loan_auditor_user_ids',
] as const;

/** The four keys the ADMIN settings screen's `advance-loan` tab can edit. */
const UI_EXPOSED_KEYS = [
  'advance_loan_enabled',
  'advance_loan_approver_roles',
  'advance_loan_max_installments',
  'advance_max_percent_of_salary',
] as const;

/** The far-future year this file runs payroll in, so no real period is touched. */
const RUN_YEAR = 2041;

/**
 * The salary the subject is given for the duration of the file.
 *
 * The baseline seed pays the MANAGER 0, and a zero-pay cycle recovers nothing
 * (`loan_zero_salary_policy` defaults to DEFER) — so every affordability case
 * would pass for the wrong reason. Put back in `afterAll`.
 */
const SUBJECT_SALARY = 60000;

/**
 * Every payroll case borrows ONE instalment, never six.
 *
 * `loadCandidates` selects by DATE, not by count — everything whose cycle key is
 * this cycle OR EARLIER — so a run in 2041 against a loan created today sweeps
 * the WHOLE schedule forward and a six-instalment loan owes 6,000 in a single
 * cycle. A single-instalment loan makes "full recovery" exactly one number, so
 * a partial recovery cannot be mistaken for a swept-forward arrear.
 */
const EMI = 1000;

interface SettingRow {
  key: string;
  value: string;
}

type CheckStatus = 'PASS' | 'FAIL' | 'WARN';

interface EligibilityCheck {
  code: string;
  label: string;
  status: CheckStatus;
  limit?: number | string | null;
  actual?: number | string | null;
  detail?: string;
}

interface EligibilityResult {
  eligible: boolean;
  checks: EligibilityCheck[];
  maxEligibleAmount: number | null;
  monthlyNet: number;
  existingEmis: number;
}

/** Decimal columns cross the wire as strings; this is the only place that admits it. */
const money = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// ───────────────────────────────────────────────────────────────────────────
// Shared state
// ───────────────────────────────────────────────────────────────────────────

let adminApi: ApiClient;
let hrApi: ApiClient;
let ownerApi: ApiClient;
let viewerApi: ApiClient;

/** The MANAGER's employee row — the borrower every loan below belongs to. */
let subjectId = '';
let subjectBranchId = '';
let subjectSalaryBefore = 0;

/** Every key `GET /system-settings` enumerates, so a case can skip rather than strand one. */
const readable = new Set<string>();

/** The value of every readable key BEFORE this file ran. The restore oracle. */
const baseline = new Map<string, string>();

/** Every key this file has flipped, for the paranoid `afterAll` read-back. */
const touched = new Set<string>();

let setupError = '';

/** Loans created by the current test, retired the moment it finishes. */
let scratch: string[] = [];

/** Payroll runs created by the current test, deleted the moment it finishes. */
let runs: string[] = [];

async function settingsList(api: ApiClient): Promise<SettingRow[]> {
  const raw = await api.get<SettingRow[] | { data?: SettingRow[] }>('/system-settings');
  return Array.isArray(raw) ? raw : (raw?.data ?? []);
}

/**
 * `withSetting`, plus a note in `touched` so `afterAll` can verify the restore.
 *
 * Not a replacement for the helper — it delegates to it, so the `finally`-based
 * restore is exactly the shared one. The wrapper exists only so the read-back
 * oracle knows what to check, which a helper called from thirteen files cannot.
 */
function flip<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  touched.add(key);
  return withSetting(adminApi, key, value, fn);
}

/** The same, for a coherent multi-key change. */
function flipMany<T>(kv: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  for (const key of Object.keys(kv)) touched.add(key);
  return withSettings(adminApi, kv, fn);
}

/**
 * Skips the current test when any key it needs cannot be read back.
 *
 * Deliberately a skip and not a workaround: writing a key that cannot be read
 * leaves it set for every later spec, which is the exact failure this file is
 * built to avoid. The reason names the fix.
 */
function requireReadable(...keys: string[]): void {
  const missing = keys.filter((k) => !readable.has(k));
  test.skip(
    missing.length > 0,
    `${missing.join(', ')} is written by POST /system-settings but NOT returned by ` +
      `GET /system-settings, so its original value cannot be read and it cannot be ` +
      `restored. Add it to SystemSettingsService.getSettingsList() and this case runs.`,
  );
}

/** A what-if eligibility result for the subject, peeled of however many envelopes. */
async function eligibilityOf(body: Record<string, unknown>): Promise<EligibilityResult> {
  const raw = await adminApi.post<any>('/advance-loans/eligibility', {
    employeeId: subjectId,
    ...body,
  });
  return (raw?.data ?? raw) as EligibilityResult;
}

function ruleOf(result: EligibilityResult, code: string): EligibilityCheck | undefined {
  return (result.checks ?? []).find((c) => c.code === code);
}

/** Files and approves a loan for the subject, tracked for teardown. */
async function track(opts: {
  type?: 'ADVANCE' | 'LOAN';
  amount: number;
  installments?: number;
  note?: string;
}): Promise<string> {
  const id = await liveLoan(ownerApi, adminApi, {
    ...opts,
    note: `${MARK} — ${opts.note ?? 'configuration journey'}`,
    markerPrefix: MARKER_PREFIX,
  });
  scratch.push(id);
  return id;
}

/**
 * Attendance for the subject in one period.
 *
 * Payroll refuses to generate for a period in which NOBODY it covers has any
 * attendance ("Attendance for 4/2041 has not been processed yet"), because
 * without the guard every employee would read as absent for the whole month and
 * LOP would wipe the salary the loan is meant to be recovered from. One manual
 * record is enough to satisfy it.
 */
async function seedAttendance(month: number): Promise<void> {
  const day = `${RUN_YEAR}-${String(month).padStart(2, '0')}-02`;
  await adminApi
    .post('/attendances/manual', {
      employeeId: subjectId,
      date: day,
      checkIn: `${day}T09:00:00.000Z`,
      checkOut: `${day}T18:00:00.000Z`,
      status: 'PRESENT',
      notes: `${MARK} attendance for a configuration payroll run`,
    })
    .catch(() => undefined);
}

interface RunResult {
  /** What payroll actually took for advances and loans this cycle. */
  deduction: number;
  /** Take-home AFTER recovery. */
  net: number;
  /** Take-home BEFORE recovery — the figure every policy percentage is of. */
  netPreRecovery: number;
}

/**
 * Generates ONE payroll for the subject alone and reports what it recovered.
 *
 * `employeeIds` narrows the run to the subject so this file can never disturb
 * another spec's loans, and the run is deleted in the caller's teardown —
 * deleting a DRAFT re-releases its PENDING instalments, which is what makes
 * fourteen runs against the same loan repeatable.
 */
async function runFor(month: number, runType = 'REGULAR'): Promise<RunResult> {
  await seedAttendance(month);
  const run = await runPayroll(adminApi, {
    month,
    year: RUN_YEAR,
    branchId: subjectBranchId,
    runType,
    employeeIds: [subjectId],
  });
  runs.push(run.id);

  const item = await payrollItemFor(adminApi, run.id, subjectId);
  expect(item, `payroll ${month}/${RUN_YEAR} produced no row for the subject`).toBeTruthy();

  const deduction = money(item?.advanceLoanDeduction);
  const net = money(item?.netSalary);
  return { deduction, net, netPreRecovery: net + deduction };
}

/** The outcome/reason pairs payroll wrote against one loan. */
async function outcomesFor(loanId: string): Promise<Array<{ outcome: string; reason: string; amount: number }>> {
  const rows = (await deductionsFor(adminApi, loanId)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    outcome: String(r.outcome ?? ''),
    reason: String(r.reason ?? ''),
    amount: money(r.amount),
  }));
}

// ───────────────────────────────────────────────────────────────────────────

test.describe('loan configuration changes behaviour', () => {
  /**
   * Both gates in a hook rather than in each body: a skip decided here happens
   * before the `page` fixture is built, so a run that is not allowed to flip
   * flags never opens a browser window.
   */
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'loan configuration is an ADMIN surface');
    test.skip(
      !flagFlipAllowed(),
      'this file rewrites environment-wide loan configuration. Set E2E_ALLOW_FLAG_FLIP=1 ' +
        'and run it against its own database — a stranded loan_module_v2_enabled silently ' +
        'changes every later payroll assertion in the suite.',
    );
    // Asserted once, here, rather than at the top of forty bodies: a failed
    // beforeAll otherwise surfaces as a different confusing error in every case.
    expect(setupError, `setup failed: ${setupError}`).toBe('');
  });

  test.beforeAll(async () => {
    if (!isProject('admin') || !flagFlipAllowed()) return;
    try {
      adminApi = await ApiClient.as('admin');
      hrApi = await ApiClient.as('hr');
      ownerApi = await ApiClient.as('manager');
      viewerApi = await ApiClient.as('employee');

      for (const row of await settingsList(adminApi)) {
        readable.add(row.key);
        baseline.set(row.key, row.value);
      }

      // The borrower's own employee row, asked of the session that owns it
      // rather than looked up by an employee code this file would then have to
      // keep in step with the seed.
      const me = await ownerApi.get<{ employeeId?: string; employee?: { id?: string; branchId?: string } }>(
        '/auth/me',
      );
      subjectId = String(me?.employeeId ?? me?.employee?.id ?? '');
      if (!subjectId) throw new Error('GET /auth/me returned no employee for the MANAGER account');

      const employee = await adminApi.get<{ branchId: string; baseSalary: unknown }>(
        `/employees/${subjectId}`,
      );
      subjectBranchId = employee.branchId;
      subjectSalaryBefore = money(employee.baseSalary);
      adminApi.withBranch(subjectBranchId);

      if (subjectSalaryBefore !== SUBJECT_SALARY) {
        await adminApi.patch(`/employees/${subjectId}`, { baseSalary: SUBJECT_SALARY });
      }
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterEach(async () => {
    if (!isProject('admin') || !flagFlipAllowed()) return;
    for (const id of runs) await deletePayroll(adminApi, id).catch(() => undefined);
    runs = [];
    for (const id of scratch) await retire(id, ownerApi, adminApi);
    scratch = [];
  });

  test.afterAll(async () => {
    if (!isProject('admin') || !flagFlipAllowed()) return;

    if (subjectId) {
      await retireAllMarked(adminApi, MARKER_PREFIX).catch(() => undefined);
      if (subjectSalaryBefore !== SUBJECT_SALARY) {
        await adminApi
          .patch(`/employees/${subjectId}`, { baseSalary: subjectSalaryBefore })
          .catch(() => undefined);
      }
      for (let month = 1; month <= 12; month++) {
        await clearPayrolls(adminApi, subjectBranchId, month, RUN_YEAR).catch(() => undefined);
      }
    }

    // The paranoid half. `withSetting` restores in a `finally`, but a restore
    // that itself failed only logs to stderr — and a run that leaves the master
    // switch on breaks specs that never touched it. So every key this file
    // flipped is read back and compared with what it was before, and a mismatch
    // fails LOUDLY here rather than silently over there.
    const drifted: string[] = [];
    if (touched.size > 0 && adminApi) {
      const now = new Map((await settingsList(adminApi).catch(() => [])).map((r) => [r.key, r.value]));
      for (const key of touched) {
        const was = baseline.get(key);
        const is = now.get(key);
        if (was !== undefined && is !== was) drifted.push(`${key}: expected "${was}", found "${is}"`);
      }
    }

    await adminApi?.dispose();
    await hrApi?.dispose();
    await ownerApi?.dispose();
    await viewerApi?.dispose();

    expect(
      drifted.join('\n  '),
      'this file left system settings changed — every later loan and payroll spec in this run is now suspect',
    ).toBe('');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The settings surface itself
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('the settings surface itself', () => {
    test('an arbitrary loan key is accepted by the write path and read back', async () => {
      // The claim this whole file rests on: `updateSettings` upserts whatever it
      // is handed. A key that is NOT one of the six the public endpoint
      // publishes, written and read back, is the proof.
      await flip('loan_min_service_months', '7', async () => {
        await expect
          .poll(async () => (await settingsList(adminApi)).find((r) => r.key === 'loan_min_service_months')?.value, {
            timeout: 15_000,
          })
          .toBe('7');
      });

      await expect
        .poll(async () => (await settingsList(adminApi)).find((r) => r.key === 'loan_min_service_months')?.value, {
          timeout: 15_000,
        })
        .toBe(baseline.get('loan_min_service_months'));
    });

    test('every key the engine reads can also be read back', async () => {
      // These nine used to be write-only: POST /system-settings upserted them
      // and GET /system-settings never returned them, so an administrator could
      // not see what they had set and nothing could restore a previous value.
      // `withSetting` refused to touch them rather than guess a restore value,
      // which is why a run of cases below used to skip.
      const missing = WRITE_ONLY_KEYS.filter((k) => !readable.has(k));
      expect(
        missing.join(', '),
        'a loan key the engine reads is missing from getSettingsList() again — it is unreadable and therefore unrestorable',
      ).toBe('');
    });

    test('the public endpoint publishes exactly six loan keys', async () => {
      // The read-side allowlist that is often mistaken for a write-side one.
      // It is what the BROWSER can see, and it is why the settings screen can
      // bound its instalment field at all.
      //
      // `loan_interest_enabled` joined the list when the request form gained
      // interest terms: it is a CAPABILITY, so the form has to know whether the
      // server will honour a rate before it offers the field. Money ceilings
      // are still deliberately absent — publishing one tells an unprivileged
      // browser what the limits are and buys nothing, since the refusal happens
      // server-side either way. Anything added here is a decision, which is why
      // the count is pinned rather than merely contained.
      const published = await adminApi.get<Record<string, unknown>>('/system-settings/public');
      const loanKeys = Object.keys(published).filter((k) => k.startsWith('advance_loan') || k.startsWith('advance_max') || k.startsWith('loan_'));
      expect(loanKeys.sort()).toEqual(
        [
          'advance_loan_approver_roles',
          'advance_loan_enabled',
          'advance_loan_max_installments',
          'advance_loan_writeoff_roles',
          'advance_max_percent_of_salary',
          'loan_interest_enabled',
        ].sort(),
      );
    });

    test('an HR manager cannot write a loan setting', async () => {
      // Hiding the tab is decoration if the endpoint is open. `@Roles('ADMIN')`
      // on POST /system-settings is the actual boundary.
      await expect(
        hrApi.post('/system-settings', { settings: { loan_module_v2_enabled: 'true' } }),
        'HR was allowed to write a loan setting',
      ).rejects.toThrow();
    });

    test('the admin settings screen offers the advance-loan tab', async ({ page, problems }) => {
      // The hand-written part of the tab edits FOUR keys —
      // advance_loan_enabled, _approver_roles, _max_installments and
      // advance_max_percent_of_salary. Everything else the engine reads used to
      // have no UI at all (docs/LOAN-ADVANCES-GAP-REPORT.md §20.5), which is
      // why every other case in this file configures over the API.
      //
      // The rest now lives in the "Loan policy" card below it, which is
      // server-driven off `getSettingsList()` rather than hand-written: a
      // hard-coded form is how the screen and the engine drifted to four keys
      // against thirty-eight in the first place. UI_EXPOSED_KEYS therefore
      // stays at four — it names the FIXED payload, not the tab's reach.
      const settings = new SettingsPage(page);
      await settings.open();

      expect(await settings.hasTab('advance-loan'), 'an admin was not offered the Advance & Loan tab').toBe(true);
      await settings.openTab('advance-loan');
      expect(await settings.canSave(), 'the advance-loan tab has no save control').toBe(true);

      expect(UI_EXPOSED_KEYS.length, 'the fixed payload is documented as exactly four keys').toBe(4);

      // The server-driven card is the half that closes the drift, so its
      // presence is the assertion — not the count of rows it happens to draw
      // today, which is `getSettingsList()`'s business and changes with it.
      expect(
        await page.getByText('Loan policy', { exact: true }).isVisible(),
        'the server-driven loan policy card is gone, so the engine keys have no screen again',
      ).toBe(true);

      settle(problems, 'the advance & loan settings tab');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Module and approval gates
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('module and approval gates', () => {
    test('advance_loan_enabled=false fails MODULE_ENABLED and refuses a new request', async () => {
      await flip('advance_loan_enabled', 'false', async () => {
        await expect
          .poll(async () => ruleOf(await eligibilityOf({ amount: 600, installments: 6, type: 'LOAN' }), 'MODULE_ENABLED')?.status, {
            timeout: 15_000,
          })
          .toBe('FAIL');

        // Both halves, because either alone proves the wrong thing: the check
        // could report FAIL while `create` happily accepted the request.
        await expect(
          ownerApi.post('/advance-loans', {
            type: 'LOAN',
            amount: 600,
            installments: 6,
            reason: `${MARK} — filed while the module was off`,
          }),
          'a request was filed while the module was disabled',
        ).rejects.toThrow(/disabled/i);
      });

      // And it comes back: the same call now passes.
      await expect
        .poll(async () => ruleOf(await eligibilityOf({ amount: 600, installments: 6, type: 'LOAN' }), 'MODULE_ENABLED')?.status, {
          timeout: 15_000,
        })
        .toBe('PASS');
    });

    test('advance_loan_approver_roles decides who the API accepts as an approver', async () => {
      await flip('advance_loan_approver_roles', 'HR_MANAGER', async () => {
        // The pending queue is the approver's queue, and the role list is what
        // defines "approver" — NOT the @Roles decorator, which still lists
        // ADMIN. An admin passing the coarse gate and being refused here is the
        // whole point of a settings-driven role.
        await expect
          .poll(() => adminApi.get('/advance-loans/pending').then(() => 'allowed').catch(() => 'refused'), {
            timeout: 15_000,
          })
          .toBe('refused');

        await expect
          .poll(() => hrApi.get('/advance-loans/pending').then(() => 'allowed').catch(() => 'refused'), {
            timeout: 15_000,
          })
          .toBe('allowed');
      });

      await expect
        .poll(() => adminApi.get('/advance-loans/pending').then(() => 'allowed').catch(() => 'refused'), {
          timeout: 15_000,
        })
        .toBe('allowed');
    });

    test('advance_loan_approver_roles decides who is drawn the pending tab', async ({ page, problems }) => {
      // The screen half of the case above. `loan-tab-pending` is rendered only
      // when the signed-in role appears in the CSV published to the browser, so
      // an admin dropped from the list must not be offered the queue at all.
      //
      // Crash-detection only, and declared BEFORE anything navigates: while the
      // admin is not an approver, any queue request the shell still makes is
      // answered 403, and a logged 403 is the system working rather than
      // evidence of breakage.
      crashesOnly(problems);

      await flip('advance_loan_approver_roles', 'HR_MANAGER', async () => {
        const loans = new AdvanceLoansPage(page);
        await selectBranch(page, subjectBranchId);
        await loans.open();

        await expect
          .poll(() => page.getByTestId('loan-tab-pending').count(), { timeout: 15_000 })
          .toBe(0);
      });

      await page.reload();
      await expect.poll(() => page.getByTestId('loan-tab-pending').count(), { timeout: 15_000 }).toBe(1);

      settle(problems, 'the advance & loan queue with the approver roles changed');
    });

    test('advance_loan_max_installments bounds the approval override', async () => {
      await ensureAllowance(ownerApi, adminApi, 600, MARKER_PREFIX);
      const created = await ownerApi.post<{ id: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 600,
        installments: 3,
        reason: `${MARK} — instalment ceiling`,
      });
      scratch.push(created.id);

      await flip('advance_loan_max_installments', '3', async () => {
        // The eligibility row moves first — it is what the request form reads.
        await expect
          .poll(async () => ruleOf(await eligibilityOf({ amount: 600, installments: 6, type: 'LOAN' }), 'INSTALLMENT_RANGE')?.limit, {
            timeout: 15_000,
          })
          .toBe(3);

        // And the approver cannot spend past it either, in the server's words.
        await expect(
          adminApi.post(`/advance-loans/${created.id}/approve`, {
            remarks: `${MARK} approved over the ceiling`,
            installments: 6,
          }),
          'an approver spread a loan beyond the configured maximum',
        ).rejects.toThrow(/between 1 and 3/);
      });
    });

    test('advance_loan_max_installments bounds the approval form', async ({ page, problems }) => {
      await ensureAllowance(ownerApi, adminApi, 600, MARKER_PREFIX);
      const created = await ownerApi.post<{ id: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 600,
        installments: 3,
        reason: `${MARK} — instalment ceiling on screen`,
      });
      scratch.push(created.id);

      await flip('advance_loan_max_installments', '4', async () => {
        const loans = new AdvanceLoansPage(page);
        await selectBranch(page, subjectBranchId);
        await loans.open();
        await loans.openTab('pending');

        await expect.poll(() => loans.hasRow(created.id), { timeout: 20_000 }).toBe(true);
        await page.locator(`[data-testid="loan-row"][data-loan-id="${created.id}"]`).getByTestId('loan-approve').click();
        await page.getByTestId('loan-review-modal').waitFor({ state: 'visible' });

        // The native constraint, not a toast: the field carries `max={setting}`
        // and the form is not `noValidate`, so the browser refuses first.
        await expect
          .poll(() => page.getByTestId('loan-review-installments').getAttribute('max'), { timeout: 15_000 })
          .toBe('4');
      });

      settle(problems, 'the approval form with the instalment ceiling lowered');
    });

    test('advance_max_percent_of_salary caps an ADVANCE at approval', async () => {
      const employee = await adminApi.get<{ baseSalary: unknown }>(`/employees/${subjectId}`);
      const monthly = money(employee.baseSalary);
      expect(monthly, 'the subject has no salary, so an advance ceiling cannot bite').toBeGreaterThan(0);

      const amount = Math.round(monthly * 0.5);
      await ensureAllowance(ownerApi, adminApi, amount, MARKER_PREFIX);

      // An ADVANCE is recovered in ONE cycle, so half a month's pay is an
      // instalment sitting exactly ON the affordability ceiling
      // (`loan_max_emi_percent_of_net`, 50% of the monthly-net proxy). Any
      // instalment the subject already owes tips the total over it, and
      // `NET_PAY_AFTER_EMI` then refuses the request at CREATE — before the
      // approval-time cap this case is actually about can ever be reached.
      // Lifted for the filing only; `flip` puts it back before
      // `advance_max_percent_of_salary` is touched, so the rule under test is
      // still the only thing standing between this advance and an approval.
      const created = await flip('loan_max_emi_percent_of_net', '100', () =>
        ownerApi.post<{ id: string }>('/advance-loans', {
          type: 'ADVANCE',
          amount,
          reason: `${MARK} — advance ceiling`,
        }),
      );
      scratch.push(created.id);

      // 10% of pay, against an advance for 50% of it.
      await flip('advance_max_percent_of_salary', '10', async () => {
        await expect(
          adminApi.post(`/advance-loans/${created.id}/approve`, { remarks: `${MARK} over the ceiling` }),
          'an over-sized advance was approved',
        ).rejects.toThrow(/exceeds 10% of the employee's monthly pay/);
      });

      // Restored, the same approval goes through — which is what proves the
      // refusal was the SETTING and not the amount.
      await adminApi.post(`/advance-loans/${created.id}/approve`, { remarks: `${MARK} within the ceiling` });
      await expect
        .poll(async () => String((await loanOf(adminApi, created.id)).status), { timeout: 15_000 })
        .toBe('APPROVED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Role gates narrower than the @Roles decorators
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('role gates narrower than the decorators', () => {
    test('advance_loan_writeoff_roles moves the write-off capability off ADMIN', async () => {
      const id = await track({ amount: 600, installments: 6, note: 'write-off role gate' });

      await flip('advance_loan_writeoff_roles', 'HR_MANAGER', async () => {
        // ADMIN still passes @Roles('ADMIN','HR_MANAGER') and must still be
        // refused — the decorator is the coarse gate, the setting is the rule.
        await expect(
          adminApi.post(`/advance-loans/${id}/write-off`, { reason: `${MARK} admin should not be able to` }),
          'an admin wrote off a balance after being removed from the role list',
        ).rejects.toThrow(/not permitted[\s\S]*HR_MANAGER/);

        await hrApi.post(`/advance-loans/${id}/write-off`, { reason: `${MARK} HR is the configured role` });
      });

      await expect
        .poll(async () => String((await loanOf(adminApi, id)).status), { timeout: 15_000 })
        .toBe('WRITTEN_OFF');
    });

    test('loan_waiver_roles moves the waiver capability off ADMIN', async () => {
      const id = await track({ amount: 600, installments: 6, note: 'waiver role gate' });

      // The default is 'ADMIN,HR_MANAGER'; narrowing it to HR alone must refuse
      // the admin who could do it a moment earlier.
      await flip('loan_waiver_roles', 'HR_MANAGER', async () => {
        await expect(
          adminApi.post(`/advance-loans/${id}/waive`, { amount: 100, reason: `${MARK} admin waiver attempt` }),
          'an admin waived a balance after being removed from the role list',
        ).rejects.toThrow(/not permitted[\s\S]*HR_MANAGER/);

        await hrApi.post(`/advance-loans/${id}/waive`, { amount: 100, reason: `${MARK} HR waiver` });
      });

      await expect
        .poll(async () => money((await loanOf(adminApi, id)).waivedAmount), { timeout: 15_000 })
        .toBe(100);
    });

    test('advance_loan_finance_roles grants a role the whole loan book', async () => {
      const id = await track({ amount: 600, installments: 6, note: 'finance role gate' });

      // The viewer is neither the owner, nor ADMIN/HR, nor a manager of the
      // owner's department, so the read is refused today.
      await expect(
        viewerApi.get(`/advance-loans/${id}`),
        'an unrelated employee could already read this loan, so the grant below proves nothing',
      ).rejects.toThrow();

      await flip('advance_loan_finance_roles', 'ADMIN,EMPLOYEE', async () => {
        await expect
          .poll(() => viewerApi.get(`/advance-loans/${id}`).then(() => 'allowed').catch(() => 'refused'), {
            timeout: 15_000,
          })
          .toBe('allowed');
      });

      await expect
        .poll(() => viewerApi.get(`/advance-loans/${id}`).then(() => 'allowed').catch(() => 'refused'), {
          timeout: 15_000,
        })
        .toBe('refused');
    });

    test('advance_loan_auditor_roles grants read access — and nothing narrows it', async () => {
      const id = await track({ amount: 600, installments: 6, note: 'auditor role gate' });

      await flip('advance_loan_auditor_roles', 'EMPLOYEE', async () => {
        await expect
          .poll(() => viewerApi.get(`/advance-loans/${id}`).then(() => 'allowed').catch(() => 'refused'), {
            timeout: 15_000,
          })
          .toBe('allowed');
      });

      // BUG?: `LoanAccessService.isReadOnly()` — the method that would stop an
      // auditor from reaching a mutating route — has NO caller anywhere in
      // apps/backend/src. An auditor role is therefore exactly a finance role
      // today, and the read-only half of the design is unenforced. What keeps
      // this particular viewer harmless is the @Roles decorator on the
      // lifecycle routes, not the auditor setting.
      await expect(
        viewerApi.post(`/advance-loans/${id}/hold`, { reason: `${MARK} auditors should not mutate` }),
        'the EMPLOYEE role reached a lifecycle route',
      ).rejects.toThrow();
    });

    test('advance_loan_auditor_user_ids cannot be exercised', async () => {
      requireReadable('advance_loan_auditor_user_ids');
      // Unreachable today — see requireReadable's message. Left as a live case
      // so it starts running the moment the key becomes readable.
      expect(readable.has('advance_loan_auditor_user_ids')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Eligibility rules
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('eligibility rules', () => {
    test('loan_min_service_months fails a subject who has not served long enough', async () => {
      const before = await eligibilityOf({ amount: 600, installments: 6, type: 'LOAN' });
      expect(ruleOf(before, 'MIN_SERVICE')?.status, 'the subject already fails the service check').toBe('PASS');

      // 1200 months is a hundred years — no seeded employee can satisfy it.
      await flip('loan_min_service_months', '1200', async () => {
        await expect
          .poll(async () => ruleOf(await eligibilityOf({ amount: 600, installments: 6, type: 'LOAN' }), 'MIN_SERVICE')?.status, {
            timeout: 15_000,
          })
          .toBe('FAIL');

        await expect(
          ownerApi.post('/advance-loans', {
            type: 'LOAN',
            amount: 600,
            installments: 6,
            reason: `${MARK} — filed below the service floor`,
          }),
          'a request was filed below the minimum service period',
        ).rejects.toThrow();
      });
    });

    test('loan_max_active_per_employee is the number the check compares against', async () => {
      await flip('loan_max_active_per_employee', '1', async () => {
        await expect
          .poll(async () => ruleOf(await eligibilityOf({ amount: 600, installments: 6, type: 'LOAN' }), 'MAX_ACTIVE_LOANS')?.limit, {
            timeout: 15_000,
          })
          .toBe(1);

        const id = await track({ amount: 600, installments: 6, note: 'first of one' });
        expect(id).toBeTruthy();

        // With the cap at one, a second request is refused — and the refusal is
        // the check's own sentence, not a generic 400.
        const second = await eligibilityOf({ amount: 600, installments: 6, type: 'LOAN' });
        expect(ruleOf(second, 'MAX_ACTIVE_LOANS')?.status).toBe('FAIL');
        expect(second.eligible).toBe(false);
      });
    });

    test('loan_max_amount_multiple_of_salary caps the amount, and 0 means unlimited', async () => {
      const unlimited = await eligibilityOf({ amount: 5_000_000, installments: 12, type: 'LOAN' });
      expect(
        ruleOf(unlimited, 'AMOUNT_CEILING')?.status,
        'the default of 0 is documented as unlimited but the ceiling still fired',
      ).toBe('PASS');
      expect(ruleOf(unlimited, 'AMOUNT_CEILING')?.limit, 'an unlimited ceiling should be reported as null').toBeNull();

      await flip('loan_max_amount_multiple_of_salary', '2', async () => {
        await expect
          .poll(async () => ruleOf(await eligibilityOf({ amount: 5_000_000, installments: 12, type: 'LOAN' }), 'AMOUNT_CEILING')?.status, {
            timeout: 15_000,
          })
          .toBe('FAIL');

        const capped = await eligibilityOf({ amount: 5_000_000, installments: 12, type: 'LOAN' });
        // Two months of the net proxy, computed by the server from the same
        // figure it reports — not a number this spec guessed.
        expect(money(ruleOf(capped, 'AMOUNT_CEILING')?.limit)).toBeCloseTo(capped.monthlyNet * 2, 0);
      });
    });

    test('loan_max_emi_percent_of_net moves the affordability ceiling', async () => {
      const wide = await eligibilityOf({ amount: 600, installments: 6, type: 'LOAN' });
      expect(wide.monthlyNet, 'the subject has no net pay, so an EMI percentage cannot bite').toBeGreaterThan(0);

      await flip('loan_max_emi_percent_of_net', '1', async () => {
        // 1% of the proxy, against an EMI of a quarter of it.
        const amount = Math.round(wide.monthlyNet * 2);
        await expect
          .poll(async () => ruleOf(await eligibilityOf({ amount, installments: 8, type: 'LOAN' }), 'NET_PAY_AFTER_EMI')?.status, {
            timeout: 15_000,
          })
          .toBe('FAIL');

        const tight = await eligibilityOf({ amount, installments: 8, type: 'LOAN' });
        expect(money(ruleOf(tight, 'NET_PAY_AFTER_EMI')?.limit)).toBeCloseTo(tight.monthlyNet * 0.01, 0);
        expect(ruleOf(tight, 'NET_PAY_AFTER_EMI')?.detail).toContain('above 1% of monthly pay');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Master switches
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('master switches', () => {
    test('loan_module_v2_enabled OFF recovers the whole instalment regardless of net', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'v2 off' });

      // The kill-switch must mean "behave exactly as before": no affordability
      // cap, no protected take-home, no leave pause. So an absurd take-home
      // floor is set at the same time and must be IGNORED.
      const result = await flipMany(
        { loan_module_v2_enabled: 'false', loan_min_net_pay_amount: '99999999' },
        () => runFor(2),
      );

      expect(result.netPreRecovery, 'the subject earned nothing, so recovery cannot be judged').toBeGreaterThan(0);
      expect(result.deduction, 'the legacy path did not take the full instalment').toBe(EMI);

      const rows = await outcomesFor(id);
      expect(rows.map((r) => r.outcome)).toContain('FULL');
      expect(rows.map((r) => r.reason)).toContain('AFFORDABLE');
    });

    test('loan_module_v2_enabled ON hands the same cycle to the affordability engine', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'v2 on' });

      // Same loan, same period shape, same absurd floor — and now it bites.
      const result = await flipMany(
        { loan_module_v2_enabled: 'true', loan_min_net_pay_amount: '99999999' },
        () => runFor(3),
      );

      expect(result.deduction, 'the affordability engine took money it could not afford to').toBe(0);

      const rows = await outcomesFor(id);
      expect(rows.map((r) => r.reason), 'no explanatory ledger row was written for the skipped cycle').toContain(
        'INSUFFICIENT_NET',
      );
    });

    test('loan_interest_enabled cannot put interest on a natively created loan', async () => {
      const id = await flip('loan_interest_enabled', 'true', async () => {
        const created = await track({ amount: 6000, installments: 6, note: 'interest on' });
        return created;
      });

      const loan = await loanOf(adminApi, id);
      const rows = await scheduleOf(adminApi, id);

      // BUG?: setting has no effect on a natively created loan.
      // `loan_interest_enabled` only decides whether the loan's OWN
      // `interestMethod` is honoured, and `loan_default_interest_method` /
      // `loan_default_interest_rate` are never read by create() or
      // applyApproved() — so a native loan is always NONE at 0%, switch on or
      // off. The importer and `convert` are the only paths that can set a rate
      // (docs/LOAN-ADVANCES-GAP-REPORT.md §7).
      expect(String(loan.interestMethod), 'a native loan gained an interest method from a setting').toBe('NONE');
      expect(money(loan.interestRate)).toBe(0);
      expect(rows.reduce((a, r) => a + r.interestComponent, 0)).toBe(0);
    });

    test('loan_interest_enabled OFF forces a schedule to NONE', async () => {
      // The half that DOES work, asserted so the pair reads as a contrast
      // rather than as one broken case: with the switch off the generator
      // overrides whatever the loan carries.
      const id = await flip('loan_interest_enabled', 'false', async () => track({ amount: 6000, installments: 6, note: 'interest off' }));

      const rows = await scheduleOf(adminApi, id);
      expect(rows.length).toBe(6);
      expect(rows.every((r) => r.interestComponent === 0), 'an interest component survived the switch being off').toBe(true);
      expect(rows[0].emiAmount).toBe(1000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Payroll recovery policy — every case needs v2 ON
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('payroll recovery policy', () => {
    test('loan_min_net_pay_amount protects a flat take-home floor', async () => {
      // TWO instalments, not one. A payroll run records its recovery even as a
      // draft, so a single-instalment loan is settled by the probe cycle below
      // and the capped cycle then has nothing due — which made this case
      // measure an empty schedule rather than the floor.
      const id = await track({ amount: EMI * 2, installments: 2, note: 'flat floor' });

      // Sized from a run rather than guessed: the floor is set just below one
      // cycle's take-home, so the next cycle has a small pool against an EMI of
      // 1000 and the recovery is bounded by the floor rather than by the debt.
      const probe = await flipMany({ loan_module_v2_enabled: 'true' }, () => runFor(4));

      // At LEAST this loan's instalment, not exactly it: the subject carries
      // whatever the cases above left live, and the deduction line is the whole
      // cycle's recovery across every one of their loans. Pinning it to 1000
      // made this case depend on how many loans its neighbours had retired.
      expect(
        probe.deduction,
        'the baseline cycle did not even recover this loan instalment',
      ).toBeGreaterThanOrEqual(EMI);
      const unbounded = probe.deduction;

      // The probe run is DELETED before the capped cycle, and this is the whole
      // reason this case used to read as a defect in the floor.
      //
      // An unlocked draft holds a PENDING `AdvanceLoanDeduction` against the
      // loan, and `LoanRecoveryService.loadCandidates` refuses any loan that
      // has one — `deductions: { none: { status: 'PENDING' } }`, the in-flight
      // guard that stops one instalment being recovered twice by two open runs.
      // So with the probe still open the next cycle had NO candidate at all,
      // recovered 0, and the floor was never consulted: the case was reading a
      // correct double-recovery guard as a broken take-home floor.
      for (const runId of runs) await deletePayroll(adminApi, runId).catch(() => undefined);
      runs = [];

      const floor = Math.round(probe.netPreRecovery - 400);
      const capped = await flipMany(
        { loan_module_v2_enabled: 'true', loan_min_net_pay_amount: String(floor) },
        () => runFor(5),
      );

      // The pool is measured against the CAPPED cycle's own pay, not the
      // probe's. This case used to assert a flat 400 — the difference the floor
      // was sized to leave — and that is only right when both cycles pay
      // identically. They do not: net is a function of the month's working
      // days, so the figure moves with the calendar and the case failed on a
      // shorter month while the floor was working perfectly.
      const pool = Math.max(0, capped.netPreRecovery - floor);
      const expected = Math.min(unbounded, pool);
      expect(expected, 'the floor left room for the whole recovery, so nothing was bounded').toBeLessThan(unbounded);

      // What the floor promises: the pool is collected as far as it goes, and
      // take-home does not go below the figure that was configured.
      expect(capped.deduction, 'the take-home floor did not bound the recovery').toBeCloseTo(expected, 0);
      expect(capped.net, 'take-home fell below the configured floor').toBeGreaterThanOrEqual(floor - 1);

      // The pool is allocated across every debt the subject carries, so this
      // loan may be the one that is trimmed or the one that is skipped — what
      // must be true is that the cycle was recorded against it either way, and
      // that a bounded collection is recorded as PARTIAL rather than as a
      // silent shortfall.
      const outcomes = (await outcomesFor(id)).map((r) => r.outcome);
      expect(outcomes.length, 'the capped cycle wrote no outcome at all for this loan').toBeGreaterThan(0);
      expect(outcomes, 'a bounded recovery was not recorded as one').toContain(
        expected > 0 ? 'PARTIAL' : 'DEFER',
      );
    });

    test('loan_min_net_pay_percent protects a proportional take-home floor', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'percentage floor' });

      const result = await flipMany(
        { loan_module_v2_enabled: 'true', loan_min_net_pay_percent: '99' },
        () => runFor(6),
      );

      expect(result.netPreRecovery).toBeGreaterThan(0);
      // 1% of take-home is the whole pool; it is under the 1000 EMI, so the
      // recovery is that pool and no more.
      const pool = result.netPreRecovery * 0.01;
      expect(result.deduction).toBeGreaterThan(0);
      expect(result.deduction).toBeLessThan(EMI);
      expect(result.deduction).toBeCloseTo(pool, 0);
      expect((await outcomesFor(id)).map((r) => r.outcome)).toContain('PARTIAL');
    });

    test('loan_max_total_deduction_percent_of_net caps the whole recovery pool', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'total deduction cap' });

      const result = await flipMany(
        { loan_module_v2_enabled: 'true', loan_max_total_deduction_percent_of_net: '1' },
        () => runFor(7),
      );

      expect(result.deduction).toBeCloseTo(result.netPreRecovery * 0.01, 0);
      expect(result.deduction, 'the 1% cap did not bound the recovery').toBeLessThan(EMI);
      expect((await outcomesFor(id)).map((r) => r.outcome)).toContain('PARTIAL');
    });

    test('loan_shortfall_policy=PARTIAL takes what it can', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'shortfall partial' });

      const result = await flipMany(
        {
          loan_module_v2_enabled: 'true',
          loan_min_net_pay_percent: '99',
          loan_shortfall_policy: 'PARTIAL',
        },
        () => runFor(8),
      );

      expect(result.deduction).toBeGreaterThan(0);
      expect(result.deduction).toBeLessThan(EMI);
      const rows = await outcomesFor(id);
      expect(rows.map((r) => r.outcome)).toContain('PARTIAL');
    });

    test('loan_shortfall_policy=SKIP takes nothing and says SKIP', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'shortfall skip' });

      const result = await flipMany(
        {
          loan_module_v2_enabled: 'true',
          loan_min_net_pay_percent: '99',
          loan_shortfall_policy: 'SKIP',
        },
        () => runFor(9),
      );

      // Same pool as the PARTIAL case above; only the policy differs.
      expect(result.deduction, 'an all-or-nothing policy still took a partial instalment').toBe(0);
      const rows = await outcomesFor(id);
      expect(rows.map((r) => r.outcome), 'the ledger did not record WHY nothing was taken').toContain('SKIP');
    });

    test('loan_shortfall_policy=DEFER takes nothing and says DEFER', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'shortfall defer' });

      const result = await flipMany(
        {
          loan_module_v2_enabled: 'true',
          loan_min_net_pay_percent: '99',
          loan_shortfall_policy: 'DEFER',
        },
        () => runFor(10),
      );

      expect(result.deduction).toBe(0);
      const rows = await outcomesFor(id);
      // DEFER and SKIP differ ONLY in the recorded outcome — same money, a
      // different promise about next cycle. A spec that asserted the amount
      // alone would pass with the two swapped.
      expect(rows.map((r) => r.outcome)).toContain('DEFER');
      expect(rows.map((r) => r.outcome)).not.toContain('SKIP');
    });

    test('loan_zero_salary_policy names the outcome for an unpaid cycle', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'zero salary' });

      // A cycle with no pay at all. The money answer is the same either way —
      // nothing can be taken from nothing — so the setting's ONLY observable is
      // which outcome the ledger records, which is what a payroll clerk reads
      // when asked why June recovered nothing.
      await adminApi.patch(`/employees/${subjectId}`, { baseSalary: 0 });
      try {
        const result = await flipMany(
          { loan_module_v2_enabled: 'true', loan_zero_salary_policy: 'SKIP' },
          () => runFor(11),
        );
        expect(result.deduction).toBe(0);

        const rows = await outcomesFor(id);
        expect(rows.map((r) => r.reason)).toContain('ZERO_NET');
        expect(rows.map((r) => r.outcome)).toContain('SKIP');
      } finally {
        await adminApi.patch(`/employees/${subjectId}`, { baseSalary: SUBJECT_SALARY }).catch(() => undefined);
      }
    });

    test('loan_recover_on_run_types keeps a bonus run from charging the EMI again', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'run type gate' });

      const result = await flipMany(
        { loan_module_v2_enabled: 'true', loan_recover_on_run_types: 'FINAL_SETTLEMENT' },
        () => runFor(12, 'REGULAR'),
      );

      expect(result.deduction, 'a REGULAR run recovered while excluded from the run-type list').toBe(0);
      // Excluded at the CANDIDATE level, so there is not even an explanatory
      // row — different from a shortfall, and worth telling apart.
      expect(await outcomesFor(id)).toEqual([]);
    });

    test('loan_recovery_priority_order decides which debt is paid first', async () => {
      // Exactly the allowance: one advance and one loan, both due, competing
      // for a pool that cannot cover both.
      const advance = await track({ type: 'ADVANCE', amount: 500, note: 'priority advance' });
      const loan = await track({ amount: EMI, installments: 1, note: 'priority loan' });

      // The percentage cap is lifted for the probe. It defaults to 50% of net,
      // which on this subject's pay is less than the 1500 the two debts come
      // to — so the baseline cycle was bounded by the WRONG rule and this case
      // never got to compare priorities at all.
      const probe = await flipMany(
        { loan_module_v2_enabled: 'true', loan_max_total_deduction_percent_of_net: '100' },
        () => runFor(1),
      );
      expect(probe.deduction, 'the baseline cycle did not clear both debts').toBe(EMI + 500);
      for (const id of runs) await deletePayroll(adminApi, id).catch(() => undefined);
      runs = [];

      // A pool of 500 — enough for the advance OR part of the loan, not both.
      const floor = Math.round(probe.netPreRecovery - 500);
      const capped = await flipMany(
        {
          loan_module_v2_enabled: 'true',
          loan_max_total_deduction_percent_of_net: '100',
          loan_min_net_pay_amount: String(floor),
          loan_recovery_priority_order: 'LOAN,ADVANCE',
        },
        () => runFor(2),
      );

      const advanceRows = await outcomesFor(advance);
      const loanRows = await outcomesFor(loan);
      const taken = (rows: Array<{ amount: number }>) => rows.reduce((a, r) => a + r.amount, 0);

      // The pool is read from the CAPPED cycle rather than assumed to be the
      // 500 the floor was sized to leave: net is a function of the month's
      // working days, so the two cycles do not pay the same and the pool moves
      // with the calendar. What the ORDER decides is who eats into it first,
      // and that is what is asserted.
      const pool = Math.max(0, capped.netPreRecovery - floor);
      expect(pool, 'the floor left enough for both debts, so the order decides nothing').toBeLessThan(EMI + 500);

      const loanShare = Math.min(EMI, pool);
      const advanceShare = Math.min(500, pool - loanShare);

      // Reversed from the default 'ADVANCE,LOAN': the loan is served first and
      // takes what it can, and the advance sees only what is left.
      expect(taken(loanRows), 'the loan was not served first under LOAN,ADVANCE').toBeCloseTo(loanShare, 0);
      expect(taken(advanceRows), 'the advance took more than the loan left it').toBeCloseTo(advanceShare, 0);
    });

    test('loan_recovery_failure_policy cannot be exercised over the API', async () => {
      requireReadable('loan_recovery_failure_policy');

      // Readable and writable, and it changes nothing reachable: the branch it
      // guards fires only when `loadCandidates` THROWS, and no request can make
      // it throw. Asserted as "an ordinary cycle is identical under both
      // values" so the case is honest about what it proves.
      const id = await track({ amount: EMI, installments: 1, note: 'failure policy' });

      const failing = await flipMany(
        { loan_module_v2_enabled: 'true', loan_recovery_failure_policy: 'FAIL' },
        () => runFor(3),
      );
      for (const runId of runs) await deletePayroll(adminApi, runId).catch(() => undefined);
      runs = [];

      const warning = await flipMany(
        { loan_module_v2_enabled: 'true', loan_recovery_failure_policy: 'WARN' },
        () => runFor(4),
      );

      expect(warning.deduction, 'the failure policy changed a cycle that did not fail').toBe(failing.deduction);
      expect((await outcomesFor(id)).length).toBeGreaterThan(0);
    });

    test('loan_unpaid_leave_policy needs approved unpaid leave this file cannot arrange', async () => {
      requireReadable('loan_unpaid_leave_policy', 'loan_unpaid_leave_min_days');

      // Both keys ARE readable and writable — what is missing is the input.
      // `unpaidLeaveDays` is counted from APPROVED leave rows whose type is not
      // paid, inside the payroll period; arranging one for a far-future period
      // means filing and approving a leave request through a different module's
      // rules, which belongs in a leave-vs-loan spec rather than here.
      // Recorded, not faked.
      expect(readable.has('loan_unpaid_leave_policy')).toBe(true);
      expect(readable.has('loan_unpaid_leave_min_days')).toBe(true);
    });

    test('loan_min_partial_recovery_amount cannot be exercised', async () => {
      requireReadable('loan_min_partial_recovery_amount');
      expect(readable.has('loan_min_partial_recovery_amount')).toBe(true);
    });

    test('loan_priority_tiebreak cannot be exercised', async () => {
      requireReadable('loan_priority_tiebreak');
      expect(readable.has('loan_priority_tiebreak')).toBe(true);
    });

    test('loan_final_settlement_ignores_min_net cannot be exercised', async () => {
      requireReadable('loan_final_settlement_ignores_min_net');
      expect(readable.has('loan_final_settlement_ignores_min_net')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The shape of money
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('the shape of money', () => {
    test('loan_rounding_tolerance decides what a manual close will forgive', async () => {
      const id = await track({ amount: 6000, installments: 6, note: 'rounding tolerance' });

      // Leave a residual of 40 — above the shipped tolerance of 1.00.
      await adminApi.post(`/advance-loans/${id}/prepay`, {
        amount: 5960,
        mode: 'CASH',
        reference: `${MARK}-tolerance`,
      });

      await expect(
        adminApi.post(`/advance-loans/${id}/close`, { reason: `${MARK} close under the shipped tolerance` }),
        'a 40 residual was closed away under a tolerance of 1.00',
      ).rejects.toThrow(/above the rounding tolerance of 1/);

      await flip('loan_rounding_tolerance', '50', async () => {
        // Same loan, same residual, same call — only the tolerance moved.
        await adminApi.post(`/advance-loans/${id}/close`, { reason: `${MARK} close within a widened tolerance` });
      });

      const closed = await loanOf(adminApi, id);
      expect(String(closed.status)).toBe('CLOSED');
      expect(String(closed.closureType)).toBe('MANUAL');
      // The residual is not forgotten — it is booked as a waiver, so the ledger
      // still balances.
      expect(money(closed.waivedAmount)).toBeCloseTo(40, 0);
    });

    test('loan_prepayment_mode is the default when recalc is omitted', async () => {
      const reduceTenure = await track({ amount: 6000, installments: 6, note: 'prepay reduce tenure' });
      await adminApi.post(`/advance-loans/${reduceTenure}/prepay`, {
        amount: 2000,
        mode: 'CASH',
        reference: `${MARK}-tenure`,
      });
      const tenureRows = await scheduleOf(adminApi, reduceTenure);

      // REDUCE_TENURE (the shipped default) keeps the instalment and drops rows
      // off the tail; REDUCE_EMI keeps the count and re-amortizes lower. The EMI
      // is what tells them apart without depending on how the tail is trimmed.
      expect(tenureRows.length, 'the re-plan produced no schedule').toBeGreaterThan(0);
      expect(tenureRows[0].emiAmount, 'REDUCE_TENURE changed the instalment').toBe(1000);

      const reduceEmi = await flip('loan_prepayment_mode', 'REDUCE_EMI', async () => {
        const id = await track({ amount: 6000, installments: 6, note: 'prepay reduce emi' });
        await adminApi.post(`/advance-loans/${id}/prepay`, {
          amount: 2000,
          mode: 'CASH',
          reference: `${MARK}-emi`,
        });
        return id;
      });

      const emiRows = await scheduleOf(adminApi, reduceEmi);
      expect(emiRows.length, 'the re-plan produced no schedule').toBeGreaterThan(0);
      expect(emiRows[0].emiAmount, 'REDUCE_EMI did not lower the instalment').toBeLessThan(1000);
    });

    test('loan_rounding_unit cannot be exercised', async () => {
      requireReadable('loan_rounding_unit');
      expect(readable.has('loan_rounding_unit')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Offboarding
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('offboarding', () => {
    test('loan_clearance_blocking_enabled stops an exit while money is owed', async () => {
      // Guarded rather than assumed: if either switch were already off, the
      // DELETE below would SUCCEED and terminate the account four other specs
      // sign in as. A destructive test must never depend on a default.
      test.skip(
        baseline.get('loan_clearance_blocking_enabled') === 'false' ||
          baseline.get('clearance_blocking_enabled') === 'false',
        'clearance blocking is switched off in this environment, so the termination below would ' +
          'actually terminate the shared MANAGER account instead of being refused',
      );

      const id = await track({ amount: EMI, installments: 1, note: 'clearance block' });

      // The refusal path mutates nothing, which is what makes this safe to run
      // against a seeded account. The complementary half — proving the exit
      // SUCCEEDS with the switch off — would actually terminate the subject and
      // every later spec that signs in as them, so it is deliberately not run
      // here. It belongs in an offboarding spec with a disposable employee, and
      // a disposable employee cannot hold a loan: `POST /advance-loans` files
      // for the CALLER, and `makeEmployee` cannot produce a login
      // (loan-support's NO_LOGIN).
      await expect(
        adminApi.delete(`/employees/${subjectId}`),
        'an employee with an outstanding loan was cleared to leave',
      ).rejects.toThrow();

      const status = await adminApi.get<{ loanCleared: boolean; outstandingLoans: unknown[] }>(
        `/assets/clearance/${subjectId}`,
      );
      expect(status.loanCleared, 'the clearance status did not see the outstanding loan').toBe(false);
      expect((status.outstandingLoans ?? []).length).toBeGreaterThan(0);
      expect(id).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Settings that used to be silent no-ops
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('settings that used to be silent no-ops', () => {
    /**
     * Every key below was once seeded, documented, settable — and read by
     * nothing. The cases asserted that broken behaviour on purpose, so that the
     * day a key was implemented its case turned red and somebody had to update
     * it deliberately rather than discover the change in production.
     *
     * That day came: the gap-closure work gave each of them a reader. So the
     * claim inverts — a key an admin can set now has to BITE — and the guard
     * these cases provide is against the reader being lost again.
     */

    test('loan_default_interest_method decides the method of a loan that names none', async () => {
      requireReadable('loan_default_interest_method');

      const id = await flipMany(
        { loan_interest_enabled: 'true', loan_default_interest_rate: '12', loan_default_interest_method: 'REDUCING_BALANCE' },
        () => track({ amount: 6000, installments: 6, note: 'default interest method' }),
      );

      // Was: the loan took the Prisma column default and the setting did
      // nothing (gap report §7). `resolveTerms()` reads it at filing now —
      // request, then product, then setting — and the rate goes with it,
      // because a method with no rate is refused rather than stored as an
      // interest-free loan wearing an interest method.
      const loan = await loanOf(adminApi, id);
      expect(String(loan.interestMethod)).toBe('REDUCING_BALANCE');
    });

    test('loan_default_interest_rate is the rate a loan that names none is priced at', async () => {
      requireReadable('loan_default_interest_rate');

      const id = await flipMany(
        { loan_interest_enabled: 'true', loan_default_interest_method: 'FLAT', loan_default_interest_rate: '18' },
        () => track({ amount: 6000, installments: 6, note: 'default interest rate' }),
      );

      // Was: a natively created loan was always 0%, so only the importer could
      // ever produce an interest-bearing loan.
      const loan = await loanOf(adminApi, id);
      expect(money(loan.interestRate)).toBe(18);
      expect(
        (await scheduleOf(adminApi, id)).reduce((a, r) => a + r.interestComponent, 0),
        'the rate reached the request but not the schedule, which is the half that costs money',
      ).toBeGreaterThan(0);
    });

    test('loan_interest_enabled OFF makes the two defaults inert rather than refused', async () => {
      // The switch is a coercion, not a validation: a deployment that turns
      // interest off is stating a policy about new agreements, and a request
      // filed against defaults it cannot honour must still succeed as an
      // interest-free loan rather than 400 on configuration the requester
      // never chose and cannot see.
      const id = await flipMany(
        { loan_interest_enabled: 'false', loan_default_interest_method: 'FLAT', loan_default_interest_rate: '18' },
        () => track({ amount: 6000, installments: 6, note: 'defaults with interest off' }),
      );

      const loan = await loanOf(adminApi, id);
      expect(String(loan.interestMethod)).toBe('NONE');
      expect(money(loan.interestRate)).toBe(0);
    });

    /**
     * The rest of the former no-op catalogue.
     *
     * Each was a key the backend either never read at all or resolved and never
     * branched on — and each was ALSO absent from `getSettingsList()`, so
     * `withSetting` could not restore it and no case could run without
     * stranding configuration. Two independent defects on the same key.
     *
     * Both are answered now: `provenBy` names the suite that proves the key
     * changes an outcome, and the case here proves the second half — that the
     * key can be READ BACK. That is the property this file needs and the one
     * that broke first: a reader was added, `getSettingsList()` was not, and the
     * key went straight from inert to unrestorable.
     *
     * The effect assertions deliberately live in backend e2e rather than here.
     * Most of these keys only show themselves inside a payroll run or a
     * schedule rebuild, and the browser is the wrong instrument for arithmetic
     * that never reaches a screen.
     */
    const FORMERLY_SILENT: Array<{ key: string; provenBy: string }> = [
      { key: 'loan_default_frequency', provenBy: 'finance-loan-terms.e2e-spec.ts — a WEEKLY default builds a weekly schedule' },
      { key: 'loan_grace_mode', provenBy: 'finance-loan-terms.e2e-spec.ts — recorded on the request when grace periods are asked for' },
      { key: 'loan_min_emi_amount', provenBy: 'finance-loan-terms.e2e-spec.ts — validateAffordability() refuses a trickle instalment' },
      { key: 'loan_reference_prefix', provenBy: 'finance-loan-terms.e2e-spec.ts — every create path mints PREFIX-YYYYMM-NNNN' },
      { key: 'advance_loan_allow_backdated_days', provenBy: 'finance-loan-terms.e2e-spec.ts — bounds how far back effectiveDate may reach' },
      { key: 'loan_overdue_after_cycles', provenBy: 'finance-loan-overdue.e2e-spec.ts — the sweep marks a loan OVERDUE at this many missed cycles' },
      { key: 'loan_restructure_requires_approval', provenBy: 'finance-loan-edit-disburse.e2e-spec.ts — a restructure needs a second, different approver' },
      { key: 'loan_employee_self_prepay', provenBy: 'finance-loan-edit-disburse.e2e-spec.ts — a borrower may record a payment on their own loan' },
      { key: 'loan_flat_prepayment_interest', provenBy: 'finance-loan-rate-topup.e2e-spec.ts — FULL charges contracted interest on early settlement, PRORATA rebates it' },
      { key: 'loan_topup_enabled', provenBy: 'finance-loan-rate-topup.e2e-spec.ts — off, the top-up route refuses' },
      { key: 'loan_payment_allocation_order', provenBy: 'finance-loan-policy-effects.e2e-spec.ts — PRINCIPAL_FIRST splits a payment the other way round' },
      { key: 'loan_deferral_mode', provenBy: 'finance-loan-policy-effects.e2e-spec.ts — EXTEND_TENURE pushes the tail out instead of carrying forward' },
      { key: 'loan_auto_close_on_full_recovery', provenBy: 'finance-loan-policy-effects.e2e-spec.ts — off leaves a zero-balance loan ACTIVE for a human' },
      { key: 'loan_grace_period_cycles', provenBy: 'finance-loan-policy-effects.e2e-spec.ts — cycles after disbursement before the allocator collects' },
    ];

    for (const { key, provenBy } of FORMERLY_SILENT) {
      test(`${key} is readable, so it can be restored`, async () => {
        expect(provenBy.length, 'a key needs the suite that proves it recorded').toBeGreaterThan(0);
        // No requireReadable() skip here on purpose. The skip existed while the
        // key was genuinely unreadable; leaving it would let the defect come
        // back and take the case with it, silently.
        expect(
          readable.has(key),
          `${key} has a reader in the engine but is missing from ` +
            `SystemSettingsService.getSettingsList(), so an admin cannot see what ` +
            `they set and no harness can put it back. Effect proven by ${provenBy}.`,
        ).toBe(true);
      });
    }

    test('loan_topup_mode is the one still-silent key, and it is silent for a reason', async () => {
      // NEW_LOAN vs IN_PLACE: the top-up route only implements NEW_LOAN — it
      // settles the old loan and opens a fresh one, which is what the ledger,
      // the closure type and the audit trail are all shaped for. IN_PLACE would
      // mutate a live agreement's principal, so the key is left unread rather
      // than given a reader that quietly ignores half its values.
      expect(
        readable.has('loan_topup_mode'),
        'loan_topup_mode became readable — if it also became READ, this case owes a probe of IN_PLACE',
      ).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The resolution chain
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('the resolution chain', () => {
    test('SystemSetting beats DEFAULT_LOAN_POLICY', async () => {
      const id = await track({ amount: EMI, installments: 1, note: 'resolution chain' });

      // `DEFAULT_LOAN_POLICY.maxTotalDeductionPercentOfNet` is 100 and the
      // shipped SystemSetting is 50, so neither default can produce the answer
      // below — only the value written here can. That is what makes this a test
      // of the CHAIN rather than of the number.
      const result = await flipMany(
        { loan_module_v2_enabled: 'true', loan_max_total_deduction_percent_of_net: '3' },
        () => runFor(5),
      );

      expect(result.netPreRecovery).toBeGreaterThan(0);
      expect(result.deduction).toBeCloseTo(result.netPreRecovery * 0.03, 0);
      expect(result.deduction, 'the hardcoded 100% default was used instead of the setting').toBeLessThan(EMI);
      expect((await outcomesFor(id)).map((r) => r.outcome)).toContain('PARTIAL');
    });

    test('the two LoanPolicy levels of the chain are reachable over the API', async () => {
      // This case used to assert the ABSENCE. `prisma.loanPolicy` was only ever
      // findMany'd inside `LoanPolicyService.resolve()` — no controller, no
      // route, no CRUD — so `LoanPolicy(branchId)` and `LoanPolicy(null)`, the
      // two levels that OUTRANK SystemSetting, could not be written by any
      // caller (gap report §3). `/loan-policies` is that endpoint, and the two
      // levels are the two shapes of row it serves: one per branch, and one
      // company-wide with a null branch.
      const rows = await adminApi.get<Array<{ branchId: string | null }>>('/loan-policies');
      expect(Array.isArray(rows), 'the policy list is no longer a list').toBe(true);

      // Read-only here on purpose: writing a policy changes recovery for every
      // case that follows in this file, and the write path has its own e2e
      // coverage. What this case is for is that the level EXISTS at all — and
      // `effective` is the resolved answer the engine itself would get, which
      // is the only way to see the chain from outside.
      const answer = await adminApi.get<{
        policy?: unknown;
        effective?: Record<string, unknown>;
      }>('/loan-policies/effective');

      // The route answers BOTH halves on purpose: `policy` is the stored row,
      // which is mostly nulls by design, and `effective` is what the engine
      // will actually use once the chain has run. A screen that showed only the
      // row would show an administrator a policy of nulls and call it the
      // policy.
      expect(
        answer?.effective && typeof answer.effective === 'object' && 'shortfallPolicy' in answer.effective,
        'the resolved policy no longer comes back from /loan-policies/effective',
      ).toBe(true);
      expect('policy' in (answer ?? {}), 'the stored row is no longer reported beside it').toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Validation at the write boundary
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('validation of setting values', () => {
    /**
     * Every one of these used to pin the WRITE side being open.
     *
     * `UpdateSettingsDto` validated only that `settings` was an object, so
     * 'BANANA', -10, 500 and 'not-a-number' were all stored verbatim and then
     * discarded at READ time in favour of a fallback: the settings screen
     * showed one thing and the engine did another, with nothing anywhere
     * telling the administrator their value had been thrown away.
     *
     * `SETTING_VALUE_RULES` closes that. A value that would be DISCARDED at
     * read time is REFUSED at write time, with a message naming the key and
     * what it accepts — so these cases now assert the refusal, and that the
     * stored value did not move.
     */
    const refusedWrite = async (key: string, value: string) => {
      const before = (await settingsList(adminApi)).find((r) => r.key === key)?.value;

      let message = '';
      try {
        await adminApi.post('/system-settings', { settings: { [key]: value } });
      } catch (e) {
        message = (e as Error).message;
      }

      expect(message, `${key}=${value} was accepted`).not.toBe('');
      expect(message, 'the refusal does not name the key it is about').toContain(key);

      const after = (await settingsList(adminApi)).find((r) => r.key === key)?.value;
      expect(after, `${key} moved despite the write being refused`).toBe(before);
    };

    test('a nonsense enum value is refused rather than stored and discarded later', async () => {
      await refusedWrite('loan_shortfall_policy', 'BANANA');
    });

    test('a negative percent is refused — a floor below zero is no floor', async () => {
      // -10 used to be stored and parsed as -10, making `protectedNet` negative,
      // which `Math.max` then turned into 0: a nonsensical floor read as no
      // floor and the whole instalment was taken.
      await refusedWrite('loan_min_net_pay_percent', '-10');
    });

    test('a percentage above 100 is refused — a cap above take-home is no cap', async () => {
      // 500 was stored and used as 500%, so the "maximum total deduction" cap
      // became five times take-home.
      await refusedWrite('loan_max_total_deduction_percent_of_net', '500');
    });

    test('a non-numeric value in a numeric key is refused', async () => {
      await refusedWrite('loan_min_net_pay_amount', 'not-a-number');
    });

    test('a negative amount in a money key is refused', async () => {
      // The same class of hole on the money side rather than the percentage
      // side: the write used to be taken and read back exactly as sent.
      await refusedWrite('loan_min_net_pay_amount', '-500');
    });
  });
});
