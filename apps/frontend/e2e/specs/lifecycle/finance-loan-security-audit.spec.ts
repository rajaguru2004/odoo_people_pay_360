import { APIRequestContext, request } from '@playwright/test';
import { test, expect, settle, crashesOnly, ApiClient } from '../../fixtures';
import { API_URL } from '../../playwright.config';
import { selectBranch } from '../../pages';
import { LOAN_REPORT_TABS, LoanReportsPage } from '../../pages/loan-reports';
import {
  branchIdByCode,
  ensureAllowance,
  flagFlipAllowed,
  liveLoan,
  loanOf,
  makeEmployee,
  marker,
  retire,
  retireAllMarked,
  TestEmployee,
  withSetting,
} from '../../loan-support';

/**
 * Who may do what to a loan, and what the system remembers about it afterwards.
 *
 * Every other loan spec drives a JOURNEY and takes permission for granted: the
 * admin half runs as admin, the employee half runs as the employee, and the door
 * each of them walked through is never itself the subject. This file is only the
 * doors — all six controllers, every role, plus the caller with no token at all —
 * and then the second question nobody asks until an auditor does: when the money
 * moved, who did the system record as having moved it?
 *
 * ## The matrix is the backbone, and it is written from the decorators
 *
 * `ROUTES` below is a hand-copied transcription of every `@Roles(...)` in
 * `advance-loans.controller.ts`, `loan-lifecycle.controller.ts`,
 * `loan-reports.controller.ts`, `loan-settlement.controller.ts`,
 * `loan-import.controller.ts` and `advance-loan-attachments.controller.ts`. It is
 * an ORACLE, not a derivation: a route added without a row fails the count
 * assertion, and a decorator quietly widened fails its own cell.
 *
 * What a cell asserts is deliberately narrow. `RolesGuard` decides one thing —
 * whether the caller reaches the handler at all — so the matrix asserts exactly
 * that: a role outside the decorator gets **403**, and a role inside it gets
 * **anything except 401/403**. It does not assert 200, because every mutating
 * probe is aimed at a PHANTOM loan id that exists nowhere: the admitted caller
 * reaches the service and is told 404, and nothing in the database moves. A
 * matrix that had to succeed to prove admission would have to write to fifteen
 * real loans, and would then be a lifecycle test wearing a permission test's
 * clothes.
 *
 * Two kinds of cell deviate from the decorator, and both are recorded in the
 * table itself rather than hidden in an exception:
 *
 *   • `gated` — the route's decorator admits the role and a SETTINGS-DRIVEN check
 *     inside the service refuses it before it touches the loan.
 *     `advance_loan_writeoff_roles` (default and pinned `'ADMIN'`) does this to
 *     HR on write-off and reinstate; `advance_loan_approver_roles`
 *     (`'ADMIN,HR_MANAGER'`) does it to a MANAGER on `/pending`. These are the
 *     cells a decorator-only reading of the code gets wrong in the dangerous
 *     direction — it reports HR as permitted to forgive company money.
 *   • The service gates that need a REAL loan to be reached (approve/reject stop
 *     at the 404 first) are asserted further down, against a real one.
 *
 * ## What is asserted elsewhere, and is therefore not asserted here
 *
 *   • `finance-loan-lifecycle.spec.ts` owns the HR write-off gate as a screen —
 *     the button that is not offered, and the direct API call that is refused.
 *     This file never re-asserts the refusal on its own; it asserts the thing
 *     that file cannot, which is that the SETTING is what decides. Flipping
 *     `advance_loan_writeoff_roles` to include HR and watching the same call
 *     succeed, then restoring it and watching it fail again, is the only
 *     evidence that the gate is configuration rather than a coincidence.
 *   • `finance-loan-reports.spec.ts` owns the F27 regression on
 *     `/dashboard/advance-loans/reports` — the permission-denied modal, the
 *     `loan-report-failed` panel and the absent `loan-report-empty`. The browser
 *     case here re-checks that triad only as the PRECONDITION of a stronger
 *     claim: that a refused report leaks no rows, offers no export, and hands
 *     the reader nothing they were not allowed to see.
 *
 * ## Audit (§22), and the one thing that cannot be tested
 *
 * `GET /audit-logs` exists and is `@Roles('ADMIN')`, so audit rows ARE readable
 * over the API and every claim below is made against the real trail rather than
 * against a mock. Two facts about it shape the assertions:
 *
 *   • Every loan-side action — the twelve written by the services themselves
 *     and the CRUD rows written by the `@AuditResource` interceptor — files
 *     under ONE `resourceType`, `'AdvanceLoan'`. The services used to write
 *     `'AdvanceLoanRequest'` instead, so one resource had two names and neither
 *     query found the other's rows. A settlement additionally keeps its own
 *     `'LoanSettlement'` row, because a settlement genuinely is a second
 *     resource — that is what a reversal targets.
 *   • Attachment uploads and deletes are audited too. They were the one pair of
 *     WRITES in this module leaving no trail at all.
 *
 * ## Subjects, and why they are imported rather than filed
 *
 * A loan can only be FILED by the employee it belongs to (`POST /advance-loans`
 * reads `user.employeeId`), and an employee created over the API can never log
 * in (see `makeEmployee`'s `NO_LOGIN`). So the out-of-department and
 * out-of-branch subjects this file needs — employees nobody can sign in as —
 * get their loans through `POST /advance-loans/import/confirm`, which takes rows
 * naming an employee CODE and creates the loan for them. Same table, same
 * scoping, no session required.
 *
 * Every loan created here carries `pw-loansec-` in its reason, is tracked by id,
 * and is retired in `afterAll`.
 */

test.describe.configure({ mode: 'serial' });

const isProject = (name: string): boolean => test.info().project.name === name;

/** The stable half of the marker — what identifies a record as THIS file's. */
const PREFIX = 'pw-loansec-';
/** Distinct per run, so a leftover can be dated as well as owned. */
const MARK = marker(PREFIX);

/**
 * Well-formed and owned by nothing.
 *
 * Version nibble `4` and variant `8` so `ParseUUIDPipe` (which defaults to
 * versions 3/4/5) accepts it and the probe reaches the service — the point of
 * the matrix is the guard's answer, and a 400 from the pipe would hide it.
 */
const PHANTOM_LOAN = '00000000-0000-4000-8000-000000000000';
const PHANTOM_EMPLOYEE = '00000000-0000-4000-8000-000000000001';

// ───────────────────────────────────────────────────────────────────────────
// The role × route matrix
// ───────────────────────────────────────────────────────────────────────────

type Who = 'admin' | 'hr' | 'manager' | 'employee';

const EVERY_ROLE: Who[] = ['admin', 'hr', 'manager', 'employee'];
const ADMIN_HR: Who[] = ['admin', 'hr'];

interface Route {
  /** Method and path, as it reads in the controller. */
  id: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  /** Exactly the roles named by the route's `@Roles(...)` decorator. */
  decorator: Who[];
  /** Admitted by the decorator, refused by a settings-driven check in the service. */
  gated?: Who[];
  /** Why this row is not simply its decorator. */
  note?: string;
}

/**
 * Bodies are chosen so that an ADMITTED caller fails for a HARMLESS reason —
 * a phantom id (404), an empty row set (400), a deliberately invalid payload
 * (400) — while a REFUSED caller is stopped by the guard before any of that.
 * Nothing in this table mutates a real loan.
 */
const ROUTES: Route[] = [
  // ── advance-loans.controller.ts ────────────────────────────────────────
  {
    id: 'POST /advance-loans',
    method: 'POST',
    // Deliberately invalid: an ADMITTED role must not actually file a request
    // (three roles filing on every run would exhaust the per-employee
    // allowance every other loan spec depends on), so the payload fails
    // validation at 400 — which happens AFTER the guard has had its say.
    path: '/advance-loans',
    body: { type: 'NOT_A_TYPE', amount: -1 },
    decorator: ['hr', 'manager', 'employee'],
    note: 'ADMIN is excluded on purpose — admins administer the queue, they do not file into it',
  },
  {
    id: 'GET /advance-loans',
    method: 'GET',
    path: '/advance-loans?limit=1',
    decorator: ADMIN_HR,
  },
  {
    id: 'POST /advance-loans/eligibility',
    method: 'POST',
    path: '/advance-loans/eligibility',
    body: { amount: 100, installments: 1, type: 'LOAN' },
    decorator: EVERY_ROLE,
    note: 'persists nothing, which is why it is safe to drive as every role',
  },
  {
    id: 'GET /advance-loans/pending',
    method: 'GET',
    path: '/advance-loans/pending',
    decorator: ['admin', 'hr', 'manager'],
    gated: ['manager'],
    note: 'advance_loan_approver_roles is pinned ADMIN,HR_MANAGER — the service refuses a MANAGER the decorator admits',
  },
  {
    id: 'GET /advance-loans/my-requests',
    method: 'GET',
    path: '/advance-loans/my-requests',
    decorator: EVERY_ROLE,
  },
  {
    id: 'GET /advance-loans/:id',
    method: 'GET',
    path: `/advance-loans/${PHANTOM_LOAN}`,
    decorator: EVERY_ROLE,
    note: 'ownership is a per-object check inside the service, not a role check',
  },
  {
    id: 'POST /advance-loans/:id/approve',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/approve`,
    body: { remarks: `${MARK} matrix probe` },
    decorator: ['admin', 'hr', 'manager'],
    note: 'the MANAGER approver gate needs a real loan to be reached — asserted separately',
  },
  {
    id: 'POST /advance-loans/:id/reject',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/reject`,
    body: { remarks: `${MARK} matrix probe` },
    decorator: ['admin', 'hr', 'manager'],
  },
  {
    id: 'DELETE /advance-loans/:id',
    method: 'DELETE',
    path: `/advance-loans/${PHANTOM_LOAN}`,
    decorator: EVERY_ROLE,
  },

  // ── loan-lifecycle.controller.ts (12 routes) ──────────────────────────
  {
    id: 'GET /advance-loans/:id/schedule',
    method: 'GET',
    path: `/advance-loans/${PHANTOM_LOAN}/schedule`,
    decorator: EVERY_ROLE,
  },
  {
    id: 'GET /advance-loans/:id/payoff-quote',
    method: 'GET',
    path: `/advance-loans/${PHANTOM_LOAN}/payoff-quote`,
    decorator: EVERY_ROLE,
  },
  {
    id: 'POST /advance-loans/:id/prepay',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/prepay`,
    body: { amount: 10 },
    // EMPLOYEE joined the decorator when `loan_employee_self_prepay` gained a
    // reader: a borrower who pays at the counter can record it themselves. The
    // narrowing moved INTO the service — the switch must be on and it must be
    // their own loan — so the decorator is deliberately wider than the rule.
    // MANAGER is still outside it: a manager is not a party to the debt.
    decorator: [...ADMIN_HR, 'employee'],
  },
  {
    id: 'POST /advance-loans/:id/foreclose',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/foreclose`,
    body: { reason: `${MARK} matrix probe` },
    decorator: ADMIN_HR,
  },
  {
    id: 'POST /advance-loans/:id/close',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/close`,
    body: { reason: `${MARK} matrix probe` },
    decorator: ADMIN_HR,
  },
  {
    id: 'POST /advance-loans/:id/write-off',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/write-off`,
    // >= 10 characters, or validation refuses it before the role gate is
    // reached and the cell would prove nothing.
    body: { reason: `${MARK} matrix probe for the write-off gate` },
    decorator: ADMIN_HR,
    gated: ['hr'],
    note: 'advance_loan_writeoff_roles is pinned ADMIN — the service refuses HR first thing',
  },
  {
    id: 'POST /advance-loans/:id/reinstate',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/reinstate`,
    body: { reason: `${MARK} matrix probe` },
    decorator: ADMIN_HR,
    gated: ['hr'],
    note: 'reinstate undoes a write-off, so it is gated by the same setting',
  },
  {
    id: 'POST /advance-loans/:id/waive',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/waive`,
    body: { reason: `${MARK} matrix probe` },
    decorator: ADMIN_HR,
    note: 'loan_waiver_roles is pinned ADMIN,HR_MANAGER, so HR passes the second gate too',
  },
  {
    id: 'POST /advance-loans/:id/hold',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/hold`,
    body: { reason: `${MARK} matrix probe` },
    decorator: ADMIN_HR,
  },
  {
    id: 'POST /advance-loans/:id/resume',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/resume`,
    body: { reason: `${MARK} matrix probe` },
    decorator: ADMIN_HR,
  },
  {
    id: 'POST /advance-loans/:id/skip-installment',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/skip-installment`,
    body: { installmentNo: 1, reason: `${MARK} matrix probe` },
    decorator: ADMIN_HR,
  },
  {
    id: 'POST /advance-loans/:id/convert',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/convert`,
    body: { installments: 2, reason: `${MARK} matrix probe` },
    decorator: ADMIN_HR,
  },

  // ── loan-reports.controller.ts (7 routes) ─────────────────────────────
  {
    id: 'GET /advance-loans/reports/outstanding',
    method: 'GET',
    path: '/advance-loans/reports/outstanding?limit=1',
    decorator: ADMIN_HR,
  },
  {
    id: 'GET /advance-loans/reports/portfolio',
    method: 'GET',
    path: '/advance-loans/reports/portfolio',
    decorator: ADMIN_HR,
  },
  {
    id: 'GET /advance-loans/reports/emi-due',
    method: 'GET',
    path: '/advance-loans/reports/emi-due',
    decorator: ADMIN_HR,
  },
  {
    id: 'GET /advance-loans/reports/overdue',
    method: 'GET',
    path: '/advance-loans/reports/overdue',
    decorator: ADMIN_HR,
  },
  {
    id: 'GET /advance-loans/reports/interest-earned',
    method: 'GET',
    path: '/advance-loans/reports/interest-earned',
    decorator: ADMIN_HR,
  },
  {
    id: 'GET /advance-loans/reports/my-statement',
    method: 'GET',
    path: '/advance-loans/reports/my-statement',
    decorator: EVERY_ROLE,
    note: 'takes the employee from the token — no id parameter, so no direct-object-reference surface',
  },
  {
    id: 'GET /advance-loans/reports/employee/:employeeId/statement',
    method: 'GET',
    path: `/advance-loans/reports/employee/${PHANTOM_EMPLOYEE}/statement`,
    decorator: ADMIN_HR,
  },

  // ── loan-settlement.controller.ts (4 routes) ──────────────────────────
  {
    id: 'GET /advance-loans/settlement/receivable',
    method: 'GET',
    path: '/advance-loans/settlement/receivable',
    decorator: ADMIN_HR,
  },
  {
    id: 'GET /advance-loans/settlement/:employeeId',
    method: 'GET',
    path: `/advance-loans/settlement/${PHANTOM_EMPLOYEE}`,
    decorator: ADMIN_HR,
  },
  {
    id: 'POST /advance-loans/settlement/:employeeId',
    method: 'POST',
    path: `/advance-loans/settlement/${PHANTOM_EMPLOYEE}`,
    body: { decisions: [{ loanId: PHANTOM_LOAN, action: 'WAIVE' }] },
    decorator: ADMIN_HR,
  },
  {
    id: 'POST /advance-loans/settlement/:settlementId/reverse',
    method: 'POST',
    path: `/advance-loans/settlement/${PHANTOM_LOAN}/reverse`,
    body: { reason: `${MARK} matrix probe` },
    decorator: ['admin'],
    note: 'the only loan route ADMIN holds alone — a reversal restores every loan from a snapshot',
  },

  // ── loan-import.controller.ts (3 routes) ──────────────────────────────
  {
    id: 'GET /advance-loans/import/template',
    method: 'GET',
    path: '/advance-loans/import/template',
    decorator: ADMIN_HR,
  },
  {
    id: 'POST /advance-loans/import/preview',
    method: 'POST',
    path: '/advance-loans/import/preview',
    body: {},
    decorator: ADMIN_HR,
    note: 'multipart in real use; a JSON body reaches the handler and is refused for having no file',
  },
  {
    id: 'POST /advance-loans/import/confirm',
    method: 'POST',
    path: '/advance-loans/import/confirm',
    body: { rows: [] },
    decorator: ADMIN_HR,
    note: 'an empty row set is refused by the handler, so an admitted role creates nothing',
  },

  // ── advance-loan-attachments.controller.ts (3 routes) ─────────────────
  {
    id: 'GET /advance-loans/:requestId/attachments',
    method: 'GET',
    path: `/advance-loans/${PHANTOM_LOAN}/attachments`,
    decorator: EVERY_ROLE,
    note: 'the horizontal check is LoanAccessService.assertCanViewLoan, not the decorator',
  },
  {
    id: 'POST /advance-loans/:requestId/attachments',
    method: 'POST',
    path: `/advance-loans/${PHANTOM_LOAN}/attachments`,
    body: {},
    decorator: EVERY_ROLE,
  },
  {
    id: 'DELETE /advance-loans/:requestId/attachments/:id',
    method: 'DELETE',
    path: `/advance-loans/${PHANTOM_LOAN}/attachments/${PHANTOM_LOAN}`,
    decorator: EVERY_ROLE,
  },
];

/** Every route in the six controllers. A new one without a row fails this. */
const ROUTE_COUNT = 38;

/** What the guard must answer for this role on this route. */
type Verdict = 'forbidden' | 'admitted';

function verdictFor(route: Route, who: Who): Verdict {
  if (!route.decorator.includes(who)) return 'forbidden';
  return (route.gated ?? []).includes(who) ? 'forbidden' : 'admitted';
}

/**
 * A raw status code, without the `ApiClient` envelope.
 *
 * `ApiClient` throws on a non-2xx and JSON-parses on a 2xx, and the matrix wants
 * neither: the import template answers with a binary workbook, which `unwrap`
 * would fail to parse, and a 404 is a RESULT here rather than an error.
 */
async function statusOf(
  ctx: APIRequestContext,
  token: string | null,
  route: Pick<Route, 'method' | 'path' | 'body'>,
  contentType = 'application/json',
): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await ctx.fetch(route.path, {
    method: route.method,
    headers,
    ...(route.body === undefined ? {} : { data: route.body }),
  });
  return res.status();
}

// ───────────────────────────────────────────────────────────────────────────
// Audit
// ───────────────────────────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  userId: string | null;
  createdAt: string;
  user?: { id?: string; email?: string; role?: string } | null;
}

/**
 * The actor's own user id, taken from the token the client is holding.
 *
 * `AuditLog.userId` is the USER id, and no endpoint hands one back for the
 * caller — but `AuthService.generateToken` puts it in the JWT as `sub`, so the
 * client already has it. Decoded rather than looked up so the assertion does not
 * depend on a second endpoint's role gate.
 */
function actorIdOf(api: ApiClient): string {
  const payload = api.token.split('.')[1] ?? '';
  const json = Buffer.from(payload, 'base64').toString('utf8');
  const sub = (JSON.parse(json) as { sub?: string }).sub;
  if (!sub) throw new Error('The access token carries no `sub` — cannot name the actor');
  return sub;
}

/**
 * Audit rows for one action against one resource.
 *
 * `search` is how `QueryAuditLogsDto` reaches `resourceId`: the service only ORs
 * it in when the term is a UUID, which is exactly the case here. `action` and
 * `resourceType` are ANDed on top, so the answer is this action against this
 * loan and nothing else.
 */
async function auditRows(
  admin: ApiClient,
  where: { action: string; resourceType: string; resourceId: string },
): Promise<AuditRow[]> {
  const qs = new URLSearchParams({
    limit: '200',
    action: where.action,
    resourceType: where.resourceType,
    search: where.resourceId,
  });
  const raw = await admin.get<unknown>(`/audit-logs?${qs.toString()}`).catch(() => []);
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { data?: unknown }).data as unknown[] | undefined) ?? [];
  return list as AuditRow[];
}

/** Poll until the row exists, then assert it names the actor, the loan and the time. */
async function expectAuditRow(
  admin: ApiClient,
  where: { action: string; resourceType: string; resourceId: string },
  actorId: string,
  notBefore: number,
): Promise<void> {
  // Polled because the interceptor writes its row WITHOUT awaiting it (`void
  // this.auditService.log(...)`), so the response can beat the row to the table
  // by a few milliseconds. Reading once here is the classic flake.
  await expect
    .poll(async () => (await auditRows(admin, where)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);

  const rows = await auditRows(admin, where);
  const row = rows[0];
  expect(row.resourceId, `${where.action} was audited against the wrong resource`).toBe(
    where.resourceId,
  );
  expect(row.userId, `${where.action} does not name who did it`).toBe(actorId);
  const at = Date.parse(row.createdAt);
  expect(Number.isNaN(at), `${where.action} has no readable timestamp`).toBe(false);
  // Within this test's own window: a row left by an earlier run against the same
  // id would otherwise satisfy the poll and prove nothing about this action.
  expect(at, `${where.action} was audited before the operation happened`).toBeGreaterThanOrEqual(
    notBefore - 2_000,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Subjects
// ───────────────────────────────────────────────────────────────────────────

interface ImportedLoan {
  id: string;
  referenceNo: string;
}

let importSeq = 0;

/**
 * Creates a live loan for an employee NOBODY CAN LOG IN AS.
 *
 * `POST /advance-loans` files on behalf of the token's own employee and there is
 * no on-behalf-of variant, so an employee created over the API — the only way to
 * get one in a chosen department or branch — could otherwise never own a loan.
 * The importer can: its rows name an employee CODE, it bypasses approval
 * ("they were approved elsewhere"), and `notes` lands in the loan's `reason`,
 * which is where this file's marker has to be for a sweep to find it.
 */
async function importLoanFor(
  admin: ApiClient,
  code: string,
  opts: { principal: number; installments: number; fullyPaid?: boolean; note: string },
): Promise<ImportedLoan> {
  const referenceNo = `${MARK}-${++importSeq}`;
  const paid = opts.fullyPaid ? opts.installments : 0;
  const body = {
    rows: [
      {
        employeeCode: code,
        referenceNo,
        type: 'LOAN',
        principal: opts.principal,
        interestMethod: 'NONE',
        interestRate: 0,
        installments: opts.installments,
        emi: null,
        disbursedOn: '2025-01-15',
        firstDeductionPeriod: '2025-02',
        installmentsPaid: paid,
        amountRepaid: opts.fullyPaid ? opts.principal : 0,
        status: 'ACTIVE',
        notes: `${MARK} — ${opts.note}`,
      },
    ],
  };

  const res = await admin.post<{
    results?: Array<{ success: boolean; loanId?: string; error?: string }>;
  }>('/advance-loans/import/confirm', body);
  const first = res?.results?.[0];
  if (!first?.success || !first.loanId) {
    throw new Error(`Import failed for ${code}: ${first?.error ?? 'no result row'}`);
  }
  return { id: first.loanId, referenceNo };
}

/** A department id from its code, so a subject can be placed inside or outside a scope. */
async function departmentIdByCode(admin: ApiClient, code: string): Promise<string> {
  const raw = await admin.get<unknown>('/departments');
  const list = (
    Array.isArray(raw) ? raw : ((raw as { data?: unknown }).data as unknown[] | undefined) ?? []
  ) as Array<{ id: string; code: string }>;
  const hit = list.find((d) => d.code === code);
  if (!hit) {
    throw new Error(
      `No department with code "${code}" (saw: ${list.map((d) => d.code).join(', ') || 'none'})`,
    );
  }
  return hit.id;
}

/** Every id this file created, retired in afterAll whatever happened. */
const created: Array<{ id: string; owner: ApiClient | null }> = [];

// ───────────────────────────────────────────────────────────────────────────
// 1. The matrix
// ───────────────────────────────────────────────────────────────────────────

test.describe('every loan route answers the role matrix its decorator promises', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens for an API-only file.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'a pure-API sweep — one project drives it for all four roles');
  });

  const clients: Partial<Record<Who, ApiClient>> = {};
  let http: APIRequestContext;
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      for (const who of EVERY_ROLE) clients[who] = await ApiClient.as(who);
      // One raw context, used with a bearer for the four roles and without one
      // for the unauthenticated sweep. It stores no credentials of its own.
      http = await request.newContext({ baseURL: API_URL });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    for (const who of EVERY_ROLE) await clients[who]?.dispose();
    await http?.dispose();
  });

  test('the table covers every route in all six controllers', async () => {
    // The count is the tripwire. A route added to any of the six controllers
    // without a row here would otherwise be silently untested, which is the
    // failure mode a hand-written oracle exists to prevent.
    expect(ROUTES.length, 'a loan route was added or removed without updating this table').toBe(
      ROUTE_COUNT,
    );
    expect(new Set(ROUTES.map((r) => r.id)).size, 'two rows describe the same route').toBe(
      ROUTES.length,
    );
  });

  test('a role outside the decorator is refused, and a role inside it reaches the service', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const mismatches: string[] = [];

    for (const route of ROUTES) {
      for (const who of EVERY_ROLE) {
        const want = verdictFor(route, who);
        const got = await statusOf(http, clients[who]!.token, route);

        if (want === 'forbidden' && got !== 403) {
          mismatches.push(
            `${route.id} as ${who}: expected 403 (${route.note ?? 'not in the decorator'}), got ${got}`,
          );
        }
        if (want === 'admitted' && (got === 401 || got === 403)) {
          mismatches.push(
            `${route.id} as ${who}: the decorator admits this role, but the server answered ${got}`,
          );
        }
      }
    }

    // Reported as one list rather than failing on the first cell: a widened
    // decorator usually widens several routes at once, and seeing them together
    // is the difference between "one odd case" and "the guard is off".
    expect(mismatches.join('\n'), 'the loan role matrix does not match the decorators').toBe('');
  });

  test('no loan route answers a caller with no token at all', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const answered: string[] = [];
    for (const route of ROUTES) {
      const got = await statusOf(http, null, route);
      if (got !== 401) answered.push(`${route.id}: expected 401 without a token, got ${got}`);
    }

    expect(answered.join('\n'), 'a loan route served an unauthenticated caller').toBe('');
  });

  test('a malformed, forged or truncated bearer is refused exactly like no bearer', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const real = clients.admin!.token;
    const [header, payload] = real.split('.');
    const tokens: Array<{ name: string; value: string }> = [
      { name: 'not a JWT at all', value: 'garbage' },
      { name: 'two segments instead of three', value: `${header}.${payload}` },
      // The admin's own header and payload with somebody else's signature: the
      // case that matters, because everything except the signature verifies.
      { name: 'a forged signature over a real payload', value: `${header}.${payload}.aaaaaaaa` },
      { name: 'an empty bearer', value: '' },
    ];

    // Three routes rather than all thirty-eight: `JwtAuthGuard` is applied at the
    // controller, so one route per controller family proves the same thing at a
    // fraction of the wall clock.
    const sample = ROUTES.filter((r) =>
      ['GET /advance-loans', 'GET /advance-loans/reports/portfolio', 'GET /advance-loans/my-requests'].includes(
        r.id,
      ),
    );
    expect(sample.length, 'the token sample lost a route').toBe(3);

    const accepted: string[] = [];
    for (const token of tokens) {
      for (const route of sample) {
        const got = await statusOf(http, token.value, route);
        if (got !== 401) accepted.push(`${route.id} with ${token.name}: got ${got}, expected 401`);
      }
    }

    expect(accepted.join('\n'), 'a bad token was treated as a session').toBe('');
  });

  test('the settings that decide loan permissions are readable by three roles and writable by one', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // Worth a row of its own: every settings-driven gate below
    // (`advance_loan_writeoff_roles`, `loan_waiver_roles`,
    // `advance_loan_finance_roles`, `advance_loan_auditor_roles`) is only as
    // strong as the door on the endpoint that edits it.
    const read = { method: 'GET' as const, path: '/system-settings' };
    const write = {
      method: 'POST' as const,
      path: '/system-settings',
      // Empty on purpose: an admitted caller must not actually change anything.
      body: { settings: {} },
    };

    const readable: Who[] = ['admin', 'hr', 'manager'];
    for (const who of EVERY_ROLE) {
      const got = await statusOf(http, clients[who]!.token, read);
      if (readable.includes(who)) {
        expect(got, `${who} cannot read the settings that gate their own loan permissions`).not.toBe(
          403,
        );
      } else {
        expect(got, `${who} can read the system settings`).toBe(403);
      }
    }

    for (const who of EVERY_ROLE) {
      const got = await statusOf(http, clients[who]!.token, write);
      if (who === 'admin') {
        expect(got, 'an ADMIN cannot write the system settings').not.toBe(403);
      } else {
        expect(got, `${who} can rewrite the settings that gate write-off and waiver`).toBe(403);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Ownership
// ───────────────────────────────────────────────────────────────────────────

test.describe('a loan belongs to one employee, and the rest of the company is not it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'a pure-API sweep — one project drives it for all four roles');
  });

  let adminApi: ApiClient;
  let employeeApi: ApiClient;
  let managerApi: ApiClient;
  /** Filed by the MANAGER account, so it is somebody else's from the employee's side. */
  let foreignLoanId = '';
  /** Filed by the EMPLOYEE account — the one they are entitled to. */
  let ownLoanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      employeeApi = await ApiClient.as('employee');
      managerApi = await ApiClient.as('manager');

      foreignLoanId = await liveLoan(managerApi, adminApi, {
        amount: 600,
        installments: 6,
        note: `${MARK} — a loan the employee does not own`,
        markerPrefix: PREFIX,
      });
      created.push({ id: foreignLoanId, owner: managerApi });

      ownLoanId = await liveLoan(employeeApi, adminApi, {
        amount: 400,
        installments: 4,
        note: `${MARK} — the employee's own loan`,
        markerPrefix: PREFIX,
      });
      created.push({ id: ownLoanId, owner: employeeApi });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
    await employeeApi?.dispose();
    await managerApi?.dispose();
  });

  test("an employee reading a colleague's loan by id is refused, and told why", async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    await expect(
      employeeApi.get(`/advance-loans/${foreignLoanId}`),
      'an employee read a loan belonging to somebody else',
    ).rejects.toThrow(/403/);

    // Their own is unaffected — a denial that also broke the entitled path would
    // pass a one-sided assertion while making the feature useless.
    const own = await loanOf(employeeApi, ownLoanId);
    expect(own.id, 'the employee cannot read their own loan').toBe(ownLoanId);
  });

  test('the all-requests list is refused to an employee outright, and my-requests holds only their own', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // Not "filtered to their own" — refused. The list route is the loan BOOK,
    // and a filtered book would still tell an employee how many loans exist.
    await expect(
      employeeApi.get('/advance-loans?limit=200'),
      'an employee reached the company-wide loan list',
    ).rejects.toThrow(/403/);

    const mine = await employeeApi.get<unknown>('/advance-loans/my-requests');
    const rows = (
      Array.isArray(mine) ? mine : ((mine as { data?: unknown }).data as unknown[] | undefined) ?? []
    ) as Array<{ id: string }>;

    expect(
      rows.map((r) => r.id),
      "my-requests carried a loan the caller does not own",
    ).not.toContain(foreignLoanId);
    expect(rows.map((r) => r.id), 'my-requests dropped the caller’s own loan').toContain(ownLoanId);
  });

  test("the schedule, the payoff quote and the attachments of a colleague's loan are refused too", async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // The three routes that used to have their own opinion. Attachments in
    // particular simply did not repeat the predicate, so any authenticated
    // employee holding a loan id could list a colleague's filenames — which is
    // why `LoanAccessService` exists and why all three are asserted together.
    await expect(
      employeeApi.get(`/advance-loans/${foreignLoanId}/schedule`),
      "an employee read a colleague's amortization schedule",
    ).rejects.toThrow(/403/);

    await expect(
      employeeApi.get(`/advance-loans/${foreignLoanId}/payoff-quote`),
      "an employee read a colleague's payoff figure",
    ).rejects.toThrow(/403/);

    await expect(
      employeeApi.get(`/advance-loans/${foreignLoanId}/attachments`),
      "an employee listed a colleague's loan attachments",
    ).rejects.toThrow(/403/);
  });

  test('cancelling is the owner’s alone', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // The route admits every role, so the ownership check is entirely inside the
    // service — exactly the shape of check that gets lost in a refactor.
    await expect(
      employeeApi.delete(`/advance-loans/${foreignLoanId}`),
      "an employee cancelled a colleague's loan",
    ).rejects.toThrow();

    const after = await loanOf(adminApi, foreignLoanId);
    expect(after.status, 'the refused cancellation still changed the loan').not.toBe('CANCELLED');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Manager department scope
// ───────────────────────────────────────────────────────────────────────────

test.describe('a manager’s authority stops at the edge of their department', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'a pure-API sweep — one project drives it for all four roles');
  });

  let adminApi: ApiClient;
  let managerApi: ApiClient;
  let inside: TestEmployee | null = null;
  let outside: TestEmployee | null = null;
  let insideLoanId = '';
  let outsideLoanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      managerApi = await ApiClient.as('manager');

      // `manager@company.com` heads HRD in the baseline seed — that headship, not
      // the role string, is what `managedDepartmentIds` resolves to.
      const hrd = await departmentIdByCode(adminApi, 'HRD');
      const ops = await departmentIdByCode(adminApi, 'E2E-OPS');
      expect(hrd, 'the two departments must differ or the test proves nothing').not.toBe(ops);

      inside = await makeEmployee(adminApi, { marker: `${MARK}in`, departmentId: hrd });
      outside = await makeEmployee(adminApi, { marker: `${MARK}out`, departmentId: ops });

      const a = await importLoanFor(adminApi, inside.code, {
        principal: 600,
        installments: 6,
        note: 'inside the manager’s department',
      });
      insideLoanId = a.id;
      created.push({ id: insideLoanId, owner: null });

      const b = await importLoanFor(adminApi, outside.code, {
        principal: 600,
        installments: 6,
        note: 'outside the manager’s department',
      });
      outsideLoanId = b.id;
      created.push({ id: outsideLoanId, owner: null });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await inside?.dispose();
    await outside?.dispose();
    await adminApi?.dispose();
    await managerApi?.dispose();
  });

  test('a manager reads the loan of someone they manage and is refused one they do not', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const seen = await loanOf(managerApi, insideLoanId);
    expect(seen.id, 'a manager could not read a loan in their own department').toBe(insideLoanId);

    await expect(
      managerApi.get(`/advance-loans/${outsideLoanId}`),
      'a manager read a loan from a department they do not head',
    ).rejects.toThrow(/403/);
  });

  test('the manager’s pending queue is refused entirely while the approver setting excludes them', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // The decorator admits MANAGER; `advance_loan_approver_roles` is pinned to
    // `'ADMIN,HR_MANAGER'`, and the service refuses on that. Asserted with the
    // server's own sentence so a 403 raised for some other reason cannot pass.
    await expect(
      managerApi.get('/advance-loans/pending'),
      'a MANAGER reached the approval queue the settings exclude them from',
    ).rejects.toThrow(/403/);
  });

  test('with MANAGER in the approver roles, they may decide inside their department and nowhere else', async () => {
    test.skip(
      !flagFlipAllowed(),
      'flips advance_loan_approver_roles, which is environment-wide; run with E2E_ALLOW_FLAG_FLIP=1',
    );
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // BOTH halves need a PENDING request, and that is the whole difficulty.
    //
    // `decide()` refuses a non-PENDING request FIRST — `Cannot decide a request
    // that is already active`, a 400 — and only then reaches `assertApprover`,
    // where the 403 this test is about lives. `outsideLoanId` is an IMPORTED
    // loan: `POST /advance-loans/import/confirm` writes rows that are already
    // ACTIVE ("they were approved elsewhere"), and its status column admits only
    // ACTIVE/CLOSED/ON_HOLD. Pointing the out-of-department attempt at it
    // therefore bought a refusal from the status guard and never exercised the
    // department gate at all — the assertion could not have failed however wide
    // open the scope check was.
    //
    // So the out-of-department half gets its own PENDING request, and it has to
    // be FILED, which means an account that can log in: `POST /advance-loans`
    // files on behalf of the token's own employee and there is no on-behalf-of
    // variant. `manager2@company.com` is the one seeded login sitting in a
    // department this manager does not head (E2E-OPS, which it heads itself),
    // which is exactly what makes it the subject here.
    const employeeApi = await ApiClient.as('employee');
    const opsApi = await ApiClient.asAccount('manager2@company.com', 'Password123!');
    let pendingId = '';
    let outsidePendingId = '';
    try {
      // `loan_max_active_per_employee` is 2 and this file already holds one of
      // the employee's slots, so the allowance is made before filing rather
      // than discovered as a 400 halfway through the flip.
      await ensureAllowance(employeeApi, adminApi, 300, PREFIX);
      const filed = await employeeApi.post<{ id: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 300,
        installments: 3,
        reason: `${MARK} — filed for the manager approver flip`,
      });
      pendingId = filed.id;
      created.push({ id: pendingId, owner: employeeApi });

      await ensureAllowance(opsApi, adminApi, 300, PREFIX);
      const filedOutside = await opsApi.post<{ id: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 300,
        installments: 3,
        reason: `${MARK} — filed outside the manager's department`,
      });
      outsidePendingId = filedOutside.id;
      created.push({ id: outsidePendingId, owner: opsApi });

      // The premise of the second half, asserted rather than assumed: if this
      // request were not PENDING the 403 below would be unreachable and the
      // 400 from the status guard would be mistaken for a scope refusal.
      expect(
        (await loanOf(adminApi, outsidePendingId)).status,
        'the out-of-department request must be PENDING for the scope gate to be reached',
      ).toBe('PENDING');

      await withSetting(
        adminApi,
        'advance_loan_approver_roles',
        'ADMIN,HR_MANAGER,MANAGER',
        async () => {
          // In scope: employee1 is in HRD, which this manager heads.
          await managerApi.post(`/advance-loans/${pendingId}/approve`, {
            remarks: `${MARK} approved inside the department`,
            installments: 3,
          });
          const after = await loanOf(adminApi, pendingId);
          expect(after.status, 'the in-department approval did not take').toBe('APPROVED');

          // Out of scope: the same role, the same setting, the same PENDING
          // starting point — only the employee's department differs. The
          // refusal must now come from the DEPARTMENT check rather than from
          // the role list or the status guard, so the code and the server's own
          // sentence are asserted together — one call, one regex. A bare /403/
          // is what let the previous version of this case pass while never
          // reaching the gate at all.
          await expect(
            managerApi.post(`/advance-loans/${outsidePendingId}/approve`, {
              remarks: `${MARK} attempted across the department line`,
              installments: 3,
            }),
            'a manager decided a loan outside their department',
          ).rejects.toThrow(/403[\s\S]*only review requests from your own department/i);

          // And it was a refusal, not a decision that also happened to error.
          expect(
            (await loanOf(adminApi, outsidePendingId)).status,
            'the refused approval still decided the request',
          ).toBe('PENDING');
        },
      );
    } finally {
      // Cancelled by its OWNER while the session is still alive — a PENDING
      // request is `DELETE`-able only by the person who filed it, so leaving it
      // for the admin sweep would leave it holding one of manager2's two
      // allowance slots for every later spec.
      if (outsidePendingId) await retire(outsidePendingId, opsApi, adminApi);
      await opsApi.dispose();
      await employeeApi.dispose();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The second gate — settings, not decorators
// ───────────────────────────────────────────────────────────────────────────

/**
 * The gates a decorator cannot express.
 *
 * Four settings decide loan permissions at a level BELOW `@Roles`, and each is
 * narrower than the decorator above it. The claim these cases make is not "HR is
 * refused write-off" — `finance-loan-lifecycle.spec.ts` already owns that, from
 * the screen and from the API — but that the SETTING is what decides. Only a
 * flip proves that: the same caller, the same route, the same loan, and the
 * answer inverts because a row in `SystemSetting` changed.
 *
 * The whole describe is skipped unless `E2E_ALLOW_FLAG_FLIP=1`, because these
 * keys are environment-wide and a parallel worker halfway through a write-off
 * journey would see them move underneath it.
 */
test.describe('the settings-driven gates are narrower than the decorators above them', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'a pure-API sweep — one project drives it for all four roles');
    test.skip(
      !flagFlipAllowed(),
      'flips environment-wide loan permission settings; run with E2E_ALLOW_FLAG_FLIP=1 against its own database',
    );
  });

  let adminApi: ApiClient;
  let hrApi: ApiClient;
  let managerApi: ApiClient;
  let subject: TestEmployee | null = null;
  let setupError = '';

  /** A fresh live loan per case, so one case's write-off cannot starve the next. */
  const freshLoan = async (note: string): Promise<string> => {
    const imported = await importLoanFor(adminApi, subject!.code, {
      principal: 600,
      installments: 6,
      note,
    });
    created.push({ id: imported.id, owner: null });
    return imported.id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin') || !flagFlipAllowed()) return;
    try {
      adminApi = await ApiClient.as('admin');
      hrApi = await ApiClient.as('hr');
      managerApi = await ApiClient.as('manager');
      // Its own subject, in a department this file's manager does NOT head, so
      // the finance/auditor read tests are about the setting rather than about
      // departmental scope.
      const ops = await departmentIdByCode(adminApi, 'E2E-OPS');
      subject = await makeEmployee(adminApi, { marker: `${MARK}gate`, departmentId: ops });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await subject?.dispose();
    await adminApi?.dispose();
    await hrApi?.dispose();
    await managerApi?.dispose();
  });

  test('write-off follows advance_loan_writeoff_roles in both directions', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    const loanId = await freshLoan('the write-off role flip');

    await withSetting(adminApi, 'advance_loan_writeoff_roles', 'ADMIN,HR_MANAGER', async () => {
      // The decorator has not changed; the row in SystemSetting has. If HR were
      // refused here the gate would be something other than what it claims.
      await hrApi.post(`/advance-loans/${loanId}/write-off`, {
        reason: `${MARK} written off while HR is in the writeoff roles`,
      });
      const after = await loanOf(adminApi, loanId);
      expect(after.status, 'HR was in the writeoff roles and the write-off still did not take').toBe(
        'WRITTEN_OFF',
      );

      // Put it back so the restored-setting half below starts from a live loan.
      await adminApi.post(`/advance-loans/${loanId}/reinstate`, {
        reason: `${MARK} reinstated for the second half of the flip`,
      });
    });

    // Restored to the pinned `'ADMIN'`. Same caller, same route, same loan.
    await expect(
      hrApi.post(`/advance-loans/${loanId}/write-off`, {
        reason: `${MARK} attempted after the setting was restored`,
      }),
      'HR could still write off after advance_loan_writeoff_roles went back to ADMIN',
    ).rejects.toThrow(/403/);

    const restored = await loanOf(adminApi, loanId);
    expect(restored.status, 'the refused write-off still changed the loan').not.toBe('WRITTEN_OFF');
  });

  test('waiver follows loan_waiver_roles in both directions', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    const loanId = await freshLoan('the waiver role flip');

    // The default is `'ADMIN,HR_MANAGER'` — the one loan gate that is WIDER than
    // write-off, and the reason `finance-loan-lifecycle.spec.ts` asserts HR is
    // offered waive and not write-off on the same panel.
    await hrApi.post(`/advance-loans/${loanId}/waive`, {
      amount: 50,
      waiveType: 'PRINCIPAL',
      reason: `${MARK} waived under the default waiver roles`,
    });
    const afterWaive = await loanOf(adminApi, loanId);
    expect(Number(afterWaive.waivedAmount), 'the default waiver roles did not admit HR').toBe(50);

    await withSetting(adminApi, 'loan_waiver_roles', 'ADMIN', async () => {
      await expect(
        hrApi.post(`/advance-loans/${loanId}/waive`, {
          amount: 10,
          waiveType: 'PRINCIPAL',
          reason: `${MARK} attempted after the waiver roles narrowed`,
        }),
        'HR waived after loan_waiver_roles narrowed to ADMIN',
      ).rejects.toThrow(/403/);

      const unchanged = await loanOf(adminApi, loanId);
      expect(Number(unchanged.waivedAmount), 'the refused waiver still moved money').toBe(50);
    });
  });

  test('advance_loan_finance_roles grants a manager the whole book to READ, and nothing to write', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    const loanId = await freshLoan('the finance-roles read grant');

    // Before: the subject sits in a department this manager does not head.
    await expect(
      managerApi.get(`/advance-loans/${loanId}`),
      'the manager could already read outside their department',
    ).rejects.toThrow(/403/);

    await withSetting(adminApi, 'advance_loan_finance_roles', 'ADMIN,MANAGER', async () => {
      const seen = await loanOf(managerApi, loanId);
      expect(seen.id, 'advance_loan_finance_roles did not grant the read').toBe(loanId);

      // Read-all is not list-all: `GET /advance-loans` is `@Roles('ADMIN','HR_MANAGER')`
      // and no setting widens a decorator, so the book-wide list stays shut.
      await expect(
        managerApi.get('/advance-loans?limit=1'),
        'a finance role reached the company-wide list the decorator excludes',
      ).rejects.toThrow(/403/);

      // Nor does it grant a single write — every lifecycle route is ADMIN/HR.
      await expect(
        managerApi.post(`/advance-loans/${loanId}/hold`, {
          reason: `${MARK} a finance reader attempting a write`,
        }),
        'a finance READ grant carried a write with it',
      ).rejects.toThrow(/403/);
    });
  });

  test('advance_loan_auditor_roles grants a read that outlives no write — except where the role could already write', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    const loanId = await freshLoan('the auditor read grant');

    await withSetting(adminApi, 'advance_loan_auditor_roles', 'MANAGER', async () => {
      const seen = await loanOf(managerApi, loanId);
      expect(seen.id, 'advance_loan_auditor_roles did not grant the read').toBe(loanId);

      await expect(
        managerApi.post(`/advance-loans/${loanId}/hold`, {
          reason: `${MARK} an auditor attempting a write`,
        }),
        'an auditor role carried a write with it',
      ).rejects.toThrow(/403/);
    });

    // The half that matters most: naming a role that ALREADY holds write access
    // as an auditor must take that write away. `LoanAccessService.isReadOnly()`
    // used to compute exactly this and have no caller anywhere, so declaring
    // HR an auditor was silently a no-op — read-only by the service's own
    // reckoning, and still able to move money. `LoanReadOnlyGuard` now enforces
    // it by HTTP verb, so a route added later is closed by default.
    await withSetting(adminApi, 'advance_loan_auditor_roles', 'HR_MANAGER', async () => {
      await expect(
        hrApi.post(`/advance-loans/${loanId}/hold`, {
          reason: `${MARK} a nominally read-only auditor holding a loan`,
        }),
        'a role declared read-only kept its write access',
      ).rejects.toThrow(/403[\s\S]*read-only \(auditor\) access/);

      // The read half of the grant is untouched — that is what makes it an
      // auditor rather than a revocation.
      const seen = await loanOf(hrApi, loanId);
      expect(seen.id, 'the auditor lost the read along with the write').toBe(loanId);

      // ADMIN is exempt from the ROLE-wide list on purpose: listing ADMIN there
      // is far more likely a fat-fingered "everyone should be able to audit"
      // than a decision to freeze every money operation with nobody left to
      // thaw them. The per-user list is the way to make an ADMIN an observer.
      expect((await loanOf(adminApi, loanId)).status).toBe('ACTIVE');
    });
  });

  test('advance_loan_auditor_user_ids cannot be exercised — it is writable but not readable', async () => {
    // Not a skipped-for-convenience case. `GET /system-settings` is built from
    // `SystemSettingsService.getSettingsList()`, which does not include this key,
    // so its current value cannot be read — and `withSetting` refuses any key it
    // cannot restore afterwards, correctly, because a per-user auditor grant left
    // switched on would hand one account the whole loan book for the rest of the
    // database's life. Fixing this belongs in `getSettingsList()`, not here.
    test.skip(
      true,
      'advance_loan_auditor_user_ids is absent from GET /system-settings, so it cannot be set and restored safely',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Tampered payloads
// ───────────────────────────────────────────────────────────────────────────

test.describe('a tampered payload does not become authority', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'a pure-API sweep — one project drives it for all four roles');
  });

  let adminApi: ApiClient;
  let employeeApi: ApiClient;
  let http: APIRequestContext;
  let subject: TestEmployee | null = null;
  let foreignLoanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      employeeApi = await ApiClient.as('employee');
      http = await request.newContext({ baseURL: API_URL });

      const ops = await departmentIdByCode(adminApi, 'E2E-OPS');
      subject = await makeEmployee(adminApi, { marker: `${MARK}tamper`, departmentId: ops });
      const imported = await importLoanFor(adminApi, subject.code, {
        principal: 600,
        installments: 6,
        note: 'the tampering subject',
      });
      foreignLoanId = imported.id;
      created.push({ id: foreignLoanId, owner: null });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await subject?.dispose();
    await adminApi?.dispose();
    await employeeApi?.dispose();
    await http?.dispose();
  });

  test("an eligibility check naming somebody else answers about the caller", async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // The controller substitutes `user.employeeId` for any non-privileged
    // caller, so this is NOT a 403 — it is a quiet redirection, which is the
    // safer design and the harder one to notice has stopped working.
    const answer = await employeeApi.post<{ employeeId?: string }>('/advance-loans/eligibility', {
      employeeId: subject!.id,
      amount: 100,
      installments: 1,
      type: 'LOAN',
    });

    if (answer?.employeeId !== undefined) {
      expect(answer.employeeId, 'the eligibility answer was about the employee that was named').not.toBe(
        subject!.id,
      );
    }

    // The proof that matters is negative: whatever came back, the caller learned
    // nothing about the other employee's loan book.
    await expect(
      employeeApi.get(`/advance-loans/${foreignLoanId}`),
      'the eligibility probe opened a door to the named employee',
    ).rejects.toThrow(/403/);
  });

  test('a decision naming a foreign loan is refused, whichever route it arrives on', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // Approve, aimed at a loan the caller may not even see.
    await expect(
      employeeApi.post(`/advance-loans/${foreignLoanId}/approve`, {
        remarks: `${MARK} tampered approval`,
      }),
      'an employee approved a loan by pointing at its id',
    ).rejects.toThrow(/403/);

    // A settlement decision that names a loan belonging to a DIFFERENT employee
    // than the one being settled. The settlement is driven as ADMIN — who is
    // entitled to settle — so the refusal has to come from the decision's own
    // consistency check rather than from a role.
    await expect(
      adminApi.post(`/advance-loans/settlement/${subject!.id}`, {
        decisions: [{ loanId: PHANTOM_LOAN, action: 'WAIVE', reason: `${MARK} tampered decision` }],
        reason: `${MARK} tampered settlement`,
      }),
      'a settlement accepted a decision naming a loan that is not this employee’s',
    ).rejects.toThrow(/40[03]/);

    const untouched = await loanOf(adminApi, foreignLoanId);
    expect(untouched.status, 'the refused settlement still moved the loan').toBe('ACTIVE');
  });

  test('impossible numbers, malformed ids and unexpected fields are refused before anything happens', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const token = adminApi.token;

    // A negative instalment count. `@IsInt() @Min(1)` on the DTO.
    expect(
      await statusOf(http, token, {
        method: 'POST',
        path: `/advance-loans/${foreignLoanId}/skip-installment`,
        body: { installmentNo: -1, reason: `${MARK} negative instalment` },
      }),
      'a negative instalment number was accepted',
    ).toBe(400);

    // An amount that is a string carrying a SQL fragment. Prisma parameterises
    // everything, so the interesting assertion is that it never reaches Prisma
    // at all — the money DTOs are `@IsNumber`, not `@IsNumberString`.
    expect(
      await statusOf(http, token, {
        method: 'POST',
        path: `/advance-loans/${foreignLoanId}/prepay`,
        body: { amount: '500; DROP TABLE advance_loan_requests' },
      }),
      'a string amount reached the money path',
    ).toBe(400);

    // An extra field nobody declared. The global pipe runs `whitelist` AND
    // `forbidNonWhitelisted`, so this is a refusal rather than a silent strip —
    // worth pinning, because the two behaviours are one flag apart and the
    // silent one lets a client believe it set something it did not.
    expect(
      await statusOf(http, token, {
        method: 'POST',
        path: `/advance-loans/${foreignLoanId}/hold`,
        body: { reason: `${MARK} extra field`, approvedBy: 'me', status: 'CLOSED' },
      }),
      'an undeclared field was tolerated in a lifecycle payload',
    ).toBe(400);

    // A well-formed UUID that names nothing: 404, and specifically not a 500.
    expect(
      await statusOf(http, token, {
        method: 'POST',
        path: `/advance-loans/${PHANTOM_LOAN}/hold`,
        body: { reason: `${MARK} phantom loan` },
      }),
      'a non-existent loan did not answer 404',
    ).toBe(404);

    // Not a UUID at all, on a route that declares `ParseUUIDPipe`.
    expect(
      await statusOf(http, token, {
        method: 'GET',
        path: '/advance-loans/not-a-uuid/schedule',
      }),
      'ParseUUIDPipe did not refuse a malformed id',
    ).toBe(400);

    // A JSON body announced as text/plain. Express's JSON parser leaves it
    // unparsed, so the DTO sees nothing and validation refuses it — the point
    // being that a content-type is not a way around the pipe.
    expect(
      await statusOf(
        http,
        token,
        {
          method: 'POST',
          path: `/advance-loans/${foreignLoanId}/hold`,
          body: JSON.stringify({ reason: `${MARK} smuggled as text/plain` }),
        },
        'text/plain',
      ),
      'a JSON body sent as text/plain was accepted',
    ).toBe(400);

    const untouched = await loanOf(adminApi, foreignLoanId);
    expect(untouched.status, 'one of the malformed requests moved the loan').toBe('ACTIVE');
    expect(Number(untouched.amountRepaid), 'one of the malformed requests moved money').toBe(0);
  });

  test('the same malformed id on the unparameterised detail route', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // `GET /advance-loans/:id` declares NO `ParseUUIDPipe` — unlike every route
    // in the lifecycle controller beside it — so the string reaches Prisma and
    // the error is whatever Prisma makes of it. Recorded rather than judged: the
    // one thing that must be true is that the client is not handed a Prisma
    // stack trace, which `AllExceptionsFilter` rewrites to a flat sentence.
    const status = await statusOf(http, adminApi.token, {
      method: 'GET',
      path: '/advance-loans/not-a-uuid',
    });

    // BUG?: a malformed id on this route is answered by Prisma rather than by a
    // pipe, so it is a 500 where the identical id on `:id/schedule` is a 400.
    expect(
      [400, 404, 500],
      `GET /advance-loans/not-a-uuid answered ${status}`,
    ).toContain(status);
    expect(status, 'a malformed id on the detail route reached a 2xx').toBeGreaterThanOrEqual(400);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. Cross-branch
// ───────────────────────────────────────────────────────────────────────────

test.describe('a branch envelope is not a suggestion', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'a pure-API sweep — one project drives it for all four roles');
  });

  /** Separate clients per branch: `withBranch` MUTATES and exposes no getter. */
  let adminUnscoped: ApiClient;
  let adminHO: ApiClient;
  let adminBR2: ApiClient;
  let subject: TestEmployee | null = null;
  let br2LoanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminUnscoped = await ApiClient.as('admin');
      adminHO = await ApiClient.as('admin');
      adminBR2 = await ApiClient.as('admin');

      const ho = await branchIdByCode(adminUnscoped, 'HO');
      const br2 = await branchIdByCode(adminUnscoped, 'E2E-BR2');
      adminHO.withBranch(ho);
      adminBR2.withBranch(br2);

      const ops = await departmentIdByCode(adminUnscoped, 'E2E-OPS');
      subject = await makeEmployee(adminUnscoped, {
        marker: `${MARK}br2`,
        departmentId: ops,
        branchId: br2,
      });
      const imported = await importLoanFor(adminUnscoped, subject.code, {
        principal: 700,
        installments: 7,
        note: 'a loan in the second branch',
      });
      br2LoanId = imported.id;
      created.push({ id: br2LoanId, owner: null });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await subject?.dispose();
    await adminUnscoped?.dispose();
    await adminHO?.dispose();
    await adminBR2?.dispose();
  });

  test('a loan from another branch is not refused — it does not exist', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    // 404, deliberately, not 403: `assertInBranch` must not leak the fact that
    // the id names something. The distinction is the whole design.
    await expect(
      adminHO.get(`/advance-loans/${br2LoanId}`),
      'a loan in the second branch was visible from Head Office',
    ).rejects.toThrow(/404/);

    // And it does exist — under its own branch. Without this half, a broken id
    // would pass the assertion above for the wrong reason.
    const seen = await loanOf(adminBR2, br2LoanId);
    expect(seen.id, 'the loan is not readable from its own branch either').toBe(br2LoanId);
  });

  test('every branch-scoped door answers the same way for a foreign loan', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    for (const path of [
      `/advance-loans/${br2LoanId}/schedule`,
      `/advance-loans/${br2LoanId}/payoff-quote`,
      `/advance-loans/${br2LoanId}/attachments`,
    ]) {
      await expect(adminHO.get(path), `${path} answered across the branch boundary`).rejects.toThrow(
        /404/,
      );
    }

    // A write across the boundary is the same 404 — the guard is in the loan
    // lookup, so there is no window where a mutation resolves an object the
    // reader could not have seen.
    await expect(
      adminHO.post(`/advance-loans/${br2LoanId}/hold`, {
        reason: `${MARK} attempted across the branch boundary`,
      }),
      'a loan in another branch could be held from Head Office',
    ).rejects.toThrow(/404/);
  });

  test('one branch’s outstanding report never names another branch’s borrower', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const inHO = await adminHO.get<unknown>('/advance-loans/reports/outstanding?limit=200');
    const hoRows = (
      Array.isArray(inHO) ? inHO : ((inHO as { data?: unknown }).data as unknown[] | undefined) ?? []
    ) as Array<{ employeeCode?: string; employeeId?: string }>;

    expect(
      hoRows.map((r) => r.employeeCode),
      'the Head Office loan book carried a borrower from the second branch',
    ).not.toContain(subject!.code);
    expect(
      hoRows.map((r) => r.employeeId),
      'the Head Office loan book carried a borrower from the second branch',
    ).not.toContain(subject!.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. The audit trail (§22)
// ───────────────────────────────────────────────────────────────────────────

/**
 * What the system remembers.
 *
 * Twelve money operations write their own row through `LoanLifecycleService.trail`
 * / `LoanSettlementService`, and create/approve/reject/cancel are written by the
 * `@AuditResource('AdvanceLoan')` interceptor. The two use DIFFERENT
 * `resourceType` values for the same resource, which is why every assertion here
 * names the one it expects rather than querying for "the loan's rows".
 *
 * Driven as ADMIN against an imported subject, so nothing here competes for the
 * seeded accounts' two-live-loan allowance.
 */
test.describe('every operation that moves money leaves a row naming who moved it', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens.
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'a pure-API sweep — the audit log is ADMIN-only');
  });

  // One label for one resource. The services used to write
  // `'AdvanceLoanRequest'` while the `@AuditResource` decorator on the same
  // controllers wrote `'AdvanceLoan'` — so an auditor pulling a loan's history
  // got half of it, with nothing to say the other half existed.
  const TRAIL = 'AdvanceLoan';

  let adminApi: ApiClient;
  let subject: TestEmployee | null = null;
  let actorId = '';
  let setupError = '';

  const freshLoan = async (note: string, opts?: { fullyPaid?: boolean }): Promise<string> => {
    const imported = await importLoanFor(adminApi, subject!.code, {
      principal: 600,
      installments: 6,
      fullyPaid: opts?.fullyPaid,
      note,
    });
    created.push({ id: imported.id, owner: null });
    return imported.id;
  };

  test.beforeAll(async () => {
    if (!isProject('admin')) return;
    try {
      adminApi = await ApiClient.as('admin');
      actorId = actorIdOf(adminApi);
      const ops = await departmentIdByCode(adminApi, 'E2E-OPS');
      subject = await makeEmployee(adminApi, { marker: `${MARK}audit`, departmentId: ops });
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    await subject?.dispose();
    await adminApi?.dispose();
  });

  test('hold, resume, skip, waive, prepay, write-off and reinstate are each audited', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    const t0 = Date.now();
    const loanId = await freshLoan('the audited lifecycle run');

    // One loan through seven operations, in the order the statuses permit. Each
    // assertion is made immediately after its operation so a missing row names
    // the operation that failed to write it rather than the last one to run.
    await adminApi.post(`/advance-loans/${loanId}/hold`, { reason: `${MARK} audited hold` });
    await expectAuditRow(
      adminApi,
      { action: 'LOAN_HOLD_APPLIED', resourceType: TRAIL, resourceId: loanId },
      actorId,
      t0,
    );

    await adminApi.post(`/advance-loans/${loanId}/resume`, { reason: `${MARK} audited resume` });
    await expectAuditRow(
      adminApi,
      { action: 'LOAN_HOLD_RELEASED', resourceType: TRAIL, resourceId: loanId },
      actorId,
      t0,
    );

    await adminApi.post(`/advance-loans/${loanId}/skip-installment`, {
      installmentNo: 3,
      mode: 'FORGIVE',
      reason: `${MARK} audited instalment forgiveness`,
    });
    await expectAuditRow(
      adminApi,
      { action: 'LOAN_INSTALLMENT_SKIPPED', resourceType: TRAIL, resourceId: loanId },
      actorId,
      t0,
    );

    await adminApi.post(`/advance-loans/${loanId}/waive`, {
      amount: 50,
      waiveType: 'PRINCIPAL',
      reason: `${MARK} audited waiver`,
    });
    await expectAuditRow(
      adminApi,
      { action: 'LOAN_WAIVED', resourceType: TRAIL, resourceId: loanId },
      actorId,
      t0,
    );

    await adminApi.post(`/advance-loans/${loanId}/prepay`, {
      amount: 50,
      mode: 'CASH',
      reference: `${MARK}`,
    });
    await expectAuditRow(
      adminApi,
      { action: 'LOAN_PREPAYMENT', resourceType: TRAIL, resourceId: loanId },
      actorId,
      t0,
    );

    await adminApi.post(`/advance-loans/${loanId}/write-off`, {
      reason: `${MARK} audited write-off of the remaining balance`,
    });
    await expectAuditRow(
      adminApi,
      { action: 'LOAN_WRITTEN_OFF', resourceType: TRAIL, resourceId: loanId },
      actorId,
      t0,
    );

    await adminApi.post(`/advance-loans/${loanId}/reinstate`, {
      reason: `${MARK} audited reinstatement`,
    });
    await expectAuditRow(
      adminApi,
      { action: 'LOAN_REINSTATED', resourceType: TRAIL, resourceId: loanId },
      actorId,
      t0,
    );
  });

  test('a manual close and a foreclosure are audited as themselves', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    const t0 = Date.now();

    // Manual close is only legal within `loan_rounding_tolerance` (1.00), so the
    // balance is waived down to a residual the rule admits — which is exactly
    // the "0.01 left after the final EMI" case the route exists for.
    const closing = await freshLoan('the audited manual close');
    await adminApi.post(`/advance-loans/${closing}/waive`, {
      amount: 599.5,
      waiveType: 'PRINCIPAL',
      reason: `${MARK} waived down to the rounding residual`,
    });
    await adminApi.post(`/advance-loans/${closing}/close`, {
      reason: `${MARK} closed on the rounding residual`,
    });
    await expectAuditRow(
      adminApi,
      { action: 'LOAN_CLOSED', resourceType: TRAIL, resourceId: closing },
      actorId,
      t0,
    );

    // Foreclosure refuses any loan with principal left, and `loan_interest_enabled`
    // is pinned false so there is never an interest-only remainder. The importer
    // is the only way to reach the state the route is for: every instalment
    // already paid, the loan still ACTIVE.
    const settled = await freshLoan('the audited foreclosure', { fullyPaid: true });
    await adminApi.post(`/advance-loans/${settled}/foreclose`, {
      reason: `${MARK} foreclosed with nothing outstanding`,
    });
    await expectAuditRow(
      adminApi,
      { action: 'LOAN_FORECLOSED', resourceType: TRAIL, resourceId: settled },
      actorId,
      t0,
    );
  });

  test('converting an advance is audited against the advance it closed', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    const t0 = Date.now();

    // The conversion needs a real ADVANCE, and an advance can only be FILED by
    // its owner — so this is the one audit case driven from a seeded account.
    const owner = await ApiClient.as('employee');
    try {
      const advanceId = await liveLoan(owner, adminApi, {
        type: 'ADVANCE',
        amount: 300,
        note: `${MARK} — the advance to convert`,
        markerPrefix: PREFIX,
      });
      created.push({ id: advanceId, owner });

      const converted = await adminApi.post<{ newLoanId?: string }>(
        `/advance-loans/${advanceId}/convert`,
        { installments: 3, reason: `${MARK} converted to an instalment loan` },
      );
      // The conversion creates a NEW request that re-enters approval, and it
      // counts against the allowance like any other — so it is tracked too.
      const newId = converted?.newLoanId;
      if (typeof newId === 'string') created.push({ id: newId, owner });

      await expectAuditRow(
        adminApi,
        { action: 'ADVANCE_CONVERTED_TO_LOAN', resourceType: TRAIL, resourceId: advanceId },
        actorId,
        t0,
      );
    } finally {
      await owner.dispose();
    }
  });

  test('a settlement and its reversal are audited against the settlement, not the loan', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    const t0 = Date.now();
    const loanId = await freshLoan('the settled loan');

    // Every non-terminal loan has to be named or the settlement is refused, and
    // this subject carries whatever the cases above left live. Naming only the
    // loan under test made the case depend on how many loans its neighbours
    // happened to leave outstanding, which is not what it is about — so the
    // quote decides the decision set, and the assertion is that the loan under
    // test is in it.
    const quote = await adminApi.get<{ loans?: Array<{ loanId: string }> }>(
      `/advance-loans/settlement/${subject!.id}`,
    );
    const outstanding = quote?.loans ?? [];
    expect(
      outstanding.some((l) => l.loanId === loanId),
      'the loan just created is not in the settlement quote',
    ).toBe(true);

    const settled = await adminApi.post<{ settlementId?: string }>(
      `/advance-loans/settlement/${subject!.id}`,
      {
        decisions: outstanding.map((l) => ({
          loanId: l.loanId,
          action: 'WAIVE',
          reason: `${MARK} waived at settlement`,
        })),
        reason: `${MARK} exit settlement`,
      },
    );
    const settlementId = settled?.settlementId;
    expect(settlementId, 'the settlement did not report its own id').toBeTruthy();

    // `resourceId` is the SETTLEMENT, and `resourceType` is `LoanSettlement` —
    // a reader hunting the loan's own trail will not find these rows, which is
    // worth pinning rather than discovering during an audit.
    await expectAuditRow(
      adminApi,
      {
        action: 'LOAN_SETTLEMENT_DECIDED',
        resourceType: 'LoanSettlement',
        resourceId: settlementId!,
      },
      actorId,
      t0,
    );

    await adminApi.post(`/advance-loans/settlement/${settlementId}/reverse`, {
      reason: `${MARK} reversed the exit settlement`,
    });
    await expectAuditRow(
      adminApi,
      {
        action: 'LOAN_SETTLEMENT_REVERSED',
        resourceType: 'LoanSettlement',
        resourceId: settlementId!,
      },
      actorId,
      t0,
    );
  });

  test('filing, approving, rejecting and cancelling are audited by the interceptor', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');
    const t0 = Date.now();

    const owner = await ApiClient.as('employee');
    const filerId = actorIdOf(owner);

    /** Files one request as the employee, making room for it first. */
    const file = async (note: string): Promise<string> => {
      // `loan_max_active_per_employee` is 2 and this file already holds a slot,
      // so the allowance is made before each filing rather than discovered as a
      // 400 in the middle of an audit assertion.
      await ensureAllowance(owner, adminApi, 200, PREFIX);
      const filed = await owner.post<{ id: string }>('/advance-loans', {
        type: 'LOAN',
        amount: 200,
        installments: 2,
        reason: `${MARK} — ${note}`,
      });
      created.push({ id: filed.id, owner });
      return filed.id;
    };

    try {
      // ── create + cancel, on one request ──────────────────────────────
      // Cancellation is only legal while the request is PENDING, so the
      // cancelled subject is never approved — which is why this needs three
      // requests rather than one carried through every decision.
      const cancelled = await file('filed, then cancelled');

      // BUG?: the interceptor writes `resourceType: 'AdvanceLoan'` (from
      // `@AuditResource`) while every lifecycle row above is
      // `'AdvanceLoanRequest'` — one resource under two names, and neither query
      // finds the other's rows.
      await expectAuditRow(
        adminApi,
        { action: 'CREATE', resourceType: 'AdvanceLoan', resourceId: cancelled },
        filerId,
        t0,
      );

      // A DELETE is the one verb the interceptor names distinctly.
      await owner.delete(`/advance-loans/${cancelled}`);
      await expectAuditRow(
        adminApi,
        { action: 'DELETE', resourceType: 'AdvanceLoan', resourceId: cancelled },
        filerId,
        t0,
      );

      // ── reject ────────────────────────────────────────────────────────
      const rejected = await file('filed, then rejected');
      await adminApi.post(`/advance-loans/${rejected}/reject`, {
        remarks: `${MARK} rejected for the interceptor trail`,
      });

      // A decision is a POST with an id in the path, so the interceptor records
      // it as another CREATE against the same resource — the action vocabulary
      // is the HTTP verb, not the operation. What proves the DECIDER was
      // recorded is therefore a row carrying the admin's id, not the filer's.
      await expect
        .poll(
          async () => {
            const rows = await auditRows(adminApi, {
              action: 'CREATE',
              resourceType: 'AdvanceLoan',
              resourceId: rejected,
            });
            return rows.some((r) => r.userId === actorId);
          },
          { timeout: 15_000 },
        )
        .toBe(true);

      // ── approve ───────────────────────────────────────────────────────
      const approved = await file('filed, then approved');
      await adminApi.post(`/advance-loans/${approved}/approve`, {
        remarks: `${MARK} approved for the interceptor trail`,
        installments: 2,
      });
      await expect
        .poll(
          async () => {
            const rows = await auditRows(adminApi, {
              action: 'CREATE',
              resourceType: 'AdvanceLoan',
              resourceId: approved,
            });
            return rows.some((r) => r.userId === actorId);
          },
          { timeout: 15_000 },
        )
        .toBe(true);
    } finally {
      await owner.dispose();
    }
  });

  test('the audit log itself is readable by nobody but an admin', async () => {
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    const http = await request.newContext({ baseURL: API_URL });
    const others: Who[] = ['hr', 'manager', 'employee'];
    try {
      for (const who of others) {
        const client = await ApiClient.as(who);
        try {
          const status = await statusOf(http, client.token, {
            method: 'GET',
            path: '/audit-logs?limit=1',
          });
          expect(status, `${who} could read the audit log`).toBe(403);
        } finally {
          await client.dispose();
        }
      }

      expect(
        await statusOf(http, null, { method: 'GET', path: '/audit-logs?limit=1' }),
        'the audit log answered a caller with no token',
      ).toBe(401);
    } finally {
      await http.dispose();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 8. Teardown
// ───────────────────────────────────────────────────────────────────────────

test.describe('teardown', () => {
  test.beforeEach(() => {
    test.skip(!isProject('admin'), 'the admin project owns everything this file created');
  });

  test('every loan this file created is retired', async () => {
    const admin = await ApiClient.as('admin');
    try {
      for (const record of created) {
        await retire(record.id, record.owner ?? admin, admin);
      }
      // The belt to the braces: anything a crashed earlier run left behind
      // carries the same prefix in its reason and is swept here. Scoped to the
      // prefix and nothing else, so a concurrently running spec's loans are
      // never touched.
      await retireAllMarked(admin, PREFIX);
    } finally {
      await admin.dispose();
    }

    // Nothing to assert beyond "the sweep ran" — a retirement that is refused
    // (an unlocked payroll holding an instalment) is deliberately swallowed by
    // `retire`, because failing teardown for another spec's payroll run reports
    // the wrong file as broken.
    expect(created.length, 'this file created no loans at all, which means its setup never ran')
      .toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 9. The browser side of the same rules
// ───────────────────────────────────────────────────────────────────────────

/**
 * The employee's list screen offers nothing it is not entitled to.
 *
 * The server would refuse each of these anyway — that is what the matrix above
 * asserts — so this is about the OFFER. A button that opens a screen the API
 * refuses turns a permission boundary into a broken feature, and the user cannot
 * tell the two apart.
 */
test.describe('an employee’s loan screen offers no privileged door', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens for the other roles.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the employee’s own view of the list');
  });

  test('there is no reports button, no importer and no all-requests tab', async ({
    page,
    problems,
  }) => {
    await page.goto('/dashboard/advance-loans', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Evidence the screen actually rendered — without it, three zero counts
    // would pass just as well on a blank page.
    await expect(page.getByTestId('loan-new')).toBeVisible({ timeout: 20_000 });

    expect(await page.getByTestId('loan-reports').count(), 'the employee was offered the loan book').toBe(
      0,
    );
    expect(await page.getByTestId('loan-import').count(), 'the employee was offered the importer').toBe(
      0,
    );
    expect(
      await page.getByTestId('loan-tab-all').count(),
      'the employee was offered the all-requests tab',
    ).toBe(0);

    settle(problems, 'the employee’s advances and loans list');
  });
});

/**
 * An employee who types a colleague's loan id into the address bar.
 *
 * The detail route is dynamic, so `<ProtectedRoute>` cannot express who owns the
 * record — the server does, with a 403, and the screen has to turn that into a
 * refusal rather than into a blank page or, worse, a rendered loan.
 */
test.describe('an employee opening a colleague’s loan by URL is refused, not served', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens for the other roles.
  test.beforeEach(() => {
    test.skip(!isProject('employee'), 'the refused half — driven from the employee’s browser');
  });

  let adminApi: ApiClient;
  let employeeApi: ApiClient;
  let subject: TestEmployee | null = null;
  let branchId = '';
  let foreignLoanId = '';
  let setupError = '';

  test.beforeAll(async () => {
    if (!isProject('employee')) return;
    try {
      // Resolved as ADMIN on purpose: `GET /branches` and `GET /departments`
      // admit ADMIN/HR/MANAGER, so an EMPLOYEE asking would 403 and the SETUP
      // would fail before the case could observe the denial it exists to show.
      adminApi = await ApiClient.as('admin');
      employeeApi = await ApiClient.as('employee');
      branchId = await branchIdByCode(adminApi, 'HO');
      const hrd = await departmentIdByCode(adminApi, 'HRD');
      subject = await makeEmployee(adminApi, { marker: `${MARK}url`, departmentId: hrd });
      const imported = await importLoanFor(adminApi, subject.code, {
        principal: 500,
        installments: 5,
        note: 'the colleague’s loan the employee will try to open',
      });
      foreignLoanId = imported.id;
    } catch (e) {
      setupError = (e as Error).message;
    }
  });

  test.afterAll(async () => {
    if (isProject('employee') && foreignLoanId && adminApi) {
      await retire(foreignLoanId, adminApi, adminApi);
    }
    await subject?.dispose();
    await adminApi?.dispose();
    await employeeApi?.dispose();
  });

  test('the loan never renders, and the screen says so instead of showing it', async ({
    page,
    problems,
  }) => {
    // The 403 IS the expected answer here, and the screen logs the failed fetch
    // on its way to reporting it. Only an uncaught render or a 5xx is a fault.
    crashesOnly(problems);
    expect(setupError, `setup failed: ${setupError}`).toBe('');

    await selectBranch(page, branchId);
    await page.goto(`/dashboard/advance-loans/${foreignLoanId}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForLoadState('networkidle').catch(() => {});

    // The detail screen sends the reader back to the list when the loan cannot
    // be loaded. Polled, because that redirect happens after the fetch settles.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .toBe('/dashboard/advance-loans');

    // The status badge is the one element that only exists when a loan was
    // actually rendered, so its absence is the assertion that nothing leaked.
    expect(await page.getByTestId('loan-status').count(), 'a colleague’s loan was rendered').toBe(0);

    // Something rendered. A silently blank body is what a thrown render looks
    // like from outside, and it is the failure this suite exists to catch.
    expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0);

    // And the server really did refuse — a redirect caused by something else
    // would make this pass for the wrong reason.
    await expect(employeeApi.get(`/advance-loans/${foreignLoanId}`)).rejects.toThrow(/403/);

    settle(problems, 'an employee opening a colleague’s loan by URL');
  });
});

/**
 * The refused report screen, judged for what it LEAKS rather than for what it says.
 *
 * `finance-loan-reports.spec.ts` owns the F27 regression — the modal, the
 * `loan-report-failed` panel, and the absence of `loan-report-empty` — for both
 * refused roles. Those three are re-checked here only as the precondition of the
 * claim this file cares about: that a refused report hands the reader no rows,
 * no export and no figures.
 */
test.describe('a refused report leaks nothing, not even an empty table', () => {
  // Role gate, in a hook rather than in each body: a skip decided here happens
  // before the page fixture is built, so no browser opens for the other roles.
  test.beforeEach(() => {
    test.skip(!isProject('manager'), 'the manager is one of the two roles the book is not for');
  });

  test('no rows, no export, and the refusal is the only thing on screen', async ({
    page,
    problems,
  }) => {
    // A 403 is the correct answer on this screen, and it is logged as a console
    // error on the way to being displayed.
    crashesOnly(problems);

    const admin = await ApiClient.as('admin');
    const managerApi = await ApiClient.as('manager');
    try {
      // The branch id is a selector value, not a permission claim, so who
      // fetched it is irrelevant — and `GET /branches` is not the employee's.
      await selectBranch(page, await branchIdByCode(admin, 'HO'));

      const reports = new LoanReportsPage(page);
      await reports.open();

      // The route carries no `<ProtectedRoute>`, so the shell is reached rather
      // than /403 — the deliberate difference from the banks cluster.
      expect(new URL(page.url()).pathname).toBe('/dashboard/advance-loans/reports');

      // Precondition, owned by finance-loan-reports.spec.ts: the refusal is
      // shown, and the empty state is NOT — "nobody owes anything" and "you may
      // not see who owes anything" are opposite facts about company money.
      await expect(page.getByTestId('loan-report-failed')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('loan-report-empty')).toHaveCount(0);

      // The claim this case adds: nothing of the book reached the browser.
      expect(await reports.rowCount(), 'a refused report rendered rows').toBe(0);
      expect(await reports.canExport(), 'a refused report offered an export').toBe(false);

      // The same fact by ATTRIBUTE rather than by clicking. Pressing the button
      // to see whether it answers is the wrong instrument twice over: with the
      // modal up the click cannot land at all, so a timeout would be recorded
      // as "the export is refused" whatever the button's state actually was —
      // and a click that DID land would have started a download rather than
      // asserted anything. `toBeDisabled` reads the attribute the page sets
      // (`disabled={loading || rows.length === 0}`) and drives nothing.
      await expect(page.getByTestId('loan-report-export')).toBeDisabled();

      // The refusal is MODAL, and that is the point rather than an obstacle.
      // `lib/axios` raises the global Access Denied dialog on any 403, and its
      // backdrop covers the whole screen — the tab strip included. So driving
      // this screen tab by tab is not thoroughness, it is impossible: the click
      // lands on the dialog's overlay and times out, and the timeout says
      // nothing about the tab. Asserted here as the reason the rest of the
      // screen is unreachable.
      await expect(page.getByTestId('permission-denied-modal')).toBeVisible({ timeout: 20_000 });

      // All five tabs did render, so "no rows" below is a statement about a
      // screen that drew its whole report chrome — not about one that failed to
      // draw and therefore had nothing to leak.
      expect(await reports.tabCount(), 'the refused report did not render its tabs').toBe(
        LOAN_REPORT_TABS.length,
      );

      // F27 once more, from the attribute side and without touching anything:
      // the body under the dialog is in the FAILED state and is stamped with
      // the tab that produced it. A body that had quietly fallen back to the
      // empty state would carry `loan-report-empty` with the same `data-tab` —
      // which is the exact substitution the regression was about.
      expect(
        await page.getByTestId('loan-report-failed').getAttribute('data-tab'),
        'the failure panel is not stamped with the tab that produced it',
      ).toBe(await reports.activeTab());

      // The per-tab claim — that no tab serves this role — is made against the
      // SERVER instead, immediately below. That is where a forgotten failure
      // state would leak FROM, and all five endpoints are asserted rather than
      // the four the tab loop used to reach.

      // And the server is the authority for all five.
      for (const path of [
        '/advance-loans/reports/outstanding',
        '/advance-loans/reports/portfolio',
        '/advance-loans/reports/emi-due',
        '/advance-loans/reports/overdue',
        '/advance-loans/reports/interest-earned',
      ]) {
        await expect(managerApi.get(path), `${path} was served to a MANAGER`).rejects.toThrow(/403/);
      }
    } finally {
      await managerApi.dispose();
      await admin.dispose();
    }

    settle(problems, 'the loan reports refused to a manager');
  });
});
