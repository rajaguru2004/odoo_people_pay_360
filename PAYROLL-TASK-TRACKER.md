# Payroll module — task tracker

**Plan:** `payroll-migration-plan.md`
**Source (read-only):** `/home/suryaguru/StudioProjects/CRM/hrm_branch2/human-resource-management`
**Target:** this repo.
**Goal:** base payroll end-to-end. No settings-driven/advanced features (EOSB, WPS,
loans, garnishments, encashment, batches, run versioning, statutory calculators).

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked · `[-]` dropped (reason given)

---

## Phase 0 — Schema (additive only, `// PAYROLL` section)

- [x] 0.1 `PayrollRun` + `notes`, `approvedById`, `rejectionReason`, `calculatedAt`, `paidAt`, `employeeCount`
- [x] 0.2 `Payslip` + `payslipNumber @unique`, `workDays`, `paidDays`, `lopDays`, `totalEmployerCost`
- [x] 0.3 `PayslipLine` + `code @db.VarChar(32)`
- [x] 0.4 Schema comments: "a payslip is its own history", "employer contributions recorded never paid"
- [x] 0.5 `npm run db:push` green, `prisma generate` client types updated

## Phase 1 — Pure layer (no Prisma, no Nest) — port from HRM

- [x] 1.1 `src/payroll/payroll-period.util.ts` — `periodFor`, `eachDayKey`, `countWorkingDays(pred)`
- [x] 1.2 `src/payroll/payroll-period.util.spec.ts`
- [x] 1.3 `src/payroll/payroll-calc.util.ts` — adapted from HRM `payroll-earnings.util.ts`
      - gross = Σ EARNING · lopDays = max(0, workDays−paidDays)
      - lopAmount = workDays>0 ? gross×lopDays/workDays : 0 (one DEDUCTION line, code `LOP`)
      - deductions = Σ DEDUCTION + lop · net = max(0, gross−deductions)
      - employerCost = Σ EMPLOYER_CONTRIBUTION, excluded from all three
- [x] 1.4 `payroll-calc.util.spec.ts` — workDays 0, LOP prorates ALL earnings, LOP capped at
      gross, net floors at 0, round2/3dp residual into largest line, deterministic order,
      no structure → no payslip
- [x] 1.5 `src/payroll/payroll-preflight.rules.ts` — ported from HRM file of same name:
      `resolvePopulation`, `resolveAttendanceCoverage`, `resolveStructures`, `resolveContracts`.
      Return findings, never throw.
- [x] 1.6 `payroll-preflight.rules.spec.ts`

## Phase 2 — Backend modules

### 2A `src/salary-components/` (the "Salary Rules" screen backend)
- [x] 2A.1 dto/ (create, update, query)
- [x] 2A.2 service — code uppercase-normalised + unique, no delete, `deactivate`
- [x] 2A.3 controller — `GET /` `GET /:id` `POST` `PATCH /:id` `POST /:id/deactivate`
- [x] 2A.4 module + registered in `app.module.ts`
- [x] 2A.5 `salary-components.service.spec.ts`

### 2B `src/salary-structures/`
- [x] 2B.1 dto/ (create w/ lines, update, query)
- [x] 2B.2 service — one txn create/replace-lines; ≥1 EARNING; no dup component (409 sentence);
      currency matches contract; DELETE refused once employee has a payslip
- [x] 2B.3 controller — list · `employee/:employeeId` · `:id` · POST · PATCH · DELETE
      (literal routes before `:id`)
- [x] 2B.4 module + app.module registration
- [x] 2B.5 `salary-structures.service.spec.ts`

### 2C `src/payroll/` — runs, payslips, hub, reports
- [x] 2C.1 module: controller order `[PayrollHub, PayrollReports, PayrollRuns, Payslips]`,
      imports `AttendancesModule` (uses exported `AttendanceCalendarService`)
- [x] 2C.2 dto/ create-run, preflight, reject, list queries, hub query (`months=6|12`, else 400)
- [x] 2C.3 `payroll-runs.service.ts` — lifecycle DRAFT→CALCULATED→APPROVED→PAID,
      CANCELLED from anything but PAID, reject→DRAFT+reason
- [x] 2C.4 `calculate()` in ONE `$transaction`: delete prior payslips → insert new + lines →
      stamp totals/employeeCount/calculatedAt → CALCULATED
- [x] 2C.5 `approve()` conditional `updateMany` with expected status in `where` (race-safe)
- [x] 2C.6 preflight endpoint `POST /payroll-runs/preflight` (writes nothing, declared before `:id`)
- [x] 2C.7 `payroll-runs.controller.ts` — full role matrix; approve/reject/mark-paid ADMIN only
- [x] 2C.8 `GET /payroll-runs/:id/export` — `.xlsx` via `exceljs`
- [x] 2C.9 `payslips.service.ts` + controller — `/payslips/my`, `/my/:id` before `:id`;
      self-or-privileged narrowing (`assertMayRead` idiom); self-service sees APPROVED/PAID only
- [x] 2C.10 `payroll-hub.service.ts` + `PayrollHubController` — `GET /payroll/hub-summary?months=6|12`
      (money = APPROVED|PAID, rate null never 0, counts counted in DB, server-formatted labels,
      capped names sample, unoffered window → 400)
- [x] 2C.11 `payroll-reports.service.ts` + controller — `register`, `cost?groupBy=`, `statutory`, `ytd/:employeeId`
- [x] 2C.12 unit specs: runs, payslips, hub
- [x] 2C.13 `main.ts` `.addTag('Payroll', …)`

## Phase 3 — Frontend (UI transferred from HRM)

### 3A plumbing
- [x] 3A.1 `types/payroll.ts`, `types/payslip.ts`, `types/salaryStructure.ts`, `types/payrollHub.ts`
- [x] 3A.2 services: `payrollRunService`, `payslipService`, `salaryComponentService`,
      `salaryStructureService`, `payrollReportService`
- [x] 3A.3 hooks + key objects: `usePayrollRuns`/`payrollKeys`, `usePayslips`/`payslipKeys`,
      `useSalaryStructures`/`salaryStructureKeys`, `useSalaryComponents`, `usePayrollHub`
- [x] 3A.4 `utils/payrollTotals.ts` — single pure `runTotals()` cards + table share

### 3B components (`components/payroll/`) — ported from HRM
- [x] 3B.1 `RunSummaryCards.tsx` (HRM)
- [x] 3B.2 `PayrollRunTable.tsx` (HRM)
- [x] 3B.3 `PayslipLines.tsx` (HRM)
- [x] 3B.4 `FindingGroup.tsx` + `FindingRow.tsx` → `PreflightFindings.tsx` (HRM)
- [x] 3B.5 `PayrollRunForm.tsx`
- [x] 3B.6 `SalaryStructureForm.tsx`, `SalaryComponentForm.tsx`
- [x] 3B.7 `hub/` panels from HRM (`MoneyComposition`, `RunPipelineDonut`, `ProcessingCoverage`)
      minus Oman-compliance / feature-gated ones

### 3C routes
- [x] 3C.1 `app/dashboard/payroll/page.tsx` — hub on `ModuleLandingPage`
- [x] 3C.2 `payroll/runs/page.tsx`
- [x] 3C.3 `payroll/runs/new/page.tsx` — period → pre-flight → generate
- [x] 3C.4 `payroll/runs/[id]/page.tsx` — totals, payslip table, findings, approve/reject
- [x] 3C.5 `payroll/payslips/page.tsx`
- [x] 3C.6 `payroll/payslips/[id]/page.tsx` + `@media print` + `window.print()`
- [x] 3C.7 `payroll/salary-components/` page + `new` + `[id]`
- [x] 3C.8 `payroll/structures/` page + `new` + `[id]`
- [x] 3C.9 `payroll/reports/page.tsx` — tabs + Excel download (`responseType: 'blob'`)
- [x] 3C.10 `app/dashboard/my-payslips/page.tsx` + `[id]/page.tsx`

### 3D shared-file edits
- [x] 3D.1 `navConfig.ts` — `hubRoles: [ADMIN, HR_MANAGER, PAYROLL_OFFICER]` + children on admin
      tree; **re-point MANAGER + EMPLOYEE payroll entry at `/dashboard/my-payslips`**
- [-] 3D.2 `messages/{en,ar}/index.ts` — register `payroll` namespace.
      **Dropped, deliberately.** The hub reads `moduleLanding.payroll` (added, en+ar) and the
      rail reads `sidebar.*` (added, en+ar). The other payroll screens follow the
      `contracts`/`employees` precedent and are untranslated, so a `payroll` namespace would be
      registered and unused. Add it with the screens, not ahead of them.
- [x] 3D.3 `messages/{en,ar}/sidebar.json` — child labels
- [x] 3D.4 house rules pass: `formatDateOnly`, `formatCurrency`, `apiErrorMessage`,
      logical CSS (`ps-*`/`me-*`), `rtl:rotate-180`, string form fields in zod

## Phase 4 — Seed

- [x] 4.1 `seedSalaryStructures(employees)` after `seedContracts` — upsert on `employeeId`;
      BASIC 60% / HRA 25% / TRANSPORT 10% / OTHER_ALLOW 5% / SOCIAL_SEC_EE 7% of basic /
      SOCIAL_SEC_ER 10.5% of basic; fixed amounts computed at seed time
- [x] 4.2 one employee deliberately WITHOUT a structure (gives pre-flight a real finding)
- [x] 4.3 `seedPayrollRuns(employees)` — PAID (2 months back), APPROVED (last month),
      CALCULATED (awaiting approval); amounts from the real calculator
- [x] 4.4 calls wired into `main()`; `npm run db:seed` idempotent across two runs

## Phase 5 — Tests

- [x] 5.1 backend unit: calc · preflight · period · runs · payslips · hub · structures · components
- [x] 5.2 `apps/backend/test/payroll.e2e-spec.ts` — lifecycle, role matrix, envelope,
      `forbidNonWhitelisted`, officer refused approve (403), employee refused another's payslip (403)
- [x] 5.3 frontend unit `utils/payrollTotals.test.ts`
- [x] 5.4 component tests: run detail · payslip detail · structure form · hub (null → em dash)
- [ ] 5.5 Playwright: `payroll.admin-payroll.spec.ts` · `payroll-approval.admin.spec.ts` ·
      `salary-structures.admin-payroll.spec.ts` · `payroll-hub.admin-payroll.spec.ts` ·
      `payslips.employee.spec.ts` · `payroll.hr.spec.ts`

## Phase 6 — Docs

- [x] 6.1 `docs/payroll-walkthrough.md`
- [x] 6.2 `docs/interconnections-payroll.md` (+ note that `interconnections-schedules.md` §7.6
      needs updating by that module's owner)
- [x] 6.3 move this plan to `docs/payroll-migration-plan.md`, status line updated

## Defects found and fixed during verification

- **`GET /payslips/employee/:ownId` leaked unsettled payslips.** `findByEmployee`
  passed `assertMayRead` and then listed with no run-status filter, so an employee
  read their own DRAFT/CALCULATED payslips — the thing `findMine` and `findOne`
  exist to prevent. `findAll` now takes `settledOnly`, passed by the caller so a
  payroll role still sees the drafts. Two regression tests.
- **The trend chart's y-axis was upside down on BOTH the Payroll and Schedules
  hubs.** `utils/chartAxis.ts` returned ticks in display order while
  `BarOverviewChart` reverses them itself, so the two cancelled: 0 at the top and
  the bars hanging downwards. Fixed in the shared util (its contract is the
  chart's own `yAxisTicks` default, which is ascending) plus its test. **This
  changes the Schedules hub's chart too — it was drawing the same way.**
- **`RunSummaryCards` named the wrong total in its drift banner.** It fell back to
  the gross drift but always quoted the stored NET, printing a figure identical to
  the card beside it — or `OMR 0.000` when the run carried no net. Two regression
  tests.
- **A new `AttendanceStatus` would have been silently paid.** `UNPAID_WEIGHT` was a
  `Partial<Record<…>>` with `?? 0`; it is now `satisfies Record<AttendanceStatus,
  number>`, so an unclassified status is a compile error rather than free pay.

## Verification gates

- [x] V1 `npm run db:push` + `npm run db:seed`
- [x] V2 `npm run typecheck` (both apps)
- [x] V3 `npm run lint`
- [x] V4 `npm test` (calculator spec first)
- [x] V5 `npm run e2e:up` + `bash scripts/test-api.sh`
- [ ] V6 `npm run e2e:db reset` + `npm run test:e2e`
- [x] V7 manual end-to-end walk (plan §Verification steps 1–10)

---

## Explicitly OUT (base system only)

WPS wage files · gratuity / EOSB · advances & loans · garnishments · reimbursements ·
leave encashment · carry-forward · run versioning / unlock-relock · payroll batches ·
payroll calendar periods & cut-off · off-cycle / bonus / final-settlement run types ·
statutory tax & social-insurance calculators · bank transfer files · notifications ·
approval engine · audit logging · `PayrollFeaturesService` / feature flags ·
percentage-of-basic salary rules (fixed amounts only, matching HRM's live engine).

## Blocked upstream

Leave & Overtime not implemented → no `LeaveRequest` / `OvertimeRequest`. LOP reads
attendance only. HRM's `payroll-edge-leave` / `payroll-edge-overtime` specs stay deferred.
