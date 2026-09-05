import { ApiClient } from './fixtures';

/**
 * Shared setup for the PAYROLL specs, and for anything else that needs a real
 * employee, a real branch, a real system setting or a real payroll run.
 *
 * ## Why this file exists, and why it was carved out of `loan-support.ts`
 *
 * These helpers were written for the loan suite, inside `loan-support.ts`, for
 * the good reason that loan recovery only happens *during* a payroll run — so
 * the loan specs needed to drive payroll before anything else did. They are not
 * loan-specific: `makeEmployee`, `withSettings`, `ensureBranch`, `runPayroll`,
 * `lockPayroll` and `clearPayrolls` describe the payroll world, and the payroll
 * edge-case suite (`payroll-edge-*.spec.ts`) needs every one of them.
 *
 * Leaving them where they were would have meant a payroll spec importing from a
 * file named for loans, and the next person deleting a "loan" helper that four
 * payroll specs depended on. So they live here, and **`loan-support.ts`
 * re-exports every one of them** — no loan spec's import list changed.
 *
 * The dependency runs one way only. This module knows nothing about loans, and
 * must not: `loan-support.ts` imports from here, so an import in the other
 * direction would be a cycle.
 *
 * ## The same two rules `loan-support.ts` states about itself
 *
 * Everything here is **API-only**. These helpers run from `beforeAll`, where
 * there is no `page` and no `expect`; a helper that imported Playwright's `test`
 * would make this module unusable from exactly the hook it exists for.
 *
 * **Nothing here asserts.** A spec's assertions are the spec's own business, and
 * a setup helper that fails a test on the setup author's behalf hides which of
 * the two actually broke.
 *
 * ## Endpoints this module depends on, as verified against the backend
 *
 *   GET    /system-settings                     ARRAY of { key, value, description }
 *   POST   /system-settings                     { settings: Record<string,string> }  ← POST, not PUT
 *   GET    /branches                            array
 *   POST   /branches                            CreateBranchDto
 *   GET    /departments                         array
 *   POST   /employees                           CreateEmployeeDto
 *   PATCH  /employees/:id                       { baseSalary?, endDate?, status?, … }
 *   DELETE /employees/:id?clearanceOverrideReason=…   soft delete → status INACTIVE
 *   GET    /users?search=                       array of users (password never returned)
 *   PATCH  /users/:id/role                      { role }
 *   POST   /attendances/manual                  CreateManualAttendanceDto
 *   POST   /payrolls                            { month, year, runType?, employeeIds?, batchId? }
 *   GET    /payrolls?year=                      array; NO month or branch filter
 *   GET    /payrolls/:id                        payroll WITH `items`
 *   POST   /payrolls/:id/lock                   APPROVED → LOCKED
 *   POST   /payrolls/:id/unlock                 { reason }  (5–500 chars, ADMIN only)
 *   DELETE /payrolls/:id                        refused while LOCKED
 */

// ───────────────────────────────────────────────────────────────────────────
// Response envelopes
// ───────────────────────────────────────────────────────────────────────────
//
// Exported rather than private because `loan-support.ts` needs the identical
// semantics, and two copies of "does this response have a `data` wrapper" is
// exactly the drift this file was carved out to stop.

/** Unwraps `{ data }` one more level than `ApiClient` already does. */
export function inner<T>(raw: unknown): T {
  const box = raw as { data?: unknown } | null;
  return (box && typeof box === 'object' && 'data' in box ? box.data : raw) as T;
}

/** Accepts either a bare array or a `{ data: [...] }` envelope. */
export function asList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const box = raw as { data?: unknown } | null;
  if (box && typeof box === 'object' && Array.isArray(box.data)) return box.data as T[];
  return [];
}

// ───────────────────────────────────────────────────────────────────────────
// Identity
// ───────────────────────────────────────────────────────────────────────────

/**
 * A per-run tag, stable in shape across every spec that seeds its own rows.
 *
 * The prefix is the STABLE half — what identifies a record as one file's, across
 * runs — and the base-36 timestamp is what lets a leftover be dated as well as
 * owned. Every sweeper built on this convention (`retireAllMarked` and
 * `ensureAllowance` in `loan-support.ts`, `clearPayrollLane` here) matches on the
 * PREFIX, so pass them the same literal you passed here, not the marker this
 * returns.
 */
export function marker(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Employees
// ───────────────────────────────────────────────────────────────────────────

/**
 * The sentence every spec author needs to read once, in full, at the moment
 * they reach for `TestEmployee.api`.
 *
 * Stated as an error rather than a fake client because a fake would turn a
 * missing capability into a mysterious 401 halfway down a journey.
 */
const NO_LOGIN =
  'makeEmployee cannot return a logged-in ApiClient for an API-created employee.\n' +
  '\n' +
  'Verified against the backend:\n' +
  '  • POST /employees DOES create a User, but with a random temporary password\n' +
  '    (EmployeesService.generateTempPassword) that is only emailed / WhatsApp\'d.\n' +
  '    The create response returns the EMPLOYEE, never the password.\n' +
  '  • POST /employees/:id/resend-welcome regenerates that password and also\n' +
  '    returns only { success, message }.\n' +
  '  • UpdateUserDto has no `password` field, and the global ValidationPipe runs\n' +
  '    with forbidNonWhitelisted, so PATCH /users/:id { password } is a 400.\n' +
  '  • POST /auth/register can set a chosen password, but refuses an employeeId\n' +
  '    that already has an account ("Employee already has an account") — and\n' +
  '    POST /employees always creates one. DELETE /users/:id is a SOFT delete\n' +
  '    (isActive=false), so the link can never be freed.\n' +
  '\n' +
  'Do one of these instead:\n' +
  '  • Drive the loan as ADMIN/HR on the employee\'s behalf (the approve, hold,\n' +
  '    prepay, waive and write-off routes all take the loan id, not a session).\n' +
  '  • Use one of the four seeded accounts in global-setup.ts ROLE_ACCOUNTS, or\n' +
  '    employee2@company.com / Password123! from the baseline seed, via\n' +
  '    ApiClient.asAccount().\n' +
  '  • Ask for a backend endpoint that sets a known password for a test user.';

export interface TestEmployee {
  id: string;
  code: string;
  email: string;
  password: string;
  userId?: string;
  /**
   * NOT AVAILABLE. Reading this throws `NO_LOGIN` — see the message for why and
   * for what to do instead. It is a throwing getter rather than an omitted field
   * so the failure names the reason at the exact line that wanted a session,
   * instead of surfacing as `undefined.get is not a function` three calls later.
   */
  api: ApiClient;
  dispose(): Promise<void>;
}

/**
 * Creates a real employee, with a real employee code, a real branch and a real
 * base salary — everything a payroll run or a loan needs.
 *
 * `baseSalary` matters more than it looks: the baseline seed gives its employees
 * `baseSalary: 0`, and loan recovery against a zero-pay cycle takes NOTHING
 * (`loan_zero_salary_policy` defaults to `DEFER`). A spec that asserts an
 * instalment was recovered must run against an employee who is actually paid, so
 * this defaults to a figure comfortably above every take-home floor rather than
 * to 0.
 *
 * `idCard` is auto-generated (`autoGenerateIdCard`) so parallel workers cannot
 * collide on it — the server regenerates and retries on a uniqueness clash
 * instead of rejecting the request.
 *
 * `role` goes through `PATCH /users/:id/role` after the fact, because the
 * auto-created login is always `EMPLOYEE`. It changes what that (unusable) login
 * WOULD be permitted to do and what `advance_loan_approver_roles` matches — it
 * does not make the account loggable.
 */
export async function makeEmployee(
  admin: ApiClient,
  opts: {
    marker: string;
    baseSalary?: number;
    startDate?: string;
    departmentId?: string;
    branchId?: string;
    role?: string;
  },
): Promise<TestEmployee> {
  if (!opts.marker) throw new Error('makeEmployee needs a marker so its employees can be told apart');

  // Lower-cased and stripped of anything an email cannot carry: the marker is a
  // base-36 timestamp in practice, but a caller passing a prefix with a dash or
  // a dot should still get a valid address rather than a 400 from @IsEmail.
  const slug = opts.marker.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const email = `${slug}@e2e.local`;

  const departmentId = opts.departmentId ?? (await firstDepartmentId());
  const branchId = opts.branchId ?? (await admin.firstBranchId());

  const created = await admin
    .post<{ id: string; employeeCode: string; email: string }>('/employees', {
      fullName: `E2E ${opts.marker}`,
      // Fixed rather than derived from "today": `START_DATE_BEFORE_MIN_AGE`
      // rejects a start date less than 18 years after the date of birth, and a
      // pair of literals is one less thing to get wrong on a leap day.
      dateOfBirth: '1990-01-01',
      // The default has no past limit (`employee_start_date_max_past_days` is
      // unset) and a floor of 1970-01-01, so a settled historical date is safe
      // and keeps `loan_min_service_months` satisfied whatever it is set to.
      startDate: opts.startDate ?? '2020-01-01',
      email,
      departmentId,
      branchId,
      position: 'E2E Subject',
      baseSalary: opts.baseSalary ?? 60000,
      autoGenerateIdCard: true,
    })
    .catch((e: Error) => {
      throw new Error(`POST /employees failed for ${email}: ${e.message}`);
    });

  // The user row is created by the same request, but its id is not in the
  // response — so it is looked up, not assumed. A miss is not fatal: everything
  // except `role` works without it.
  let userId: string | undefined;
  const users = await admin
    .get<unknown>(`/users?search=${encodeURIComponent(email)}&limit=5`)
    .catch(() => []);
  userId = asList<{ id: string; email: string }>(users).find((u) => u.email === email)?.id;

  if (opts.role && opts.role !== 'EMPLOYEE') {
    if (!userId) {
      throw new Error(
        `makeEmployee could not find the login created for ${email} via GET /users?search=, ` +
          `so PATCH /users/:id/role could not set role=${opts.role}.`,
      );
    }
    await admin.patch(`/users/${userId}/role`, { role: opts.role }).catch((e: Error) => {
      throw new Error(`PATCH /users/${userId}/role failed: ${e.message}`);
    });
  }

  const employee: TestEmployee = {
    id: created.id,
    code: created.employeeCode,
    email,
    // Deliberately the empty string, not a plausible-looking value: there IS no
    // password anybody can use, and a decorative one would be copied into a
    // login call and fail as "Invalid credentials".
    password: '',
    userId,
    get api(): ApiClient {
      throw new Error(NO_LOGIN);
    },
    // Nothing to dispose — there is no client. Present so a spec's teardown can
    // stay symmetrical with everything else in this suite and not have to
    // special-case employees.
    dispose: async (): Promise<void> => undefined,
  };
  return employee;
}

/**
 * The first MAIN department, for a caller that just needs *a* valid one.
 *
 * Two traps here, both of which have bitten this suite:
 *
 *  1. A department with a `parentId` is a TEAM, and `POST /employees` refuses
 *     one outright — *"Employees must belong to main departments. Assign to
 *     <parent> instead and use position field to indicate team."* The seed
 *     ships `E2E-OPS-TEAM` under `E2E-OPS`, so "the first department" is not
 *     reliably a legal answer.
 *  2. `GET /departments` is BRANCH-SCOPED, and `ApiClient.withBranch()` mutates
 *     the client. A caller that has scoped `admin` to a branch it just created
 *     will see that branch's departments — possibly none. So the lookup is made
 *     against an unscoped view and the result is valid for any branch.
 */
async function firstDepartmentId(): Promise<string> {
  const unscoped = await ApiClient.as('admin');
  try {
    const raw = await unscoped.get<unknown>('/departments').catch((e: Error) => {
      throw new Error(`GET /departments failed: ${e.message}`);
    });
    const list = asList<{ id: string; code: string; parentId?: string | null }>(raw);
    const main = list.filter((d) => !d.parentId);
    const head = main.find((d) => d.code === 'HRD') ?? main[0];
    if (!head) {
      throw new Error(
        `GET /departments returned no MAIN department (saw: ${
          list.map((d) => d.code).join(', ') || 'none'
        }) — employees cannot be assigned to a team, so there is nowhere to put one`,
      );
    }
    return head.id;
  } finally {
    await unscoped.dispose();
  }
}

/**
 * Marks an employee as having left.
 *
 * `DELETE /employees/:id` is a SOFT delete: it writes `status: 'INACTIVE'`
 * (R72 — not `TERMINATED`, which is now a CONTRACT status and nothing else) and
 * deactivates the linked login.
 *
 * Two things a caller would otherwise trip over:
 *
 *   • `loan_clearance_blocking_enabled` defaults to TRUE, so an employee who
 *     still owes a balance CANNOT be terminated without an override. The reason
 *     is always supplied here — the alternative is that every offboarding spec
 *     fails on setup for a rule it was not testing. The override is audited,
 *     which is the point of it.
 *   • The delete stamps `endDate = now()` itself, overwriting anything set
 *     before it. So a caller-supplied `date` is applied AFTER, not before.
 */
export async function terminateEmployee(
  admin: ApiClient,
  employeeId: string,
  opts?: { date?: string },
): Promise<void> {
  const reason = encodeURIComponent('e2e teardown — clearance override');
  await admin
    .delete(`/employees/${employeeId}?clearanceOverrideReason=${reason}`)
    .catch((e: Error) => {
      throw new Error(`DELETE /employees/${employeeId} failed: ${e.message}`);
    });

  if (opts?.date) {
    await admin.patch(`/employees/${employeeId}`, { endDate: opts.date }).catch((e: Error) => {
      throw new Error(
        `PATCH /employees/${employeeId} { endDate } failed after the termination: ${e.message}`,
      );
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// System settings
// ───────────────────────────────────────────────────────────────────────────

/**
 * Whether this run is allowed to touch environment-wide configuration.
 *
 * The gate exists because a system setting is shared by every worker. Flipping
 * `loan_module_v2_enabled` mid-suite re-routes recovery for every loan spec
 * running in parallel, and the failures land in files that never touched the
 * flag — the worst attribution failure available here. Same convention, and the
 * same variable, as `approval-chain.spec.ts`: `npm run test:e2e:approval-chain`
 * sets it, the default run does not.
 */
export function flagFlipAllowed(): boolean {
  return process.env.E2E_ALLOW_FLAG_FLIP === '1';
}

interface SettingRow {
  key: string;
  value: string;
}

/**
 * Reads ONE setting's current effective value.
 *
 * `GET /system-settings` answers with an ARRAY of `{ key, value, description }`
 * built by `getSettingsList()`, which returns every configurable key with its DB
 * value OR its hardcoded default. That second half is what makes restoration
 * honest: a key with no DB row still reads back as the value the server would
 * have used, so writing it back afterwards is a no-op in behaviour.
 *
 * A key ABSENT from that list is a different matter. `POST /system-settings`
 * upserts arbitrary keys — the write path has no allowlist at all — but a key
 * the list does not enumerate cannot be read back, so its original value is
 * unknowable and `withSetting` refuses rather than restoring a guess. All ~29
 * loan keys ARE enumerated (`loan_module_v2_enabled`, `loan_shortfall_policy`,
 * `loan_min_net_pay_amount`, `loan_recover_on_run_types`, …); a handful the
 * engine reads are not (`loan_rounding_unit`, `loan_grace_period_cycles`,
 * `loan_deferral_mode`, `loan_payment_allocation_order`, `loan_priority_tiebreak`,
 * `loan_auto_close_on_full_recovery`, `loan_min_partial_recovery_amount`,
 * `loan_final_settlement_ignores_min_net`, `advance_loan_auditor_user_ids`).
 */
async function readSetting(admin: ApiClient, key: string): Promise<string> {
  const raw = await admin.get<unknown>('/system-settings').catch((e: Error) => {
    throw new Error(`GET /system-settings failed: ${e.message}`);
  });
  const row = asList<SettingRow>(raw).find((r) => r.key === key);
  if (!row) {
    throw new Error(
      `System setting "${key}" is not returned by GET /system-settings.\n` +
        `POST /system-settings would still WRITE it (updateSettings upserts arbitrary keys), ` +
        `but its current value cannot be read, so this helper cannot restore it afterwards — ` +
        `and a flag left flipped breaks every other spec in the run.\n` +
        `Add the key to SystemSettingsService.getSettingsList(), or set and restore it explicitly.`,
    );
  }
  return row.value;
}

/** The write path. POST, not PUT, and the body is always `{ settings: {…} }`. */
async function writeSettings(admin: ApiClient, kv: Record<string, string>): Promise<void> {
  await admin.post('/system-settings', { settings: kv }).catch((e: Error) => {
    throw new Error(`POST /system-settings ${JSON.stringify(kv)} failed: ${e.message}`);
  });
}

/**
 * Runs `fn` with one setting changed, and puts it back — including when `fn`
 * throws.
 *
 * The `finally` is the whole point. A spec that flips `loan_module_v2_enabled`
 * and then fails an assertion leaves the master switch on for every worker still
 * running, and the next twenty failures are unrelated to the bug that caused the
 * first one. Restoration therefore does not depend on the body succeeding.
 *
 * The original is read BEFORE the write, from the same list endpoint that
 * supplies defaults for unset keys, so restoring is exact rather than a guess at
 * what the default used to be.
 */
export async function withSetting<T>(
  admin: ApiClient,
  key: string,
  value: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!flagFlipAllowed()) {
    throw new Error(
      `Refusing to change system setting "${key}": it is environment-wide configuration ` +
        `shared with every parallel worker.\n` +
        `Set E2E_ALLOW_FLAG_FLIP=1 and run this file against its own database ` +
        `(see the test:e2e:approval-chain script for the pattern).`,
    );
  }

  const before = await readSetting(admin, key);
  await writeSettings(admin, { [key]: value });
  try {
    return await fn();
  } finally {
    // Its own try/catch: a restore that throws would REPLACE the body's failure
    // with a teardown failure, and the reader would never see which assertion
    // actually broke.
    try {
      await writeSettings(admin, { [key]: before });
    } catch {
      // Deliberately swallowed, and deliberately loud on stderr — the run is
      // now in a state later specs will fail in, and that has to be visible.
      console.error(`[payroll-support] FAILED to restore system setting "${key}" to "${before}"`);
    }
  }
}

/**
 * The same contract for several keys at once.
 *
 * Restores in REVERSE order, each write independent of the others. Order matters
 * when keys interact — `loan_module_v2_enabled` gates whether the rest are even
 * consulted, so a caller who turned the master switch on first has it turned off
 * last — and independence matters because one key failing to restore must not
 * abandon the remaining four.
 */
export async function withSettings<T>(
  admin: ApiClient,
  kv: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(kv);
  if (!flagFlipAllowed()) {
    throw new Error(
      `Refusing to change system settings ${keys.join(', ')}: they are environment-wide ` +
        `configuration shared with every parallel worker.\n` +
        `Set E2E_ALLOW_FLAG_FLIP=1 and run this file against its own database.`,
    );
  }

  const before: Array<[string, string]> = [];
  for (const key of keys) before.push([key, await readSetting(admin, key)]);

  // One request, so the server sees the keys as a single coherent change —
  // `updateSettings` validates the payload as a whole (geofencing is the
  // precedent) and a half-applied config is worse than a refused one.
  await writeSettings(admin, kv);
  try {
    return await fn();
  } finally {
    for (const [key, value] of before.reverse()) {
      try {
        await writeSettings(admin, { [key]: value });
      } catch {
        console.error(`[payroll-support] FAILED to restore system setting "${key}" to "${value}"`);
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Branches
// ───────────────────────────────────────────────────────────────────────────

/**
 * A branch id from its code — `'HO'` for Head Office, `'E2E-BR2'` for the second
 * branch the baseline seeds in Asia/Muscat.
 *
 * Worth having by code rather than by position because the whole reason
 * `E2E-BR2` exists is that it is NOT the caller's default branch: a payroll run
 * is per-branch, and a spec proving that a loan in one branch is invisible from
 * the other has to name both.
 */
export async function branchIdByCode(admin: ApiClient, code: string): Promise<string> {
  const raw = await admin.get<unknown>('/branches').catch((e: Error) => {
    throw new Error(`GET /branches failed: ${e.message}`);
  });
  const list = asList<{ id: string; code: string }>(raw);
  const hit = list.find((b) => b.code === code);
  if (!hit) {
    throw new Error(
      `No branch with code "${code}" in GET /branches (saw: ${list.map((b) => b.code).join(', ') || 'none'}). ` +
        `E2E-BR2 comes from seed-e2e-baseline.ts — re-seed with \`npm run e2e:db reset\`.`,
    );
  }
  return hit.id;
}

/**
 * Find a branch by code, creating it if it is not there yet.
 *
 * The reason this exists rather than everyone sharing `E2E-BR2`: a loan can
 * never be removed. `DELETE /advance-loans/:id` only CANCELS a request that is
 * still PENDING, and every other retirement path (write-off, waiver, closure)
 * leaves the row exactly where it was, in a terminal state. So a spec that
 * seeds hundreds of loans permanently changes the loan book of whatever branch
 * it seeded them into — and `finance-loan-lifecycle.spec.ts` has a case that
 * picks the first non-HO branch and asserts its book is EMPTY.
 *
 * A spec that is going to leave a mess behind therefore asks for a branch of
 * its own, and the mess stays inside it. Creation is idempotent: a re-run finds
 * the branch it made last time and adds to it, which is fine, because nothing
 * else is ever pointed at it.
 *
 * `POST /branches` needs only `code` and `name` (`CreateBranchDto`), and is
 * open to ADMIN and HR_MANAGER.
 */
export async function ensureBranch(admin: ApiClient, code: string, name: string): Promise<string> {
  const raw = await admin.get<unknown>('/branches').catch((e: Error) => {
    throw new Error(`GET /branches failed: ${e.message}`);
  });
  const existing = asList<{ id: string; code: string }>(raw).find((b) => b.code === code);
  if (existing) return existing.id;

  // `code` and `name` ONLY. The global pipe runs `forbidNonWhitelisted`, and
  // `CreateBranchDto` has no `isActive` — sending one is a 400, not an
  // ignored extra. A branch is created active anyway.
  const made = await admin
    .post<{ id: string }>('/branches', { code, name })
    .catch(async (e: Error) => {
      // Lost the race. Playwright runs spec FILES in parallel (`workers` is
      // unset locally, so Playwright picks one per core pair), and every spec in
      // a family calls this from `beforeAll` at the same moment. The server's
      // duplicate check is read-then-write with nothing catching the unique
      // violation, so the loser gets a **500**, not the clean 409 a sequential
      // duplicate gets — see G27. Either way the postcondition promised here is
      // "the branch exists", so ask again rather than failing three specs for a
      // branch that is now sitting there.
      const raced = await branchIdByCode(admin, code).catch(() => '');
      if (raced) return { id: raced };
      throw new Error(`POST /branches (code "${code}") failed: ${e.message}`);
    });
  if (!made?.id) throw new Error(`POST /branches (code "${code}") returned no id`);
  return made.id;
}

// ───────────────────────────────────────────────────────────────────────────
// Payroll
// ───────────────────────────────────────────────────────────────────────────

/**
 * ONE side effect worth stating before the helpers below use it.
 *
 * `ApiClient.withBranch()` MUTATES the client and returns `this` — it is a view
 * selector, not a per-call option, and the class exposes no way to read the
 * branch back. So `runPayroll` and `clearPayrolls` leave the admin client scoped
 * to the branch they were given. That is almost always what a caller wants (the
 * next thing a payroll spec does is read the run they just made), but a spec
 * that afterwards expects a company-wide view must re-scope the client itself.
 */

export interface PayrollRunOpts {
  month: number;
  year: number;
  /**
   * NOT part of the request body — there is no `branchId` on `CreatePayrollDto`.
   * The run's branch comes from the `X-Branch-Id` header, so this is applied
   * with `withBranch()` and the server refuses outright without it ("Select a
   * specific branch before generating payroll — payroll runs are per-branch").
   */
  branchId: string;
  /**
   * `REGULAR` | `OFF_CYCLE` | `BONUS` | `ADJUSTMENT` | `FINAL_SETTLEMENT`.
   * Only the types listed in `loan_recover_on_run_types` (default
   * `REGULAR,FINAL_SETTLEMENT`) recover instalments, which is exactly what a
   * spec proving "a BONUS run does not charge the EMI twice" needs to vary.
   */
  runType?: string;
  employeeIds?: string[];
}

/**
 * Generates a payroll run and returns it WITH its items.
 *
 * Two calls, because `POST /payrolls` answers with the payroll header plus
 * `totalAmount` and `employeeCount` and no items at all; the items only come
 * back from `GET /payrolls/:id`. Every caller wants them — a loan spec's whole
 * question is what landed in `advanceLoanDeduction` on one employee's row — so
 * the second call happens here rather than in thirteen `beforeAll`s.
 *
 * A 409 means a run for this branch/period already exists. It is left to
 * surface: silently reusing somebody else's run would make the spec's
 * assertions about "the run I just generated" quietly false. Call
 * `clearPayrolls` first if a clean period is what you need.
 */
export async function runPayroll(
  admin: ApiClient,
  opts: PayrollRunOpts,
): Promise<{ id: string; status: string; items: unknown[] }> {
  const scoped = admin.withBranch(opts.branchId);

  const body = {
    month: opts.month,
    year: opts.year,
    runType: opts.runType,
    employeeIds: opts.employeeIds,
  };

  const created = await scoped.post<{ id: string }>('/payrolls', body).catch(async (e: Error) => {
    // Payroll refuses a period in which NOBODY has an attendance row:
    // "Attendance for m/yyyy has not been processed yet." A loan spec picks a
    // far-future period precisely so no other spec's run collides with it, so
    // that period is empty by construction and this refusal is guaranteed
    // rather than incidental. One manual day for one employee satisfies the
    // run-level guard; every other employee has no rows and is therefore
    // treated as fully present, which is what keeps net pay a clean function
    // of `baseSalary`. Seeded lazily so the ordinary path costs nothing.
    if (!/Attendance for .* has not been processed/i.test(e.message)) {
      throw new Error(
        `POST /payrolls {month:${opts.month},year:${opts.year}} on branch ${opts.branchId} failed: ${e.message}`,
      );
    }
    await seedAttendanceDay(scoped, opts);
    return scoped.post<{ id: string }>('/payrolls', body).catch((again: Error) => {
      throw new Error(
        `POST /payrolls {month:${opts.month},year:${opts.year}} on branch ${opts.branchId} failed ` +
          `after seeding an attendance day: ${again.message}`,
      );
    });
  });

  const full = await scoped
    .get<{ id: string; status: string; items?: unknown[] }>(`/payrolls/${created.id}`)
    .catch((e: Error) => {
      throw new Error(`GET /payrolls/${created.id} failed: ${e.message}`);
    });

  return { id: full.id, status: full.status, items: full.items ?? [] };
}

/**
 * One PRESENT day, so a far-future period is no longer "unprocessed".
 *
 * `POST /attendances/manual` (ADMIN/HR) takes `{ employeeId, date, checkIn,
 * checkOut, status, notes }`. The day is given to a CARRIER — the first
 * employee named by the run, or failing that any active one — rather than
 * spread across everybody, because an employee with NO attendance rows is
 * treated as fully present, while one with rows is measured against them. A
 * spec asserting a clean `baseSalary`-derived net wants its subjects in the
 * first group; the guard only needs one employee in the second.
 */
async function seedAttendanceDay(scoped: ApiClient, opts: PayrollRunOpts): Promise<void> {
  let carrier = opts.employeeIds?.[0];
  if (!carrier) {
    const raw = await scoped.get<unknown>('/employees?limit=1').catch(() => null);
    carrier = asList<{ id: string }>(raw)[0]?.id;
  }
  if (!carrier) {
    throw new Error(
      `payroll for ${opts.month}/${opts.year} needs at least one attendance row and no employee ` +
        `could be found on branch ${opts.branchId} to carry one`,
    );
  }

  const date = `${opts.year}-${String(opts.month).padStart(2, '0')}-01`;
  await scoped
    .post('/attendances/manual', {
      employeeId: carrier,
      date,
      checkIn: '09:00',
      checkOut: '17:00',
      status: 'PRESENT',
      notes: 'e2e: satisfies the payroll period guard',
    })
    .catch((e: Error) => {
      throw new Error(`POST /attendances/manual for ${date} failed: ${e.message}`);
    });
}

/**
 * One employee's row in a run, or `null` when the run did not cover them.
 *
 * `null` rather than a throw because "this employee was not in the run" is a
 * legitimate ANSWER — an inactive employee, a targeted `employeeIds` run, a
 * different branch — and often the very thing a spec is asserting.
 */
export async function payrollItemFor(
  admin: ApiClient,
  payrollId: string,
  employeeId: string,
): Promise<Record<string, unknown> | null> {
  const payroll = await admin
    .get<{ items?: Array<Record<string, unknown>> }>(`/payrolls/${payrollId}`)
    .catch((e: Error) => {
      throw new Error(`GET /payrolls/${payrollId} failed: ${e.message}`);
    });
  const items = Array.isArray(payroll.items) ? payroll.items : [];
  return items.find((i) => i.employeeId === employeeId) ?? null;
}

/**
 * APPROVED → LOCKED.
 *
 * Locking is what flips every PENDING loan deduction on the run to PAID, moves
 * `amountRepaid`, settles schedule rows and auto-closes a fully recovered loan —
 * so a spec asserting recovery has to lock, not merely generate. The run must
 * already be APPROVED (`submit` then `approve`); the deprecated `:id/finalize`
 * alias goes through the same code path and the same requirement.
 */
export async function lockPayroll(admin: ApiClient, payrollId: string): Promise<void> {
  await admin.post(`/payrolls/${payrollId}/lock`, {}).catch((e: Error) => {
    throw new Error(
      `POST /payrolls/${payrollId}/lock failed: ${e.message} ` +
        `(the run must be APPROVED first — submit, then approve)`,
    );
  });
}

/**
 * LOCKED → APPROVED, reversing the loan recovery on the way.
 *
 * The reason is mandatory server-side (5–500 characters) and is recorded on the
 * payroll AND on every REVERSAL ledger entry, so a restated payslip stays
 * explainable. Refused with a 409 when a LATER run has already recovered against
 * the same loans, or when a locked revision descends from this payroll — both of
 * which are the server protecting an audit chain, not a flake.
 */
export async function unlockPayroll(
  admin: ApiClient,
  payrollId: string,
  reason: string,
): Promise<void> {
  await admin.post(`/payrolls/${payrollId}/unlock`, { reason }).catch((e: Error) => {
    throw new Error(`POST /payrolls/${payrollId}/unlock failed: ${e.message}`);
  });
}

/** Deletes a run. Refused while LOCKED — unlock first. */
export async function deletePayroll(admin: ApiClient, payrollId: string): Promise<void> {
  await admin.delete(`/payrolls/${payrollId}`).catch((e: Error) => {
    throw new Error(
      `DELETE /payrolls/${payrollId} failed: ${e.message} (a LOCKED run must be unlocked first)`,
    );
  });
}

/**
 * Clears every run for one branch and period, so a spec can generate its own.
 *
 * Filtering is client-side because it has to be: `GET /payrolls` accepts `year`
 * and `status` and nothing else — no month, no branch. The branch narrowing
 * comes from the `X-Branch-Id` header via the scoping middleware, and the month
 * is compared here.
 *
 * A LOCKED run is unlocked first, because deleting one is refused. Both steps
 * are best-effort: this is setup, and a run that cannot be removed (a later run
 * already recovered against the same loans, so the unlock is a 409) is
 * information the SPEC should surface through its own failure, not something a
 * tidy-up helper should abort on. Failures are logged rather than swallowed
 * silently so the reason is on the console when the spec then fails with a 409
 * "payroll already exists".
 */
export async function clearPayrolls(
  admin: ApiClient,
  branchId: string,
  month: number,
  year: number,
): Promise<void> {
  const scoped = admin.withBranch(branchId);

  const raw = await scoped.get<unknown>(`/payrolls?year=${year}`).catch((e: Error) => {
    throw new Error(`GET /payrolls?year=${year} failed: ${e.message}`);
  });

  const runs = asList<{ id: string; month: number; year: number; status: string; branchId?: string | null }>(raw)
    // `branchId` is compared as well as trusted-by-header: an ADMIN with global
    // branch access may see every branch's runs regardless of the header, and
    // deleting another branch's payroll would be a spectacular way to fail a
    // completely different spec.
    .filter((p) => p.month === month && p.year === year && p.branchId === branchId);

  for (const run of runs) {
    if (run.status === 'LOCKED') {
      const ok = await scoped
        .post(`/payrolls/${run.id}/unlock`, { reason: 'e2e teardown — clearing the period for a fresh run' })
        .then(() => true)
        .catch((e: Error) => {
          console.error(`[payroll-support] could not unlock payroll ${run.id}: ${e.message}`);
          return false;
        });
      if (!ok) continue;
    }
    await scoped.delete(`/payrolls/${run.id}`).catch((e: Error) => {
      console.error(`[payroll-support] could not delete payroll ${run.id}: ${e.message}`);
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The payroll edge-case lane
// ───────────────────────────────────────────────────────────────────────────

/**
 * Re-exported from `payroll-period.ts`, which is pure and therefore unit-tested.
 * A spec imports the branch code, the year band and the date arithmetic from
 * here alongside everything else it needs, and never has to know there are two
 * files.
 */
// Imported for use BELOW, then re-exported for callers. `export … from` alone
// publishes a name without binding it in this module's scope, which is why the
// two forms are both here rather than one — the same trap `asList` fell into
// when this file was carved out.
import {
  PAYROLL_EDGE_BRANCH_CODE,
  PAYROLL_EDGE_BRANCH_NAME,
  PAYROLL_EDGE_BRANCH_COUNTRY,
  dateIn,
  lastDayOf,
  periodKey,
  type Period,
} from './payroll-period';

export {
  PAYROLL_EDGE_BRANCH_CODE,
  PAYROLL_EDGE_BRANCH_NAME,
  PAYROLL_EDGE_BRANCH_COUNTRY,
  PAYROLL_EDGE_YEARS,
  PAYROLL_EDGE_PAST_YEARS,
  periodKey,
  periodAt,
  pastEdgePeriod,
  edgePeriod,
  dateIn,
  lastDayOf,
} from './payroll-period';

export type { Period } from './payroll-period';

// ───────────────────────────────────────────────────────────────────────────
// Payroll inputs
// ───────────────────────────────────────────────────────────────────────────
//
// Every payload below was checked against the running backend's own OpenAPI
// document (`GET /api/docs-json`, 515 paths) rather than against the source, and
// the surprises are recorded on the helper that hit them. The global pipe runs
// `forbidNonWhitelisted`, so one stray key is a 400 on the whole request — which
// in a `beforeAll` reads as "the seam is broken" rather than "the payload is".

/** `PRESENT` is what a payroll run treats as a worked day; the rest are its opposites. */
export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'LEAVE' | 'HOLIDAY';

/**
 * Books attendance for one employee across many dates.
 *
 * `Attendance` is `@@unique([employeeId, date])`, so a repeat write for the same
 * day is an UPSERT, not a duplicate and not a 409. That is worth knowing before
 * writing a case about duplicate attendance: the row cannot be duplicated, and
 * the honest assertion is that the second write replaced the first.
 *
 * Times are wall-clock `HH:MM`. The suite pins the browser and the server to UTC
 * (see `playwright.config.ts`), so they mean the same instant in both.
 */
export async function seedAttendance(
  admin: ApiClient,
  branchId: string,
  employeeId: string,
  dates: string[],
  opts: { checkIn?: string; checkOut?: string; status?: AttendanceStatus; notes?: string } = {},
): Promise<void> {
  const scoped = admin.withBranch(branchId);
  for (const date of dates) {
    await scoped
      .post('/attendances/manual', {
        employeeId,
        date,
        checkIn: opts.checkIn ?? '09:00',
        checkOut: opts.checkOut ?? '17:00',
        status: opts.status ?? 'PRESENT',
        notes: opts.notes ?? 'e2e: payroll-edge input',
      })
      .catch((e: Error) => {
        throw new Error(`POST /attendances/manual ${employeeId} on ${date} failed: ${e.message}`);
      });
  }
}

/**
 * The ONLY leave types a request may carry.
 *
 * `CreateLeaveRequestDto.leaveType` is an `@IsEnum` over exactly these seven —
 * it is NOT the `LEAVE_TYPE` library. This matters and it is counter-intuitive:
 * the payroll engine decides paid-vs-unpaid by reading `LibraryItem.isPaid` for
 * the matching label, so the library is what PRICES leave, while this enum is
 * what can be FILED. A library type added for a test can therefore be paid or
 * unpaid all it likes and still be unfileable through this endpoint.
 *
 * `UNPAID` is the one that drives loss of pay out of the box.
 */
export const LEAVE_TYPES = [
  'ANNUAL',
  'SICK',
  'UNPAID',
  'MATERNITY',
  'PATERNITY',
  'BEREAVEMENT',
  'OTHER',
] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

/**
 * Files leave for an employee and, unless told otherwise, approves it — because
 * an unapproved request is invisible to payroll, and a spec that forgot the
 * approval sees "leave had no effect" rather than "leave was never approved".
 *
 * Filed on behalf: `employeeId` is an optional field on the DTO, which is how an
 * ADMIN books leave for someone whose login `makeEmployee` cannot hand back.
 */
export async function seedLeave(
  admin: ApiClient,
  branchId: string,
  employeeId: string,
  leaveType: LeaveType,
  startDate: string,
  endDate: string,
  opts: { reason?: string; approve?: boolean } = {},
): Promise<string> {
  const scoped = admin.withBranch(branchId);
  const made = await scoped
    .post<{ id: string }>('/leave-requests', {
      employeeId,
      leaveType,
      startDate,
      endDate,
      reason: opts.reason ?? 'e2e: payroll-edge input',
    })
    .catch((e: Error) => {
      throw new Error(
        `POST /leave-requests ${leaveType} ${startDate}..${endDate} for ${employeeId} failed: ${e.message}`,
      );
    });

  const id = inner<{ id: string }>(made)?.id ?? made?.id;
  if (!id) throw new Error(`POST /leave-requests returned no id for ${employeeId}`);

  if (opts.approve !== false) {
    await scoped.post(`/leave-requests/${id}/approve`, { comment: 'e2e: seeded' }).catch((e: Error) => {
      throw new Error(`POST /leave-requests/${id}/approve failed: ${e.message}`);
    });
  }
  return id;
}

/** Cancels a leave request. The route is a DELETE and it means cancel, not erase. */
export async function cancelLeave(admin: ApiClient, leaveId: string): Promise<void> {
  await admin.delete(`/leave-requests/${leaveId}`).catch((e: Error) => {
    throw new Error(`DELETE /leave-requests/${leaveId} failed: ${e.message}`);
  });
}

/**
 * Files an overtime claim for an employee and approves it by default.
 *
 * `CreateOvertimeDto` carries no `employeeId` — the on-behalf route puts it in
 * the PATH (`POST /overtime/employee/:employeeId`) and takes the same body.
 * `startTime`/`endTime` are full ISO instants, not `HH:MM`; an `endTime` at or
 * before `startTime` on the same date is read by the server as crossing
 * midnight, which is how a night-shift claim is expressed.
 */
export async function seedOvertime(
  admin: ApiClient,
  branchId: string,
  employeeId: string,
  date: string,
  startTime: string,
  endTime: string,
  hours: number,
  opts: { reason?: string; approve?: boolean } = {},
): Promise<string> {
  const scoped = admin.withBranch(branchId);
  const made = await scoped
    .post<{ id: string }>(`/overtime/employee/${employeeId}`, {
      date,
      startTime,
      endTime,
      hours,
      // Only mandatory while `overtime_require_reason` is on, and always
      // harmless — cheaper to always send than to read the flag first.
      reason: opts.reason ?? 'e2e: payroll-edge input',
    })
    .catch((e: Error) => {
      throw new Error(`POST /overtime/employee/${employeeId} on ${date} failed: ${e.message}`);
    });

  const id = inner<{ id: string }>(made)?.id ?? made?.id;
  if (!id) throw new Error(`POST /overtime/employee/${employeeId} returned no id`);

  if (opts.approve !== false) {
    await scoped.post(`/overtime/${id}/approve`, {}).catch((e: Error) => {
      throw new Error(`POST /overtime/${id}/approve failed: ${e.message}`);
    });
  }
  return id;
}

/**
 * Adds a recurring pay component.
 *
 * `effectiveDate` is the knob every mid-period case turns. Note what the engine
 * does with it: `create()` selects components that are active and effective ON OR
 * BEFORE the period end, and then applies the **whole monthly amount**. There is
 * no proration — a component effective on the 20th is paid as though it applied
 * from the 1st. That is finding G2, and a spec asserting otherwise is asserting a
 * feature that does not exist.
 */
export async function addComponent(
  admin: ApiClient,
  employeeId: string,
  componentType: string,
  amount: number,
  opts: { effectiveDate?: string; note?: string } = {},
): Promise<string> {
  const body: Record<string, unknown> = { employeeId, componentType, amount };
  if (opts.effectiveDate) body.effectiveDate = opts.effectiveDate;
  if (opts.note) body.note = opts.note;

  const made = await admin.post<{ id: string }>('/salary-components', body).catch((e: Error) => {
    throw new Error(`POST /salary-components ${componentType}=${amount} for ${employeeId} failed: ${e.message}`);
  });
  const id = inner<{ id: string }>(made)?.id ?? made?.id;
  if (!id) throw new Error('POST /salary-components returned no id');
  return id;
}

/**
 * Retires a component. Deactivate, never delete: `DELETE` is ADMIN-only and is
 * refused outright once the employee has a LOCKED payroll, which is a state most
 * of these specs deliberately reach.
 */
export async function retireComponent(admin: ApiClient, componentId: string): Promise<void> {
  await admin.post(`/salary-components/${componentId}/deactivate`, {}).catch((e: Error) => {
    throw new Error(`POST /salary-components/${componentId}/deactivate failed: ${e.message}`);
  });
}

/**
 * Adds a public holiday, per branch.
 *
 * `branchId` is nullable on the DTO and the distinction is the point: a null
 * branch is a company-wide holiday, a set one belongs to that branch only. Two
 * branches with different calendars producing different `workDays` for the same
 * month is a case this suite owns, and it is unreachable without passing it.
 */
export async function ensureHoliday(
  admin: ApiClient,
  date: string,
  name: string,
  opts: { branchId?: string; description?: string } = {},
): Promise<string> {
  const year = Number(date.slice(0, 4));

  // `ensure`, and it has to mean it. The server enforces one holiday per date per
  // scope and answers 409 — "A holiday already exists on this date for this
  // scope" — so a plain POST works exactly once and then fails on every retry,
  // every re-run against an un-reset database, and every second spec that wants
  // the same public holiday. Look first.
  const existingId = await findHoliday(admin, year, date, opts.branchId);
  if (existingId) return existingId;

  const body: Record<string, unknown> = { name, date };
  if (opts.branchId) body.branchId = opts.branchId;
  if (opts.description) body.description = opts.description;

  const made = await admin.post<{ id: string }>('/holidays', body).catch(async (e: Error) => {
    // Lost a race, or this scope match is narrower than the server's. Ask again
    // rather than failing: the postcondition promised here is that the date IS a
    // holiday, not that this particular call is what made it one.
    if (/already exists/i.test(e.message)) {
      const raced = await findHoliday(admin, year, date, opts.branchId);
      if (raced) return { id: raced };
    }
    throw new Error(`POST /holidays "${name}" on ${date} failed: ${e.message}`);
  });

  const id = inner<{ id: string }>(made)?.id ?? made?.id;
  if (!id) throw new Error(`POST /holidays "${name}" returned no id`);
  return id;
}

/** A holiday id for a date, within a branch scope or company-wide. */
async function findHoliday(
  admin: ApiClient,
  year: number,
  date: string,
  branchId?: string,
): Promise<string | null> {
  const raw = await admin.get<unknown>(`/holidays?year=${year}`).catch(() => null);
  const rows = asList<{ id: string; date: string; branchId?: string | null }>(raw);
  const onDate = rows.filter((h) => String(h.date).slice(0, 10) === date);
  // A branch-scoped holiday and a company-wide one on the same date are two
  // different records; match the scope that was asked for.
  const scoped = branchId
    ? onDate.find((h) => h.branchId === branchId)
    : onDate.find((h) => !h.branchId);
  return scoped?.id ?? null;
}

/**
 * Files an attendance correction on an employee's behalf, and approves it by
 * default — approval is what actually upserts the `Attendance` row, so an
 * unapproved correction changes nothing a payroll run can see.
 *
 * The whole point of this helper is the case where it is called AFTER a run has
 * been generated or approved.
 */
export async function fileAttendanceCorrection(
  admin: ApiClient,
  branchId: string,
  employeeId: string,
  date: string,
  patch: { requestedCheckIn?: string; requestedCheckOut?: string },
  opts: { reason?: string; approve?: boolean } = {},
): Promise<string> {
  const scoped = admin.withBranch(branchId);
  const made = await scoped
    .post<{ id: string }>(`/attendance-corrections/employee/${employeeId}`, {
      date,
      ...patch,
      reason: opts.reason ?? 'e2e: payroll-edge correction',
    })
    .catch((e: Error) => {
      throw new Error(`POST /attendance-corrections/employee/${employeeId} on ${date} failed: ${e.message}`);
    });

  const id = inner<{ id: string }>(made)?.id ?? made?.id;
  if (!id) throw new Error('POST /attendance-corrections returned no id');

  if (opts.approve !== false) {
    await scoped
      // `notes`, NOT `comment`. Leave approval takes `ApproveRejectDto`
      // ({ comment, rejectedReason }); this one takes
      // `ApproveAttendanceCorrectionDto` ({ notes }). Two approve routes, two
      // DTOs, and `forbidNonWhitelisted` turns the wrong one into
      // `["property comment should not exist"]`.
      .post(`/attendance-corrections/${id}/approve`, { notes: 'e2e: seeded' })
      .catch((e: Error) => {
        throw new Error(`POST /attendance-corrections/${id}/approve failed: ${e.message}`);
      });
  }
  return id;
}

// ───────────────────────────────────────────────────────────────────────────
// Reading a run back
// ───────────────────────────────────────────────────────────────────────────

/**
 * One line of a payroll run.
 *
 * Every money column is `Decimal(12,2)` and therefore arrives as a STRING.
 * `itemsOf` converts them once here rather than making eleven spec files each
 * remember to — a spec comparing `'600.00' === 600` fails for a reason that has
 * nothing to do with payroll.
 */
export interface PayrollItemRow {
  id: string;
  employeeId: string;
  baseSalary: number;
  workDays: number;
  actualWorkDays: number;
  allowances: number;
  bonus: number;
  deduction: number;
  overtimeHours: number;
  overtimePay: number;
  foodAllowance: number;
  reimbursement: number;
  advanceLoanDeduction: number;
  garnishment: number;
  insurance: number;
  tax: number;
  netSalary: number;
  notes: string | null;
}

const NUMERIC_ITEM_KEYS = [
  'baseSalary', 'workDays', 'actualWorkDays', 'allowances', 'bonus', 'deduction',
  'overtimeHours', 'overtimePay', 'foodAllowance', 'reimbursement',
  'advanceLoanDeduction', 'garnishment', 'insurance', 'tax', 'netSalary',
] as const;

function num(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Every item on a run, money coerced to numbers.
 *
 * **Pass `branchId` in any spec that touches more than one branch.**
 * `ApiClient.withBranch()` MUTATES the client rather than returning a scoped
 * copy, so the header left behind by the last call leaks into the next one. A
 * cross-branch read then answers **404** — branch scoping working correctly — and
 * it surfaces as "the payroll I just created does not exist", which reads as a
 * product defect. Single-branch specs can omit it because the header always
 * happens to be right.
 */
export async function itemsOf(
  admin: ApiClient,
  payrollId: string,
  branchId?: string,
): Promise<PayrollItemRow[]> {
  const client = branchId ? admin.withBranch(branchId) : admin;
  const raw = await client.get<unknown>(`/payrolls/${payrollId}`).catch((e: Error) => {
    throw new Error(`GET /payrolls/${payrollId} failed: ${e.message}`);
  });
  const payroll = inner<{ items?: unknown[] }>(raw);
  return (payroll?.items ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    const out = { ...r } as unknown as PayrollItemRow;
    for (const k of NUMERIC_ITEM_KEYS) (out as unknown as Record<string, number>)[k] = num(r[k]);
    return out;
  });
}

/**
 * The run's own approval trail.
 *
 * Worth knowing what this is NOT: `getApprovalHistory` reconstructs the trail
 * from the `Payroll` row's stamp columns (`submittedBy/At`, `approvedBy/At`, …).
 * It does not read `audit_logs`, so it agrees with the record only as far as
 * those columns go. `auditFor` is the other half.
 */
export async function historyOf(admin: ApiClient, payrollId: string): Promise<HistoryEntry[]> {
  const raw = await admin.get<unknown>(`/payrolls/${payrollId}/history`).catch((e: Error) => {
    throw new Error(`GET /payrolls/${payrollId}/history failed: ${e.message}`);
  });
  // The trail is NESTED, not the payload: the route answers
  // `{ success, data: { payrollId, month, year, currentStatus, version, history } }`
  // and `ApiClient` unwraps exactly one `data` level, so what arrives here is the
  // summary object with the array under `.history`. Reading it as a list returns
  // an empty array for a run that has a full trail — which is a passing
  // assertion about the wrong thing.
  const summary = inner<{ history?: unknown[] }>(raw);
  return (summary?.history ?? []) as HistoryEntry[];
}

/** One step of the reconstructed approval trail. */
export interface HistoryEntry {
  action: string;
  timestamp: string;
  performedBy?: string;
  status?: string;
}

export interface AuditRow {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  oldData: unknown;
  newData: unknown;
  branchId: string | null;
  createdAt: string;
}

/**
 * Audit rows for ONE record.
 *
 * `GET /audit-logs` has no `resourceId` filter — the query surface is
 * `page, limit, userId, resourceType, action, dateFrom, dateTo, search` — so the
 * narrowing is done here, client-side, over a generous page. Passing a `limit`
 * smaller than the number of rows the run produced is how a case ends up
 * asserting "no audit entry" about a record that has several.
 *
 * `resourceType` is matched case-insensitively by the server and is the
 * PascalCase Prisma model name: `Payroll`, `PayrollBatch`, `SalaryComponent`,
 * `WpsFile`.
 *
 * Expect `action` to be the generic `CREATE`/`UPDATE`/`DELETE` derived from the
 * HTTP verb for anything payroll does — see finding G1. Only WPS writes named
 * verbs.
 */
export async function auditFor(
  admin: ApiClient,
  resourceType: string,
  resourceId: string,
  opts: { limit?: number } = {},
): Promise<AuditRow[]> {
  const limit = opts.limit ?? 200;
  const raw = await admin
    .get<unknown>(`/audit-logs?resourceType=${encodeURIComponent(resourceType)}&limit=${limit}`)
    .catch((e: Error) => {
      throw new Error(`GET /audit-logs?resourceType=${resourceType} failed: ${e.message}`);
    });
  return asList<AuditRow>(raw).filter((r) => r.resourceId === resourceId);
}

// ───────────────────────────────────────────────────────────────────────────
// Fixtures for the edge-case lane
// ───────────────────────────────────────────────────────────────────────────

/**
 * The `E2E-PAY` branch, created on first use and set up to bank in Oman.
 *
 * The country matters and is easy to miss: `POST /branches` takes only `code` and
 * `name`, so a branch created by `ensureBranch` alone has `country: null` and
 * `bankingCountries: []`. Every banking and WPS case then fails for a reason that
 * looks like a payroll defect — an employee's bank details are refused because
 * the branch banks in no country at all, and pre-flight reports
 * `NO_ACTIVE_BANK_DETAIL` for everyone. `wps.admin.spec.ts` was bitten by the
 * same class of thing from the other direction (it hardcoded `IN` against an
 * Oman seed) and the fix there was to resolve the country from the branch.
 *
 * Two different routes are needed, which is why this is not one call:
 *   • `PATCH /branches/:id { country }`                  — the branch's own country
 *   • `PUT /banks/branch-countries/:id { countries }`    — the countries it banks in
 *
 * Both are idempotent, so this runs on every `beforeAll` without accumulating.
 */
export async function ensurePayrollEdgeBranch(admin: ApiClient): Promise<string> {
  const id = await ensureBranch(admin, PAYROLL_EDGE_BRANCH_CODE, PAYROLL_EDGE_BRANCH_NAME);

  // Best-effort: a spec that does not touch banking must not fail because these
  // did, and a re-run against a branch already set up is a no-op either way.
  await admin.patch(`/branches/${id}`, { country: PAYROLL_EDGE_BRANCH_COUNTRY }).catch(() => undefined);
  await admin
    .put(`/banks/branch-countries/${id}`, { countries: [PAYROLL_EDGE_BRANCH_COUNTRY] })
    .catch(() => undefined);

  return id;
}

/**
 * A subject and a twin: two employees identical in every way that pays, created
 * in the same branch with the same salary on the same day.
 *
 * **This is the idiom that makes the money assertions readable.** The twin owes
 * nothing and has nothing done to it, so `twin.netSalary` IS the net the subject
 * would have had. Every assertion can then be written as a DIFFERENCE —
 * `subject.netSalary + subject.advanceLoanDeduction === twin.netSalary` — and no
 * case has to know this environment's PF rate, tax brackets, ESI cap or work-day
 * count. Change the country preset and the arithmetic still holds.
 *
 * Without it, a spec either hard-codes a net (and breaks the first time a
 * statutory setting moves) or re-derives the engine's formula in the test (and
 * then passes when both are wrong in the same way).
 */
export async function twinPair(
  admin: ApiClient,
  opts: { marker: string; branchId: string; baseSalary?: number; startDate?: string },
): Promise<{ subject: TestEmployee; twin: TestEmployee }> {
  const shared = {
    baseSalary: opts.baseSalary ?? 1500,
    branchId: opts.branchId,
    startDate: opts.startDate,
  };
  const subject = await makeEmployee(admin, { ...shared, marker: `${opts.marker}-subject` });
  const twin = await makeEmployee(admin, { ...shared, marker: `${opts.marker}-twin` });
  return { subject, twin };
}

/**
 * Clears every run this family may have left behind, in the order that works.
 *
 * Newest period FIRST. `unlockPayroll` is refused with a 409 when a LATER run has
 * already recovered against a loan, so sweeping oldest-first wedges on the first
 * locked run and leaves the rest of the lane occupied — which the next run then
 * fails on, in a different file.
 */
export async function clearPayrollLane(
  admin: ApiClient,
  branchId: string,
  periods: Period[],
): Promise<void> {
  const newestFirst = [...periods].sort((a, b) => periodKey(b) - periodKey(a));
  for (const p of newestFirst) {
    await clearPayrolls(admin, branchId, p.month, p.year).catch((e: Error) => {
      console.error(`[payroll-support] could not clear ${p.month}/${p.year}: ${e.message}`);
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Opening a period, without poisoning the employees being measured
// ───────────────────────────────────────────────────────────────────────────

/**
 * ## The trap this exists to close
 *
 * `PayrollsService.create()` refuses a period in which NOBODY in the run has an
 * attendance row — *"Attendance for m/yyyy has not been processed yet"* — because
 * without that guard every employee would count as absent for every working day
 * and loss of pay would wipe the whole payroll off missing data
 * (`payrolls.service.ts:259`). The guard is scoped to the employees IN THE RUN,
 * so it cannot be satisfied by someone the run does not cover.
 *
 * `runPayroll` satisfies it lazily, by booking one PRESENT day for
 * `employeeIds[0]` and retrying. That is fine for a spec that measures one
 * employee. It is **actively wrong for a spec that measures two**, because of
 * how the engine reads attendance:
 *
 *   • an employee with NO attendance rows at all is treated as **fully present**
 *     (finding F36, `payrolls.service.ts:604`);
 *   • an employee WITH rows is paid for exactly the days those rows show.
 *
 * So the carrier is paid for ONE day and everybody else for the whole month. The
 * first `twinPair` smoke case caught this immediately: two employees created
 * identically, in the same branch, on the same salary, were paid **70.89 and
 * 1488.75** — a 21× gap with nothing between them but list position.
 *
 * ## What this does instead
 *
 * A **dedicated carrier** employee, created once per branch, whose only job is to
 * hold the attendance row that opens the period. It is included in the run so the
 * guard passes, and it is never asserted on. Every employee a spec actually
 * measures keeps no attendance rows and is therefore treated as fully present —
 * which is what makes net pay a clean function of `baseSalary` and the twin
 * comparison meaningful.
 *
 * A spec should call `runEdgePayroll` and never `runPayroll` directly.
 */
export async function ensureCarrier(
  admin: ApiClient,
  branchId: string,
  markerPrefix: string,
): Promise<TestEmployee> {
  return makeEmployee(admin, {
    marker: `${markerPrefix}-carrier`,
    branchId,
    // A carrier is never measured, so its salary is irrelevant — but it must be
    // non-zero, because an employee on zero pay exercises different branches of
    // the engine (`loan_zero_salary_policy`) and a carrier should be the most
    // boring row in the run.
    baseSalary: 1000,
  });
}

export interface EdgeRunOpts {
  branchId: string;
  period: Period;
  /** The employees the spec will assert on. The carrier is added automatically. */
  employeeIds: string[];
  carrier: TestEmployee;
  runType?: string;
}

/**
 * Generates a run over a period that has been opened by the carrier, so that
 * every employee in `employeeIds` is evaluated on the same footing.
 *
 * The carrier's attendance day is booked BEFORE the run, so `runPayroll`'s lazy
 * fallback never fires and never picks one of the measured employees.
 */
export async function runEdgePayroll(
  admin: ApiClient,
  opts: EdgeRunOpts,
): Promise<{ id: string; status: string; items: unknown[] }> {
  await seedAttendance(admin, opts.branchId, opts.carrier.id, [dateIn(opts.period, 1)], {
    notes: 'e2e: carrier row — opens the period, never asserted on',
  });

  return runPayroll(admin, {
    month: opts.period.month,
    year: opts.period.year,
    branchId: opts.branchId,
    runType: opts.runType,
    employeeIds: [opts.carrier.id, ...opts.employeeIds],
  });
}

// ───────────────────────────────────────────────────────────────────────────
// The wage file (WPS) — payroll's exit
// ───────────────────────────────────────────────────────────────────────────

/** One finding from a pre-flight, run-level or per-employee. */
export interface WpsFinding {
  code: string;
  severity: 'BLOCKING' | 'WARNING';
  scope?: string;
  field?: string;
  message: string;
  fix?: { label: string; href: string };
}

/** What `POST /wps/preflight` answers. */
export interface PreflightResult {
  payrollId: string;
  branchCode: string;
  format: string;
  currency: string;
  ready: number;
  total: number;
  blockedEmployees: number;
  warningEmployees: number;
  canGenerate: boolean;
  runFindings: WpsFinding[];
  byEmployee: Array<{
    employeeId: string;
    employeeCode: string;
    fullName: string;
    status: 'READY' | 'WARNING' | 'BLOCKED';
    findings: WpsFinding[];
  }>;
  requiresAcknowledgement: string[];
}

/**
 * Makes sure the branch can generate a wage file at all, and returns the format.
 *
 * Without an employer profile AND a per-branch config, `POST /wps/preflight`
 * answers a flat 400 — *"No wage-file configuration exists for branch X"* —
 * before it evaluates anything else. That refusal is correct and useless to a
 * spec about payroll: every case would fail on setup rather than on its subject.
 *
 * Both writes are idempotent by lookup, so this runs from `beforeAll` on every
 * invocation without accumulating profiles.
 */
export async function ensureWpsConfig(
  admin: ApiClient,
  branchId: string,
  opts: { profileName?: string } = {},
): Promise<{ format: string; employerProfileId: string }> {
  const rawFormats = await admin.get<unknown>('/wps/formats').catch((e: Error) => {
    throw new Error(`GET /wps/formats failed: ${e.message}`);
  });
  const formats = asList<{ key: string }>(rawFormats);
  // Prefer an Oman format: the branch banks in OM and the seeded Bank Master,
  // IBAN schema and employer fields are all Omani.
  const format = (formats.find((f) => f.key.startsWith('om-')) ?? formats[0])?.key;
  if (!format) throw new Error('GET /wps/formats returned no formats');

  const name = opts.profileName ?? 'E2E Payroll Edge Employer';
  const existing = asList<{ id: string; name: string }>(
    await admin.get<unknown>('/wps/employer-profiles').catch(() => []),
  ).find((p) => p.name === name);

  const employerProfileId =
    existing?.id ??
    (await admin
      .post<{ id: string }>('/wps/employer-profiles', {
        name,
        legalName: `${name} LLC`,
        country: PAYROLL_EDGE_BRANCH_COUNTRY,
        format,
        data: {},
      })
      .then((r) => inner<{ id: string }>(r)?.id ?? (r as { id: string })?.id)
      .catch((e: Error) => {
        throw new Error(`POST /wps/employer-profiles failed: ${e.message}`);
      }));

  // Upsert; a second call for the same branch is a no-op.
  await admin
    .post('/wps/config', { branchId, employerProfileId, format, enabled: true })
    .catch(() => undefined);

  return { format, employerProfileId };
}

/** Runs pre-flight and returns the structured result. */
export async function preflight(
  admin: ApiClient,
  branchId: string,
  payrollId: string,
): Promise<PreflightResult> {
  const raw = await admin
    .withBranch(branchId)
    .post<unknown>('/wps/preflight', { payrollId })
    .catch((e: Error) => {
      throw new Error(`POST /wps/preflight for ${payrollId} failed: ${e.message}`);
    });
  return inner<PreflightResult>(raw);
}

/** Every run-level finding code a pre-flight raised, deduplicated. */
export function runFindingCodes(pf: PreflightResult): string[] {
  return [...new Set((pf.runFindings ?? []).map((f) => f.code))];
}

// ───────────────────────────────────────────────────────────────────────────
// Working calendars
// ───────────────────────────────────────────────────────────────────────────

/**
 * A branch with a specific weekly-off pair, created on first use.
 *
 * `Branch.weeklyOffDays` is a CSV of JS day numbers — `"5,6"` is Friday+Saturday,
 * the Gulf weekend; `"0,6"` is Sunday+Saturday. A null column inherits the global
 * `calendar_weekly_holidays` setting, which is why this is set explicitly: a
 * branch that inherits proves nothing about per-branch calendars.
 *
 * This is the one piece of statutory configuration that can be varied WITHOUT
 * touching a global system setting, which is what makes it safe to assert in the
 * default run. Country presets and overtime multipliers are global and shared by
 * every worker, so those cases sit behind `flagFlipAllowed()`.
 */
export async function ensureBranchWithWeekend(
  admin: ApiClient,
  code: string,
  name: string,
  weeklyOffDays: string,
): Promise<string> {
  const id = await ensureBranch(admin, code, name);
  await admin.patch(`/branches/${id}`, { weeklyOffDays }).catch((e: Error) => {
    throw new Error(`PATCH /branches/${id} weeklyOffDays="${weeklyOffDays}" failed: ${e.message}`);
  });
  return id;
}

/** The work-day breakdown a branch's calendar produces for a period. */
export interface WorkDayBreakdown {
  month: number;
  year: number;
  branchId: string | null;
  totalDays: number;
  workDays: number;
  weekends: number;
  holidays: number;
}

/**
 * Reads a branch's work-day breakdown.
 *
 * `branchId` is a QUERY parameter here, not the `X-Branch-Id` header — passing
 * the header alone silently returns the GLOBAL calendar with `branchId: null`,
 * and two branches then look identical for a reason that has nothing to do with
 * their configuration.
 */
export async function workDaysFor(
  admin: ApiClient,
  branchId: string,
  period: Period,
): Promise<WorkDayBreakdown> {
  const raw = await admin
    .get<unknown>(`/holidays/work-days/${period.month}/${period.year}?branchId=${branchId}`)
    .catch((e: Error) => {
      throw new Error(`GET /holidays/work-days/${period.month}/${period.year} failed: ${e.message}`);
    });
  return inner<WorkDayBreakdown>(raw);
}

// ── Court orders and the carry-forward ledger ──────────────────────────────

export interface GarnishmentRow {
  id: string;
  employeeId: string;
  amount: string | number | null;
  percentOfNet: string | number | null;
  reference: string;
  priority: number;
  isActive: boolean;
  totalCap: string | number | null;
  collected: string | number;
}

export interface CarryForwardRow {
  id: string;
  employeeId: string;
  kind: string;
  sourceId: string | null;
  amount: string | number;
  amountRecovered: string | number;
  status: string;
  originPayrollId: string | null;
  clearedPayrollId: string | null;
  reason: string | null;
}

/**
 * Record a court-ordered attachment of earnings.
 *
 * `reference` defaults to a marker-derived value rather than a constant:
 * the column is not unique, but two cases sharing a reference makes a failure
 * message ambiguous about which order it is talking about.
 */
export async function addGarnishment(
  admin: ApiClient,
  opts: {
    employeeId: string;
    branchId: string;
    amount?: number;
    percentOfNet?: number;
    reference?: string;
    priority?: number;
    startDate?: string;
    endDate?: string;
    totalCap?: number;
  },
): Promise<GarnishmentRow> {
  const body: Record<string, unknown> = {
    employeeId: opts.employeeId,
    reference: opts.reference ?? `CR-${opts.employeeId.slice(0, 8)}`,
    startDate: opts.startDate ?? '2020-01-01',
  };
  if (opts.amount !== undefined) body.amount = opts.amount;
  if (opts.percentOfNet !== undefined) body.percentOfNet = opts.percentOfNet;
  if (opts.priority !== undefined) body.priority = opts.priority;
  if (opts.endDate !== undefined) body.endDate = opts.endDate;
  if (opts.totalCap !== undefined) body.totalCap = opts.totalCap;

  const raw = await admin.withBranch(opts.branchId).post<unknown>('/garnishments', body);
  return inner(raw) as GarnishmentRow;
}

/** Revoke an order. A flag flip — runs already generated under it stay intact. */
export async function revokeGarnishment(
  admin: ApiClient,
  branchId: string,
  id: string,
): Promise<void> {
  await admin.withBranch(branchId).patch(`/garnishments/${id}/revoke`, {});
}

export async function garnishmentsOf(
  admin: ApiClient,
  branchId: string,
  employeeId: string,
): Promise<GarnishmentRow[]> {
  const raw = await admin
    .withBranch(branchId)
    .get<unknown>(`/garnishments?employeeId=${employeeId}`);
  return asList(raw) as GarnishmentRow[];
}

/** Balances a run could not recover, held against the employee. */
export async function carryForwardsOf(
  admin: ApiClient,
  branchId: string,
  employeeId: string,
): Promise<CarryForwardRow[]> {
  const raw = await admin
    .withBranch(branchId)
    .get<unknown>(`/garnishments/employee/${employeeId}/carry-forwards`);
  return asList(raw) as CarryForwardRow[];
}

/** Write a carried balance off. The reason is mandatory at the API. */
export async function waiveCarryForward(
  admin: ApiClient,
  branchId: string,
  id: string,
  reason: string,
): Promise<CarryForwardRow> {
  const raw = await admin
    .withBranch(branchId)
    .patch<unknown>(`/garnishments/carry-forwards/${id}/waive`, { reason });
  return inner(raw) as CarryForwardRow;
}

// ── Payroll extensions ──────────────────────────────────────────────────────
//
// Every feature below ships OFF, so each helper is useful in two ways: driving
// the feature when a flagged run has turned it on, and proving it is inert when
// it has not. None of them asserts — that rule holds here as everywhere else in
// this file.

/** The switches, so a spec names them once rather than spelling out keys. */
export const PAYROLL_FEATURE_FLAGS = {
  itemLines: 'payroll_item_lines_enabled',
  eosb: 'payroll_eosb_enabled',
  eosbAccrual: 'payroll_eosb_accrual_enabled',
  eosbSettlement: 'payroll_eosb_settlement_enabled',
  encashment: 'leave_encashment_enabled',
  carryForward: 'leave_carry_forward_enabled',
  calendar: 'payroll_calendar_enabled',
  preflight: 'payroll_preflight_enabled',
  recovery: 'payroll_employee_recovery_enabled',
  transfer: 'employee_transfer_enabled',
  grade: 'employee_grade_enabled',
  reports: 'payroll_reports_enabled',
} as const;

export type PayrollFeatureName = keyof typeof PAYROLL_FEATURE_FLAGS;

/**
 * The one skip sentence, so a dozen files cannot drift on it.
 *
 * Printed by `test.skip` in the default lane, where flag flips are refused.
 */
export function featureSkipReason(...names: PayrollFeatureName[]): string {
  return (
    `needs ${names.join(' + ')} switched on, which moves a GLOBAL setting — ` +
    `run scripts/e2e-payroll-edge-flagged.sh`
  );
}

/**
 * Turn features on for the duration of `fn`, then put them back.
 *
 * `extra` exists for the settings a feature READS but does not own. Gratuity is
 * the worked example: its rules are keyed by country, the seeded rule is Oman's,
 * and the baseline database is India — so a case that turns the feature on and
 * nothing else gets "no rule is configured for IN / EXPAT", which is correct
 * behaviour and a useless test.
 */
export async function withPayrollFeatures<T>(
  admin: ApiClient,
  names: PayrollFeatureName[],
  fn: () => Promise<T>,
  extra: Record<string, string> = {},
): Promise<T> {
  const kv: Record<string, string> = { ...extra };
  for (const n of names) kv[PAYROLL_FEATURE_FLAGS[n]] = 'true';
  return withSettings(admin, kv, fn);
}

/** One payslip line, as the API returns it. */
export interface PayrollItemLineRow {
  id: string;
  payrollItemId: string;
  code: string;
  label: string;
  category: 'EARNING' | 'DEDUCTION';
  bucket: string;
  amount: string | number;
  displayOrder: number;
}

/**
 * The itemised breakdown of one payslip.
 *
 * Returns `[]` when itemisation is off, which is the same thing the API does —
 * the field is simply absent — so a spec can call this unconditionally.
 */
export async function linesOf(
  admin: ApiClient,
  branchId: string,
  payrollId: string,
  employeeId: string,
): Promise<PayrollItemLineRow[]> {
  const raw = await admin.withBranch(branchId).get<unknown>(`/payrolls/${payrollId}`);
  const payroll = inner(raw) as { items?: Array<{ employeeId: string; lines?: unknown }> };
  const item = (payroll.items ?? []).find((i) => i.employeeId === employeeId);
  return (item?.lines as PayrollItemLineRow[]) ?? [];
}

/**
 * Sum the lines of one bucket.
 *
 * The invariant every itemisation case checks is per BUCKET, not per category:
 * `deduction`, `insurance` and `tax` are three separate deduction columns, and
 * summing across them would let a PF line reconcile against a loan instalment.
 */
export function sumBucket(lines: PayrollItemLineRow[], bucket: string): number {
  return (
    Math.round(
      lines
        .filter((l) => l.bucket === bucket)
        .reduce((a, l) => a + Number(l.amount), 0) * 100,
    ) / 100
  );
}

export interface PreflightResultRow {
  ready: number;
  total: number;
  canGenerate: boolean;
  blockedEmployees: number;
  warningEmployees: number;
  runFindings: Array<{ code: string; severity: string; message: string }>;
  byEmployee: Array<{
    employeeId: string;
    employeeCode: string;
    status: string;
    findings: Array<{ code: string; severity: string }>;
  }>;
  requiresAcknowledgement: string[];
  window: { periodStart: string; periodEnd: string; cutOffDate: string | null; fromCalendar: boolean };
}

/** "Is this run safe to generate?" — writes nothing. */
export async function preflightRun(
  admin: ApiClient,
  opts: { branchId: string; period: Period; employeeIds?: string[] },
): Promise<PreflightResultRow> {
  const raw = await admin.withBranch(opts.branchId).post<unknown>('/payrolls/preflight', {
    branchId: opts.branchId,
    month: opts.period.month,
    year: opts.period.year,
    employeeIds: opts.employeeIds,
  });
  return inner(raw) as PreflightResultRow;
}

/** Every finding code a preflight produced, run-level and per-employee. */
export function preflightCodes(r: PreflightResultRow): string[] {
  return [
    ...r.runFindings.map((f) => f.code),
    ...r.byEmployee.flatMap((e) => e.findings.map((f) => f.code)),
  ].sort();
}

export interface GratuityEntitlementRow {
  serviceYears: number;
  amount: number;
  provisioned: number;
  refusal: string | null;
  workingLines: string[];
}

/** What one employee would receive if they left on `asOf`. */
export async function gratuityEntitlement(
  admin: ApiClient,
  branchId: string,
  employeeId: string,
  asOf?: string,
): Promise<GratuityEntitlementRow> {
  const raw = await admin
    .withBranch(branchId)
    .get<unknown>(
      `/gratuity/employee/${employeeId}/entitlement${asOf ? `?asOf=${asOf}` : ''}`,
    );
  return inner(raw) as GratuityEntitlementRow;
}

/** Set an employee's nationality class, which gratuity refuses to guess at. */
export async function setNationalityClass(
  admin: ApiClient,
  employeeId: string,
  nationalityClass: 'NATIONAL' | 'GCC' | 'EXPAT',
): Promise<void> {
  await admin.patch<unknown>(`/employees/${employeeId}/profile`, { nationalityClass });
}

export interface SettlementRow {
  id: string;
  status: string;
  variant: string;
  netPayable: string | number;
  lines: Array<{
    id: string;
    code: string;
    label: string;
    category: string;
    computedAmount: string | number;
    adjustedAmount: string | number | null;
    adjustmentReason: string | null;
  }>;
}

export async function prepareSettlement(
  admin: ApiClient,
  branchId: string,
  opts: {
    employeeId: string;
    variant?: string;
    lastWorkingDate: string;
    pendingSalary?: number;
  },
): Promise<SettlementRow> {
  const raw = await admin.withBranch(branchId).post<unknown>('/final-settlements', {
    variant: 'RESIGNATION',
    ...opts,
  });
  return inner(raw) as SettlementRow;
}

/** The reason is mandatory at the API AND at a database CHECK. */
export async function adjustSettlementLine(
  admin: ApiClient,
  branchId: string,
  settlementId: string,
  lineId: string,
  amount: number,
  reason: string,
): Promise<unknown> {
  return admin
    .withBranch(branchId)
    .patch<unknown>(`/final-settlements/${settlementId}/lines/${lineId}`, {
      amount,
      reason,
    });
}

export interface RecoveryRow {
  id: string;
  kind: string;
  totalAmount: string | number;
  amountRecovered: string | number;
  status: string;
}

export async function addRecovery(
  admin: ApiClient,
  branchId: string,
  opts: {
    employeeId: string;
    kind?: string;
    totalAmount: number;
    instalmentAmount?: number;
    reference?: string;
    startDate?: string;
  },
): Promise<RecoveryRow> {
  const raw = await admin.withBranch(branchId).post<unknown>('/employee-recoveries', {
    kind: 'ASSET_DAMAGE',
    startDate: '2030-01-01',
    ...opts,
  });
  return inner(raw) as RecoveryRow;
}

export async function recoveriesOf(
  admin: ApiClient,
  branchId: string,
  employeeId: string,
): Promise<RecoveryRow[]> {
  const raw = await admin
    .withBranch(branchId)
    .get<unknown>(`/employee-recoveries/employee/${employeeId}`);
  return asList(raw) as RecoveryRow[];
}

/**
 * Seed a FULL month of weekday attendance.
 *
 * One token day is not "the period is open" — it is three weeks of loss of pay,
 * which leaves almost nothing for a recovery or a deduction to take. Any case
 * asserting on an AMOUNT rather than a difference needs the employee to have
 * actually earned a month first.
 */
export async function seedFullMonth(
  admin: ApiClient,
  branchId: string,
  employeeId: string,
  period: Period,
): Promise<void> {
  const lastDay = lastDayOf(period);
  const dates: string[] = [];
  for (let day = 1; day <= lastDay; day++) {
    const dow = new Date(Date.UTC(period.year, period.month - 1, day)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    dates.push(dateIn(period, day));
  }
  await seedAttendance(admin, branchId, employeeId, dates, { status: 'PRESENT' });
}
