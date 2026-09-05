/**
 * Every static dashboard route, and who is expected to reach it.
 *
 * Generated from the `app/` tree and then annotated by hand. The annotations
 * are deliberately written out rather than derived from `utils/permissions.ts`:
 * a table computed from the code under test agrees with that code by
 * construction, including when it is wrong. This is the independent oracle.
 *
 * `allowed` lists the roles that should see the screen. It is only meaningful
 * for routes wrapped in `<ProtectedRoute>` — everything else renders its shell
 * for any signed-in user and relies on the API returning 403, which surfaces as
 * the permission modal rather than a redirect. Those routes carry
 * `guarded: false` and are checked for *crashes* only.
 *
 * Dynamic routes ([id], [slug]) are excluded here and covered by the journey
 * specs, which have real records to point at.
 */

export type Role = 'admin' | 'hr' | 'manager' | 'employee';

export const ALL_ROLES: Role[] = ['admin', 'hr', 'manager', 'employee'];

export interface RouteSpec {
  path: string;
  /** True when the page is wrapped in ProtectedRoute and will redirect to /403. */
  guarded: boolean;
  /**
   * Roles expected to get PAST the client-side guard. Only enforced when
   * `guarded` — an unguarded page renders its shell for anyone signed in.
   */
  allowed: Role[];
  /**
   * Roles that can actually USE the screen, i.e. load its data without the API
   * answering 403. Defaults to `allowed`, and differs only where the client
   * guard is weaker than the server — which is exactly the interesting case.
   *
   * Drives how strictly the page is judged: a role outside this set will see
   * the screen log a failed fetch, and that is correct behaviour rather than a
   * bug, so only crashes are fatal for them.
   */
  usableBy?: Role[];
  /**
   * (path, role) pairs that are currently BROKEN in the app, with the reason.
   * The spec marks these `test.fail()`, so the suite stays green while the
   * defect is recorded — and turns red again the moment it is fixed, which is
   * what stops a fix from going unnoticed.
   */
  knownBroken?: { roles: Role[]; issue: string };
  /**
   * The screen's backing feature is switched off in the test environment, so
   * its API answers 5xx by design. Judged for uncaught render errors only.
   */
  featureDisabled?: string;
  /** Skip for these roles — the screen is meaningless without seeded state. */
  skip?: Role[];
}

const EVERYONE: Role[] = ALL_ROLES;
const ADMIN: Role[] = ['admin'];
const ADMIN_HR: Role[] = ['admin', 'hr'];
const ADMIN_HR_MANAGER: Role[] = ['admin', 'hr', 'manager'];

export const ROUTES: RouteSpec[] = [
  // ── Module hubs ───────────────────────────────────────────────────────────
  // Each sidebar group's header links here instead of only expanding, and the
  // collapsed rail's icons link here too. They render the group's own children
  // as tiles, gated by the same navConfig rules as the rail, so they add no
  // reach: every tile is a route the user could already see in the sidebar.
  //
  // ADMIN_HR because these are the admin/HR navigation's groups. A manager or
  // employee never has a link to one and is bounced to /403 if they type it.
  //
  // Schedules' hub is /dashboard/schedules, listed with the rest of Schedules
  // below since that path predates this feature.
  { path: '/dashboard/organization', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/people', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/time', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/leave', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/payroll/overview', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/finance', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/talent', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/workplace', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/system', guarded: true, allowed: ADMIN_HR },

  // ── Landing and personal ──────────────────────────────────────────────────
  {
    path: '/dashboard',
    guarded: false,
    allowed: EVERYONE,
    // MANAGER holds this in the frontend matrix but not on the server: dashboard/payroll-summary and dashboard/turnover-stats answer 403.
    usableBy: ADMIN_HR,
  },
  { path: '/dashboard/profile', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/notifications', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/approvals', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/settings', guarded: false, allowed: EVERYONE },

  // ── People ────────────────────────────────────────────────────────────────
  // VIEW_EMPLOYEES: admin, hr, manager.
  // The statistics widget is now gated to ADMIN/HR in the page itself, matching
  // the backend's @Roles on /employees/statistics, so a MANAGER opening the
  // directory no longer 403s on it.
  { path: '/dashboard/employees', guarded: true, allowed: ADMIN_HR_MANAGER },
  // CREATE_EMPLOYEE: admin, hr only.
  { path: '/dashboard/employees/new', guarded: true, allowed: ADMIN_HR },
  // VIEW_DEPARTMENTS: admin, hr, manager.
  { path: '/dashboard/departments', guarded: true, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/departments/tree', guarded: false, allowed: ADMIN_HR_MANAGER },
  {
    path: '/dashboard/departments/change-requests',
    guarded: false,
    allowed: ADMIN_HR_MANAGER,
    // MANAGER holds this in the frontend matrix but not on the server: the change-request list answers 403.
    usableBy: ADMIN_HR,
  },
  // MANAGE_DEPARTMENTS: admin, hr.
  { path: '/dashboard/departments/new', guarded: true, allowed: ADMIN_HR },
  // Stricter than the server on purpose-by-accident: GET /branches admits
  // MANAGER, the client guard does not. The safe direction, and recorded rather
  // than assumed — see organization-branch.spec.ts.
  { path: '/dashboard/branches', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/branches/new', guarded: true, allowed: ADMIN_HR },
  // Unguarded, so anyone reaches the shell — but /teams and /departments answer
  // 403 to an employee, so only HR and above can actually use them.
  // ── The two unrelated "Teams" (finding P9) ────────────────────────────────
  // /dashboard/teams drives the ORG `Team` model via teamService. It is not in
  // the sidebar — the sidebar's "Teams" points at /dashboard/supervisor-teams
  // below, which is a different feature on a different service.
  //
  // `usableBy` includes MANAGER here because the Teams module has no branch and
  // no manager-department scoping at all (finding P1) — that is what the server
  // currently allows, NOT what it should. When P1 is fixed, MANAGER drops out of
  // usableBy and this comment goes with it.
  { path: '/dashboard/teams', guarded: false, allowed: EVERYONE, usableBy: ADMIN_HR_MANAGER },
  { path: '/dashboard/teams/new', guarded: false, allowed: EVERYONE, usableBy: ADMIN_HR_MANAGER },
  // Server refuses MANAGER too, despite the frontend matrix.
  // The supervisor/approval-chain teams — `Team` rows with type SUPERVISION,
  // reached through /supervisors/teams. No ProtectedRoute, and the server 403s
  // MANAGER, so a manager reaches a screen that can only fail (finding P24).
  { path: '/dashboard/supervisor-teams', guarded: false, allowed: EVERYONE, usableBy: ADMIN_HR },

  // ── Contracts and visas ───────────────────────────────────────────────────
  // VIEW_CONTRACTS / MANAGE_CONTRACTS: admin, hr.
  { path: '/dashboard/contracts', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/contracts/new', guarded: true, allowed: ADMIN_HR },
  // guarded:false is accurate but easy to misread: this screen does its own
  // inline role check and renders a "No access" PANEL instead of redirecting to
  // /403. It is the only denial in the app shaped that way (finding P4), so the
  // route-matrix's "guarded+disallowed => /403" rule deliberately does not
  // apply — people-termination.spec.ts asserts the panel instead.
  { path: '/dashboard/contracts/terminations', guarded: false, allowed: ADMIN_HR },
  { path: '/dashboard/visa-reports', guarded: true, allowed: ADMIN_HR },

  // ── Attendance ────────────────────────────────────────────────────────────
  // VIEW_ALL_ATTENDANCE: admin, hr, manager.
  //
  // The control case for this whole block: client and server AGREE here.
  // `VIEW_ALL_ATTENDANCE` and `GET /attendances/overview` both admit all three,
  // so `allowed` needs no `usableBy` narrowing. Every other attendance route
  // below diverges in some way, which is why this one is worth naming.
  { path: '/dashboard/attendance', guarded: true, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/attendance/corrections', guarded: false, allowed: EVERYONE },
  {
    path: '/dashboard/attendance/history',
    guarded: false,
    allowed: ADMIN_HR_MANAGER,
    // MANAGER holds this in the frontend matrix but not on the server:
    // `GET /attendances/report` is @Roles(ADMIN, HR_MANAGER) — confirmed at
    // attendances.controller.ts:186-187 — while /overview at :265-266 does
    // admit MANAGER. So the manager reaches the screen and its only data call
    // 403s. Asserted as a clean data-403 by attendance-logs.spec.ts, not as a
    // redirect: there is no ProtectedRoute on this route at all.
    usableBy: ADMIN_HR,
  },
  {
    path: '/dashboard/attendance/management',
    guarded: false,
    // No ProtectedRoute. The page renders an "HR/Admin only" BANNER and
    // enforces nothing client-side; the real gate is the server, where
    // POST /attendances/manual and /auto-mark-absent are both
    // @Roles(ADMIN, HR_MANAGER). So `allowed` here means "the roles that can
    // USE it", and a manager or employee reaching the shell is EXPECTED rather
    // than a defect — attendance-manager.spec.ts asserts they are refused
    // cleanly when they press the buttons.
    allowed: ADMIN_HR,
  },
  {
    path: '/dashboard/attendance/reports',
    guarded: false,
    allowed: ADMIN_HR_MANAGER,
    // Same server divergence as /history, plus a second, independent reason a
    // manager sees nothing: `fetchReport()` early-returns on `!user.employeeId`
    // (reports/page.tsx:53), and the summary table is additionally behind an
    // inline role check at :224.
    usableBy: ADMIN_HR,
  },
  {
    path: '/dashboard/attendance/face-management',
    guarded: false,
    // No guard. `GET /employees` admits MANAGER so the list itself loads for
    // them, but `GET /face-recognition/descriptors/:employeeId` is ADMIN/HR
    // (face-recognition.controller.ts:169-170), so opening a card is a clean
    // data-403. `allowed` stays ADMIN_HR and the matrix judges manager with
    // crashesOnly, which is the correct treatment.
    allowed: ADMIN_HR,
  },
  {
    path: '/dashboard/face-recognition',
    guarded: false,
    // WAS `allowed: ADMIN_HR`, and that was the TABLE being wrong rather than
    // the app. The sidebar links this screen for EMPLOYEE (Sidebar.tsx:277) and
    // MANAGER (:329), and the server agrees with the sidebar: /status,
    // /descriptors/me, POST /register and DELETE /descriptors/:id are all
    // @Roles(ADMIN, HR_MANAGER, MANAGER, EMPLOYEE). The old entry downgraded
    // two roles to crashes-only judgement on a self-service screen they are
    // meant to use every day (finding F1).
    allowed: EVERYONE,
  },
  { path: '/dashboard/my-attendance', guarded: false, allowed: EVERYONE },
  // Unguarded BY DESIGN: every role owns a calendar, and the API scopes
  // /calendar/my-calendar to the caller. The WRITE controls on it are gated
  // individually — create/bulk on CREATE_SCHEDULE and BULK_CREATE_SCHEDULES,
  // edit on EDIT_SCHEDULE, delete on DELETE_SCHEDULE (which nothing consulted
  // before Phase 3: delete rode on the edit grant).
  { path: '/dashboard/my-calendar', guarded: false, allowed: EVERYONE },

  // ── Schedules ─────────────────────────────────────────────────────────────
  // VIEW_ALL_SCHEDULES: admin, hr. The sidebar's Schedules group named
  // ['ADMIN','MANAGER'] until Phase 3; that array is never read by the nav
  // filter, and a MANAGER is refused by both screens AND by /calendar/*.
  //
  // The group's own href had no page.tsx, so typing it — or coming back to it
  // after a redirect — hit a Next 404. It became a client redirect to /overview
  // and is now the Schedules module hub, carrying the same guard either way:
  // the hub grants nothing, and /overview still applies VIEW_ALL_SCHEDULES.
  { path: '/dashboard/schedules', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/schedules/overview', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/schedules/shifts', guarded: true, allowed: ADMIN_HR },

  // ── Leave ─────────────────────────────────────────────────────────────────
  // VIEW_ALL_LEAVES: admin, hr, manager.
  //
  // These two were guarded by `<ProtectedRoute>` with no requiredPermission —
  // an authentication check only, so every signed-in user reached the
  // all-employees leave list and the pending-approvals queue. Now gated
  // properly. `/dashboard/leaves/[id]` is deliberately still open, because
  // /dashboard/my-leaves routes employees to it to read their OWN request.
  { path: '/dashboard/leaves', guarded: true, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/leaves/pending', guarded: true, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/leaves/balances', guarded: false, allowed: ADMIN_HR },
  // CREATE_LEAVE is held by everyone, but the screen turns itself away for
  // admin/HR — they approve rather than apply. Not a redirect, so unguarded.
  { path: '/dashboard/leaves/new', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/my-leaves', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/my-department', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/my-department/team-balances', guarded: false, allowed: EVERYONE },

  // ── Overtime ──────────────────────────────────────────────────────────────
  // VIEW_ALL_OVERTIME: admin, hr, manager.
  { path: '/dashboard/overtime', guarded: true, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/overtime/new', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/my-overtime', guarded: false, allowed: EVERYONE },

  // ── Payroll and banking ───────────────────────────────────────────────────
  // The payroll index is role-polymorphic: admins see runs, employees see their
  // own payslips. Guarded, but every role is allowed through.
  { path: '/dashboard/payroll', guarded: true, allowed: EVERYONE },
  // MANAGE_PAYROLL: admin, hr. These four were UNGUARDED until Phase 4 — the
  // server refused the data, but a manager or an employee rendered the chrome,
  // the stat cards and the action buttons, then fired requests that 403'd. The
  // permission existed and had simply never been applied to a route.
  { path: '/dashboard/payroll/manage', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/payroll/batches', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/payroll/approvals', guarded: true, allowed: ADMIN_HR },
  // MANAGE_SALARY_COMPONENTS: admin, hr.
  { path: '/dashboard/payroll/salary-structure', guarded: true, allowed: ADMIN_HR },

  // ── Payroll extensions ──────────────────────────────────────────────────
  //
  // Every one of these is behind a feature flag that ships OFF, so the sidebar
  // does not offer them and a signed-in user reaching the URL directly sees a
  // "switched off" panel rather than a broken screen. They are listed here for
  // the guard they DO have — the route table's job is who gets past
  // ProtectedRoute, which is unaffected by whether the feature is enabled.
  { path: '/dashboard/payroll/validate', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/payroll/settlements', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/payroll/transfers', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/payroll/grades', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/payroll/encashment', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/payroll/recoveries', guarded: true, allowed: ADMIN_HR },
  // ADMIN alone: a gratuity rule IS the calculation, so changing one re-prices
  // every future accrual and every settlement quoted from it.
  { path: '/dashboard/payroll/gratuity-rules', guarded: true, allowed: ['admin'] },
  // VIEW_ALL_PAYROLL: admin, hr.
  { path: '/dashboard/payroll/reports', guarded: true, allowed: ADMIN_HR },
  // ADMIN alone: a calendar decides which inputs are late for a whole branch.
  { path: '/dashboard/payroll/calendar', guarded: true, allowed: ['admin'] },
  // Self-service, so everyone signed in — it can only ever show your own figure.
  { path: '/dashboard/my-payroll/gratuity', guarded: true, allowed: EVERYONE },
  // ADMIN alone — narrower than the rest of banking, which admits HR too.
  //
  // These were the only two routes where ProtectedRoute has to deny an
  // AUTHENTICATED non-admin, which is why they were the only ones that exposed
  // the React #310 crash: the guard called `redirect()` during a Client
  // Component's render, abandoning it mid-flight. Now it navigates from an
  // effect, so denial reaches /403 like everywhere else.
  { path: '/dashboard/banks', guarded: true, allowed: ['admin'] },
  { path: '/dashboard/banks/config', guarded: true, allowed: ['admin'] },
  { path: '/dashboard/banks/branch-countries', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/banks/migrate', guarded: true, allowed: ADMIN_HR },

  // ── Money and claims ──────────────────────────────────────────────────────
  //
  // Two Finance screens are deliberately absent rather than forgotten:
  // `/dashboard/budgets/[id]` and `/dashboard/advance-loans/[id]` are DYNAMIC
  // routes, and this matrix only walks static paths — it has no id to open one
  // with. They are covered by the Finance journeys instead, which arrive at a
  // detail screen from the list that owns the record. `routes.test.ts` does not
  // count them as missing for the same reason.
  { path: '/dashboard/reimbursements', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/advance-loans', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/advance-loans/reports', guarded: false, allowed: ADMIN_HR },
  // The product catalogue decides what every future loan costs. The page is
  // not wrapped in <ProtectedRoute> — like its two siblings — so a non-admin
  // reaches the shell and is told the rule instead of being bounced.
  { path: '/dashboard/advance-loans/products', guarded: false, allowed: ADMIN },
  // Deciding a leaver's outstanding loans moves company money, so HR and ADMIN
  // only. Not <ProtectedRoute>-wrapped, like its siblings: a manager reaches
  // the shell and is told the rule.
  { path: '/dashboard/advance-loans/settlement', guarded: false, allowed: ADMIN_HR },
  // A borrower's own ledger. Open to everyone: the server answers with the
  // caller's own loans, and an account with no employee record is told so.
  { path: '/dashboard/my-loan-statement', guarded: false, allowed: EVERYONE },
  // Court orders take pay ahead of every loan, so HR and ADMIN only. Like its
  // loan siblings it is not <ProtectedRoute>-wrapped: a manager reaches the
  // shell and is told the rule.
  { path: '/dashboard/garnishments', guarded: false, allowed: ADMIN_HR },
  // The loan ledger. Readable by HR, changeable by ADMIN — the accounts decide
  // how company money is reported.
  { path: '/dashboard/accounting', guarded: false, allowed: ADMIN_HR },
  { path: '/dashboard/travel', guarded: true, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/my-travel', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/budgets', guarded: true, allowed: ADMIN_HR },

  // ── People ops ────────────────────────────────────────────────────────────
  { path: '/dashboard/appraisal', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/training', guarded: true, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/my-training', guarded: false, allowed: EVERYONE },
  { path: '/dashboard/rewards', guarded: false, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/disciplines', guarded: false, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/rewards-disciplines', guarded: false, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/grievances', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/my-grievances', guarded: false, allowed: EVERYONE },

  // ── Assets and documents ──────────────────────────────────────────────────
  // A MANAGER can USE this screen, not merely reach it: GET /assets, GET /branches
  // and GET /employees all admit MANAGER, and GET /library-items carries no
  // @Roles at all. The `usableBy: ADMIN_HR` this entry used to carry was stale in
  // the one direction that hides a hole — it told the suite a 403 was expected,
  // so nothing checked. The manager's WRITE denials are asserted in
  // workplace-assets.spec.ts instead, which is where they are actually enforced.
  { path: '/dashboard/assets', guarded: true, allowed: ADMIN_HR_MANAGER },
  // The three ESS screens were server-scoped only until R17 was fixed — every
  // other dashboard route carried a `ProtectedRoute` and these did not. They are
  // now wrapped BARE: authentication and a coherent signed-out experience, with
  // no role narrowing, because every role legitimately opens them and sees only
  // their own rows.
  { path: '/dashboard/my-assets', guarded: true, allowed: EVERYONE },
  { path: '/dashboard/letters', guarded: true, allowed: ADMIN_HR },
  { path: '/dashboard/my-letters', guarded: true, allowed: EVERYONE },
  { path: '/dashboard/my-documents', guarded: true, allowed: EVERYONE },

  // ── Work tracking ─────────────────────────────────────────────────────────
  // VIEW_PROJECTS is held by every role.
  { path: '/dashboard/projects', guarded: true, allowed: EVERYONE },
  // CREATE_PROJECT: admin, hr, manager.
  // R16: POST /projects admits MANAGER, and so do the three lists this page
  // loads (employees, departments, teams). `usableBy: ADMIN_HR` claimed the
  // server would refuse a manager here and it does not.
  { path: '/dashboard/projects/new', guarded: true, allowed: ADMIN_HR_MANAGER },
  { path: '/dashboard/timesheets', guarded: true, allowed: EVERYONE },
  { path: '/dashboard/timesheets/new', guarded: true, allowed: EVERYONE },
  { path: '/dashboard/my-timesheets', guarded: true, allowed: EVERYONE },
  { path: '/dashboard/work-logs', guarded: true, allowed: EVERYONE },
  { path: '/dashboard/my-team', guarded: false, allowed: EVERYONE },

  // ── Operator ──────────────────────────────────────────────────────────────
  // MANAGE_USERS is ADMIN-only and the only genuinely admin-only screen.
  { path: '/dashboard/audit-logs', guarded: false, allowed: ['admin'] },
  // Wrapped in ProtectedRoute, so the client guard really does redirect a
  // manager or employee to /403 rather than leaving the API to refuse.
  { path: '/dashboard/settings/documents', guarded: true, allowed: ['admin', 'hr'] },
  { path: '/dashboard/settings/documents/letterhead', guarded: true, allowed: ['admin', 'hr'] },
  // COPILOT_ENABLED=false in .env.test (it needs an LLM key), so
  // /copilot/conversations answers 503 by design. Not an app defect.
  {
    path: '/dashboard/copilot',
    guarded: true,
    allowed: ADMIN_HR,
    featureDisabled: 'COPILOT_ENABLED=false in the test environment',
  },
];

/** Roles that can actually load the screen's data. */
export function usableBy(route: RouteSpec): Role[] {
  return route.usableBy ?? route.allowed;
}

/** Routes a given role is expected to be able to open. */
export function routesFor(role: Role): RouteSpec[] {
  return ROUTES.filter((r) => !r.skip?.includes(role));
}
