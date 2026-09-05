import { ApiClient } from './fixtures';
import { asList, inner } from './payroll-support';

/**
 * Shared setup for the loan specs.
 *
 * ## Why this file exists
 *
 * `finance-loan-lifecycle.spec.ts` and `loans.admin-employee.spec.ts` each grew
 * their own private `retire` / `ensureAllowance` / `liveLoan`, and the two
 * copies had already drifted — one of them still lists `OVERDUE` as an open
 * status and omits `DISBURSED` and `RECEIVABLE`, which means it under-sweeps and
 * the file that owns it fails on the third run against a database nobody reset.
 * Thirteen more spec files copying a third variant of the same four functions is
 * how that drift becomes permanent, so the semantics live here once.
 *
 * Everything below is API-only on purpose. These helpers run from `beforeAll`,
 * where there is no `page` and no `expect`; a helper that imported Playwright's
 * `test` would make this module unusable from exactly the hook it exists for.
 * Nothing here asserts — a spec's assertions are the spec's own business, and a
 * setup helper that fails a test on the setup author's behalf hides which of the
 * two actually broke.
 *
 * ## The one thing that is NOT available, stated up front
 *
 * There is no API path that produces a *loggable* employee. `POST /employees`
 * does create a `User` row, but with a randomly generated temporary password
 * that is only ever emailed/WhatsApp'd — no endpoint returns it, `UpdateUserDto`
 * has no `password` field (and the global pipe runs `forbidNonWhitelisted`, so
 * sending one is a 400), and `POST /auth/register` refuses an employee that
 * already has an account. `makeEmployee` therefore creates a perfectly real
 * employee and REFUSES to hand back a client for them — see `TestEmployee.api`.
 *
 * ## Endpoints this module depends on, as verified against the backend
 *
 *   POST   /advance-loans                       { type, amount, installments?, reason? }
 *   POST   /advance-loans/eligibility           { amount, installments, type, employeeId? }
 *   POST   /advance-loans/:id/approve           { remarks?, installments? }
 *   POST   /advance-loans/:id/write-off         { reason }
 *   DELETE /advance-loans/:id                   (cancel — owner, DRAFT/PENDING only)
 *   GET    /advance-loans/:id                   detail, INCLUDING `deductions`
 *   GET    /advance-loans/:id/schedule          live schedule rows
 *   GET    /advance-loans/:id/payoff-quote      { success, data: {...} }
 *   GET    /advance-loans/my-requests           the caller's own requests
 *   GET    /advance-loans?page&limit            paginated envelope when page/limit given
 *   GET    /system-settings                     ARRAY of { key, value, description }
 *   POST   /system-settings                     { settings: Record<string,string> }  ← POST, not PUT
 *   GET    /branches                            array
 *   GET    /departments                         array
 *   POST   /employees                           CreateEmployeeDto
 *   DELETE /employees/:id?clearanceOverrideReason=…   soft delete → status INACTIVE
 *   PATCH  /employees/:id                       { baseSalary?, endDate?, status?, … }
 *   GET    /users?search=                       array of users (password never returned)
 *   PATCH  /users/:id/role                      { role }
 *   POST   /payrolls                            { month, year, runType?, employeeIds?, batchId? }
 *   GET    /payrolls?year=                      array; NO month or branch filter
 *   GET    /payrolls/:id                        payroll WITH `items`
 *   POST   /payrolls/:id/lock                   APPROVED → LOCKED
 *   POST   /payrolls/:id/unlock                 { reason }  (5–500 chars, ADMIN only)
 *   DELETE /payrolls/:id                        refused while LOCKED
 */

// ───────────────────────────────────────────────────────────────────────────
// Statuses
// ───────────────────────────────────────────────────────────────────────────

/**
 * Statuses that still count against the employee's live-loan allowance.
 *
 * The exact complement of the server's `LOAN_TERMINAL_STATUSES` in
 * `advance-loans/loan.types.ts`, which is the only definition that matters:
 * `loan_max_active_per_employee` is **2** by default, and a sweep that misses a
 * status leaves a loan holding a slot the next spec then cannot get.
 *
 * `OVERDUE` is deliberately absent even though `loans.admin-employee.spec.ts`
 * lists it — it is not a value the loan status column takes; overdue-ness is a
 * property of a schedule row, and including it here only made that file's list
 * look longer than the accurate one.
 */
export const OPEN_STATUSES: readonly string[] = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'DISBURSED',
  'ACTIVE',
  'ON_HOLD',
  'RECEIVABLE',
];

/** Mirrors `LOAN_TERMINAL_STATUSES`. A loan in one of these holds no allowance. */
export const TERMINAL_STATUSES: readonly string[] = [
  'REJECTED',
  'CANCELLED',
  'CLOSED',
  'WRITTEN_OFF',
  'SETTLED',
  'COMPLETED',
];


// ───────────────────────────────────────────────────────────────────────────
// Reading a loan
// ───────────────────────────────────────────────────────────────────────────

/**
 * One row of the live amortization schedule.
 *
 * The server returns raw Prisma rows, so every money column arrives as a STRING
 * (`Decimal(12,2)` serialises that way) and `dueDate` as an ISO timestamp.
 * `scheduleOf` converts the money columns to numbers here rather than making
 * thirteen spec files each remember to — a spec comparing `'600.00' === 600`
 * fails for a reason that has nothing to do with the loan.
 */
export interface ScheduleRow {
  installmentNo: number;
  dueDate: string;
  openingBalance: number;
  principalComponent: number;
  interestComponent: number;
  feeComponent: number;
  emiAmount: number;
  closingBalance: number;
  status: string;
  paidAmount: number;
}

/**
 * The payoff quote, exactly as `LoanLifecycleService.payoffQuote` builds it.
 *
 * `asOf` is `new Date()` on the server and arrives as an ISO string; typing it
 * as `string` is what it actually is on this side of the wire.
 */
export interface PayoffQuote {
  loanId: string;
  status: string;
  outstandingPrincipal: number;
  outstandingInterest: number;
  payoffAmount: number;
  asOf: string;
}

/** Decimal columns cross the wire as strings; this is the one place that admits it. */
function money(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The payoff quote, whichever envelope it arrives in.
 *
 * `payoffQuote` returns its own `{ success, data }` AND the global interceptor
 * wraps responses too, so the nesting is two deep here and one deep on most
 * other loan routes. Not something a spec should have to know.
 */
export async function quoteOf(api: ApiClient, id: string): Promise<PayoffQuote> {
  const raw = await api.get<unknown>(`/advance-loans/${id}/payoff-quote`).catch((e: Error) => {
    throw new Error(`GET /advance-loans/${id}/payoff-quote failed: ${e.message}`);
  });
  const q = inner<Record<string, unknown>>(raw);
  return {
    loanId: String(q?.loanId ?? id),
    status: String(q?.status ?? ''),
    outstandingPrincipal: money(q?.outstandingPrincipal),
    outstandingInterest: money(q?.outstandingInterest),
    payoffAmount: money(q?.payoffAmount),
    asOf: String(q?.asOf ?? ''),
  };
}

/**
 * The LIVE schedule only — superseded versions are retained in the database as
 * the regeneration audit trail but the route never returns them, so a spec
 * comparing row counts before and after a re-plan is comparing like with like.
 */
export async function scheduleOf(api: ApiClient, id: string): Promise<ScheduleRow[]> {
  const raw = await api.get<unknown>(`/advance-loans/${id}/schedule`).catch((e: Error) => {
    throw new Error(`GET /advance-loans/${id}/schedule failed: ${e.message}`);
  });
  return asList<Record<string, unknown>>(raw).map((r) => ({
    installmentNo: Number(r.installmentNo ?? 0),
    dueDate: String(r.dueDate ?? ''),
    openingBalance: money(r.openingBalance),
    principalComponent: money(r.principalComponent),
    interestComponent: money(r.interestComponent),
    feeComponent: money(r.feeComponent),
    emiAmount: money(r.emiAmount),
    closingBalance: money(r.closingBalance),
    status: String(r.status ?? ''),
    paidAmount: money(r.paidAmount),
  }));
}

/**
 * The loan record itself.
 *
 * Left as an open record rather than a narrow interface because the detail route
 * returns the whole `AdvanceLoanRequest` plus `employee`, `approver`,
 * `attachments`, `deductions` and a derived `outstandingBalance`, and every spec
 * wants a different corner of it. Money fields are STRINGS here (Decimal), which
 * is why `retire` compares `status` and nothing else.
 */
export async function loanOf(api: ApiClient, id: string): Promise<Record<string, unknown>> {
  return api.get<Record<string, unknown>>(`/advance-loans/${id}`).catch((e: Error) => {
    throw new Error(`GET /advance-loans/${id} failed: ${e.message}`);
  });
}

/**
 * The ledger rows payroll wrote against this loan.
 *
 * There is no `/advance-loans/:id/deductions` route — the array is an `include`
 * on the DETAIL route only (the list route deliberately drops it, because at
 * 100k loans x 12 instalments it is the dominant cost of the list page). So this
 * is a projection of `loanOf`, not a second call, and it is named separately
 * only so a spec reads as what it means.
 */
export async function deductionsFor(admin: ApiClient, loanId: string): Promise<unknown[]> {
  const loan = await loanOf(admin, loanId);
  const rows = loan.deductions;
  if (!Array.isArray(rows)) {
    throw new Error(
      `GET /advance-loans/${loanId} returned no \`deductions\` array — the detail ` +
        `include changed, and every deduction assertion in this suite is now blind.`,
    );
  }
  return rows;
}

// ───────────────────────────────────────────────────────────────────────────
// The allowance discipline
// ───────────────────────────────────────────────────────────────────────────

interface LoanBrief {
  id: string;
  status: string;
  reason?: string | null;
  employeeId?: string;
}

/**
 * Retires ONE loan.
 *
 * Two different exits, because the engine has two: a DRAFT/PENDING request is
 * CANCELLED by its owner (`DELETE /advance-loans/:id`), while a disbursed one
 * carries a balance and `close` refuses it outright ("Outstanding balance is
 * 600, above the rounding tolerance") — writing it off is the operation that
 * actually releases the allowance, and only a role in
 * `advance_loan_writeoff_roles` (default `ADMIN`) may do it.
 *
 * Both refusals are swallowed on purpose, and the one worth naming is
 * `assertNoRunInFlight`: while an UNLOCKED payroll holds a PENDING instalment
 * for this loan, nothing can be done to it — tidying up included. That clears
 * when the run that claimed it is locked or deleted, so the loan is LEFT for the
 * next run's `ensureAllowance` to collect rather than fought over. Throwing here
 * would fail a test in its teardown for something another spec did.
 */
export async function retire(loanId: string, owner: ApiClient, admin: ApiClient): Promise<void> {
  const loan = await owner.get<LoanBrief>(`/advance-loans/${loanId}`).catch(() => null);
  if (!loan || !OPEN_STATUSES.includes(loan.status)) return;

  if (loan.status === 'PENDING' || loan.status === 'DRAFT') {
    await owner.delete(`/advance-loans/${loanId}`).catch(() => undefined);
    return;
  }
  await admin
    .post(`/advance-loans/${loanId}/write-off`, { reason: `${loanId} — e2e journey finished` })
    .catch(() => undefined);
}

/**
 * Sweeps every OPEN loan whose reason carries `markerPrefix`, across all
 * employees.
 *
 * For `afterAll` in a file that borrowed several employees, and for the crashed
 * previous run whose loans nobody cancelled. Scoped to the marker and nothing
 * else: a blanket sweep would cancel the request a concurrently running spec is
 * halfway through approving, and the failure would land over there, in a file
 * that did nothing wrong.
 *
 * Filtering happens on THIS side because it has to. `GET /advance-loans?search=`
 * matches employee name, employee code and reference number — never `reason` —
 * so the marker is invisible to the server. `page`/`limit` are supplied to get
 * the paginated envelope; 200 is the server's maximum.
 */
export async function retireAllMarked(admin: ApiClient, markerPrefix: string): Promise<void> {
  if (!markerPrefix) {
    throw new Error('retireAllMarked needs a non-empty markerPrefix — a blank one sweeps everything');
  }

  const raw = await admin
    .get<unknown>('/advance-loans?page=1&limit=200')
    .catch((e: Error) => {
      throw new Error(`GET /advance-loans?page=1&limit=200 failed: ${e.message}`);
    });

  // The envelope is `{ data, meta, summary }` when paginated, and ApiClient has
  // already unwrapped the outer `{ success, data }` — so the rows are one more
  // level down. `asList` copes with both shapes so a server that drops
  // pagination does not silently sweep nothing.
  const rows = asList<LoanBrief>(raw);

  for (const loan of rows) {
    if (!OPEN_STATUSES.includes(loan.status)) continue;
    if (!(loan.reason ?? '').includes(markerPrefix)) continue;
    // Admin is both owner and approver here: cancelling somebody else's PENDING
    // request over `DELETE /advance-loans/:id` is refused, so an admin-only
    // sweep falls through to the write-off. Passing admin twice is what makes
    // that happen rather than a silent no-op.
    await retire(loan.id, admin, admin);
  }
}

/**
 * Makes room for one more loan, but only if there is none — and starting with
 * the caller's OWN leftovers.
 *
 * Gated on the server's own eligibility answer rather than run unconditionally:
 * on a freshly reset database there is nothing to sweep, and not sweeping is
 * what keeps concurrent Playwright projects off each other's records.
 *
 * The two passes are the point. The seeded employees are shared between spec
 * files running in different workers, so at the cap of two the allowance is
 * short precisely WHEN both files are busy. Sweeping everything the employee
 * owns — which is what a single pass does — then cancels the request the other
 * spec is halfway through approving. So: retire what THIS file left behind
 * first, re-ask the server, and only reach for anything else if that genuinely
 * was not enough.
 *
 * An eligibility call that itself fails is treated as "eligible": a 500 from the
 * what-if route is not evidence that the allowance is full, and sweeping on it
 * would destroy another spec's fixture for no reason.
 */
export async function ensureAllowance(
  owner: ApiClient,
  admin: ApiClient,
  amount: number,
  markerPrefix: string,
): Promise<void> {
  const eligible = async (): Promise<boolean> =>
    owner
      .post<{ eligible: boolean }>('/advance-loans/eligibility', {
        amount,
        installments: 6,
        type: 'LOAN',
      })
      .then((r) => r.eligible !== false)
      .catch(() => true);

  if (await eligible()) return;

  const mine = await owner.get<unknown>('/advance-loans/my-requests').catch(() => []);
  const open = asList<LoanBrief>(mine).filter((l) => OPEN_STATUSES.includes(l.status));

  // A blank prefix would make `ours` true for everything and collapse the two
  // passes into one — which is the behaviour we are trying to avoid, so it is
  // refused rather than silently accepted.
  if (!markerPrefix) {
    throw new Error('ensureAllowance needs a non-empty markerPrefix so it can sweep its own loans first');
  }
  const ours = (loan: LoanBrief): boolean => (loan.reason ?? '').includes(markerPrefix);

  for (const loan of open.filter(ours)) await retire(loan.id, owner, admin);
  if (await eligible()) return;

  for (const loan of open.filter((l) => !ours(l))) await retire(loan.id, owner, admin);
}

export interface LiveLoanOpts {
  type?: 'ADVANCE' | 'LOAN';
  amount: number;
  installments?: number;
  /**
   * Goes into the loan's `reason`, which is the ONLY field a sweep can identify
   * a test's own loans by. Put your marker in it.
   */
  note?: string;
  /**
   * The stable half of the marker, for the allowance sweep. Defaults to `note`,
   * which is right whenever `note` already starts with the marker. Additive to
   * the agreed signature: `ensureAllowance` cannot do its two-pass sweep without
   * one, and deriving it from a free-text note is guesswork.
   */
  markerPrefix?: string;
}

/**
 * Files a request and approves it, so a test starts from a live loan.
 *
 * Both steps go over the API on purpose: which screen files a request and which
 * screen approves it is `loans.admin-employee.spec.ts`'s subject, and re-driving
 * that here would make every case in every other file fail for somebody else's
 * reason.
 *
 * `installments` is meaningless for an ADVANCE — the server takes an advance
 * back in one go — so it is forced to 1 and omitted from the payload, matching
 * what the request form sends.
 */
export async function liveLoan(
  owner: ApiClient,
  admin: ApiClient,
  opts: LiveLoanOpts,
): Promise<string> {
  const type = opts.type ?? 'LOAN';
  const installments = type === 'LOAN' ? (opts.installments ?? 1) : 1;
  const note = opts.note ?? 'loan-support live loan';
  const prefix = opts.markerPrefix ?? note;

  await ensureAllowance(owner, admin, opts.amount, prefix);

  const created = await owner
    .post<{ id: string }>('/advance-loans', {
      type,
      amount: opts.amount,
      installments: type === 'LOAN' ? installments : undefined,
      reason: note,
    })
    .catch((e: Error) => {
      throw new Error(`POST /advance-loans failed: ${e.message}`);
    });

  try {
    await admin.post(`/advance-loans/${created.id}/approve`, {
      remarks: `${note} — approved for the journey`,
      installments: type === 'LOAN' ? installments : undefined,
    });
  } catch (e) {
    // A request the approver refused is still a request, and it still counts
    // against the allowance. The caller never learns the id — it only learns
    // that setup failed — so this is the only place that can take it back.
    await retire(created.id, owner, admin);
    throw new Error(`POST /advance-loans/${created.id}/approve failed: ${(e as Error).message}`);
  }
  return created.id;
}

// ───────────────────────────────────────────────────────────────────────────
// Re-exported from payroll-support.ts
// ───────────────────────────────────────────────────────────────────────────

/**
 * These helpers used to live in this file, because loan recovery only happens
 * *during* a payroll run and the loan suite was the first thing that needed to
 * drive one. They are not loan-specific — `makeEmployee`, `withSettings`,
 * `ensureBranch` and the six payroll functions describe the payroll world — and
 * the payroll edge-case suite needs every one of them, so they now live in
 * `payroll-support.ts`.
 *
 * They are re-exported here, unchanged, so that no loan spec's import list had
 * to change. A new spec should prefer importing them from `payroll-support.ts`
 * directly; importing them from here is not wrong, only indirect.
 *
 * The dependency runs one way: `payroll-support.ts` knows nothing about loans.
 */
export {
  marker,
  makeEmployee,
  terminateEmployee,
  flagFlipAllowed,
  withSetting,
  withSettings,
  branchIdByCode,
  ensureBranch,
  runPayroll,
  payrollItemFor,
  lockPayroll,
  unlockPayroll,
  deletePayroll,
  clearPayrolls,
} from './payroll-support';

export type { TestEmployee, PayrollRunOpts } from './payroll-support';
