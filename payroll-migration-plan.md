# Build the Payroll module in People Pay 360

**Status:** plan, not yet implemented.
**Rules in force:** `D:\Odoo-Final\AGENT_INSTRUCTIONS.md` (rules 1–7).
**Source:** `D:\Odoo-Final\human-resource-management` · **Target:** `D:\Odoo-Final\odoo_people_pay_360`

---

## Context

People Pay 360 is being built module by module from the HRM checkout. Organisation,
People, Time & Attendance and Schedules are live. This branch owns **Payroll**: the
module that turns a contracted rate and a month of attendance into a payslip.

Two findings reshape the job from "port a module" into "finish a foundation".

**1. The payroll data model already exists in the target, and nothing uses it.**
`apps/backend/prisma/schema.prisma:763-870` already defines `SalaryComponent`,
`SalaryStructure`, `SalaryStructureLine`, `PayrollRun`, `Payslip` and `PayslipLine`
with `PayrollRunStatus` and `SalaryComponentType`, written in house style with the
payslip-denormalisation rationale already in the docblocks.
`apps/backend/prisma/seed.ts:161-169` already seeds seven salary components.
`apps/frontend/utils/permissions.ts` already defines the five payroll permission
strings per role — including the comment that a `PAYROLL_OFFICER` runs payroll but
must not approve it. `components/layout/navConfig.ts` already carries a `payroll`
nav group. There is **no backend module, no frontend route and no test**.

So the foundation was laid deliberately and left for this branch. Building onto it —
rather than porting HRM's shapes over the top — is what makes the result read as
written here rather than migrated.

**2. HRM has no salary-structure or salary-rule engine to port.** Searching HRM for
`SalaryStructure`, `SalaryRule`, `StructureAssignment` returns nothing, and there is
no expression evaluator anywhere in it (`eval`, `new Function`, `expr-eval`, `mathjs`
— no hits). Its payroll is 15,470 lines across six folders built on
`Payroll` / `PayrollItem` / `PayrollItemLine`, where a "structure" is just the set of
an employee's active fixed-amount `SalaryComponent` rows. `GradeSalaryComponent` does
carry `valueType: FIXED | PERCENT_OF_BASIC`, but it is a **dead template** — its own
schema comment says "A TEMPLATE, never an input to payroll", and the only code that
reads it is `grades.service.ts`'s own CRUD. Most of HRM's bulk is the feature set
excluded here: WPS, gratuity, loans, garnishments, reimbursements, encashment,
carry-forward, run versioning, unlock/relock, batches, run types.

**Outcome:** a payroll officer opens the Payroll hub, starts a run for a period, sees
a pre-flight that names every employee the run cannot safely pay, generates payslips
computed from each employee's salary structure and their attendance, and hands it to
an admin to approve. An employee sees their own payslips and nobody else's.

---

## Decisions locked

| Question | Decision |
|---|---|
| Structure shape | **Keep the target's per-employee `SalaryStructure`.** No template model, no assignment record. |
| Salary rules | **Match HRM.** HRM's live engine is fixed amounts with `BASIC` vs allowances — which is exactly what `SalaryStructureLine.amount` already is. **No `valueType` column, no percentage-of-basic, no formulas.** |
| Pay inputs | **Structure + attendance LOP.** Earnings from the structure, unpaid absence prorated out. |
| Payslip print | In scope, as a print-styled route. No PDF dependency added. |
| Excel export | In scope via `exceljs` — already a backend dependency, currently unused. |
| Self-service payslips | In scope — `/dashboard/my-payslips`. First `my-*` route in the repo. |
| Settings-driven features | **Out.** No `PayrollFeaturesService`, no feature flags, no statutory calculators. |

### Where "Salary Rules" and "Structure assignments" land

Both were on the screen list; neither is a separate model under the decisions above,
so each maps onto a real screen rather than being dropped:

- **Salary Rules → the Salary Components catalogue.** The rule metadata in this
  design lives on the component: `type` (earning / deduction / employer
  contribution), `isTaxable`, `isGratuityBase`, `sequence`, `isActive`. That screen
  is the rule editor. This is faithful: HRM's engine reads exactly these properties
  and nothing else.
- **Structure assignments → the structure list.** With one structure per employee,
  "assigning" is creating that employee's structure. The list is the assignment
  register: employee, currency, effective-from, line count, gross.

**Flag for approval:** percentage-based lines (`HRA = 40% of BASIC`) are therefore
**not** supported — every line is an absolute amount per employee. That matches HRM's
live behaviour, but it is the one place where "match HRM" and "what a payroll clerk
expects" differ. Adding it later is one nullable enum column plus one branch in the
calculator; the plan does not include it. Say so at approval if it should.

---

## Scope

**Build:** `salary-components/` · `salary-structures/` · `payroll/` (runs,
calculation, pre-flight, approval, hub, reports) · `payslips/` · the frontend for all
of it · seed data · unit, component, API and Playwright tests · the two docs.

**Do not build — record as a seam in `docs/interconnections-payroll.md`:** WPS wage
files, gratuity / end-of-service, advances and loans, garnishments, reimbursements,
leave encashment, carry-forward, run versioning and unlock, payroll batches, payroll
calendar periods and cut-off enforcement, off-cycle / bonus / final-settlement run
types, statutory tax and social-insurance calculators, bank transfer files,
notifications, the approval engine, audit logging.

**Other developers' modules — read, never edit:** `attendances/`, `holidays/`,
`contracts/`, `employees/`, `branches/`, `departments/`, `teams/`, `work-schedules/`,
`schedules/`, `system-settings/`, `auth/`.

**Blocked upstream:** Leave & Overtime is an approved but **unimplemented** plan
(`D:\Odoo-Final\leave-overtime-migration-plan.md`), so there is no `LeaveRequest` and
no `OvertimeRequest` model. Paid-leave classification and overtime tiers are seams.
LOP reads attendance only. HRM's `payroll-edge-leave` and `payroll-edge-overtime`
specs, which that plan deferred to this one, stay deferred with a recorded reason —
they assert against models that do not exist.

---

## What already exists and must be reused

Do not rebuild any of these.

| Asset | Path |
|---|---|
| The six payroll models + two enums | `apps/backend/prisma/schema.prisma:44-56, 763-870` |
| Seven seeded salary components | `apps/backend/prisma/seed.ts:161-169, 224-232` |
| `Principal`, `JwtAuthGuard`, `RolesGuard`, `@Roles`, `@CurrentUser` | `src/auth/`, `src/common/decorators/` |
| `paginated()`, `resolvePagination()` | `src/common/utils/pagination.util.ts` |
| `AttendanceCalendarService` — `configFor`, `branchConfigs`, `holidayIndex`, `holidayOn`, **`isBranchWorkingDay`**, `employeeContext`, `companyTimezone` | `src/attendances/attendance-calendar.service.ts` — **already exported** by `AttendancesModule`, so payroll imports the module and touches nothing |
| `toDayKey`, `dayKeyToDate`, `parseDayKey`, `round2`, `rate`, `isWeeklyOff`, `DAY_KEY_PATTERN` | `src/attendances/attendance-calendar.util.ts` |
| Self-or-privileged read narrowing (`assertMayRead`) | `src/attendances/attendances.service.ts` |
| Two-controller module ordering | `src/contracts/contracts.module.ts` |
| Transactional both-or-neither write | `src/contracts/contracts.service.ts` → `renew()` |
| Module-landing kit: `ModuleLandingPage`, `KpiRow`/`StatCard`, `AttentionStrip`, `ModuleNavTiles`, `primitives` | `apps/frontend/components/module-landing/` |
| `formatCurrency` (decimals from the currency), `formatDateOnly` (no zone shift) | `apps/frontend/utils/formatters.ts`, `utils/formatDate.ts` |
| `apiErrorMessage()` — the axios interceptor rejects with a FLAT object | `apps/frontend/utils/apiError.ts` |
| Blob passthrough for the Excel download | `apps/frontend/lib/axios.ts` (`responseType === 'blob'` returns the response) |
| The five payroll permission strings, already role-mapped | `apps/frontend/utils/permissions.ts` |
| Page → hook → service → types + `<entity>Keys` | `app/dashboard/contracts/page.tsx`, `hooks/useContracts.ts`, `services/contractService.ts` |

---

## Phase 0 — Schema

`apps/backend/prisma/schema.prisma`. **Additive only, and only inside the `// PAYROLL`
section this module owns.** No enum changes, no changes to `Employee`, no changes to
`SalaryComponent` / `SalaryStructure` / `SalaryStructureLine`.

**`PayrollRun`** — `notes String? @db.Text`, `approvedById String? @map("approved_by_id") @db.Uuid`,
`rejectionReason String? @map("rejection_reason") @db.Text`,
`calculatedAt DateTime? @map("calculated_at") @db.Timestamp(6)`,
`paidAt DateTime? @map("paid_at") @db.Timestamp(6)`,
`employeeCount Int @default(0) @map("employee_count")`.

**`Payslip`** — `payslipNumber String @unique @map("payslip_number") @db.VarChar(32)`,
`workDays Int @default(0) @map("work_days")`,
`paidDays Decimal @default(0) @map("paid_days") @db.Decimal(5, 2)`,
`lopDays Decimal @default(0) @map("lop_days") @db.Decimal(5, 2)`,
`totalEmployerCost Decimal @default(0) @map("total_employer_cost") @db.Decimal(18, 3)`.

**`PayslipLine`** — `code String @db.VarChar(32)`. A stable machine key (`BASIC`,
`HRA`, `LOP`) that reports and the UI join on. Needed because `componentId` is
nullable — the LOP line has no component behind it — and because the existing
docblock already forbids resolving anything through the component at display time.

Two invariants worth stating in the schema comments, because they are the reason the
existing design needs no history table:

- **A payslip is its own history.** `SalaryStructure.employeeId` is `@unique`, so a
  pay rise overwrites the structure. That loses nothing, because `PayslipLine`
  snapshots `code`, `label`, `type` and `amount` at generation. HRM needed
  append-only `SalaryComponent` rows precisely because its payslip did not itemise;
  this one does.
- **Employer contributions are recorded, never paid.** `SalaryComponentType` has
  three values. `EMPLOYER_CONTRIBUTION` lines are stored on the payslip and summed
  into `totalEmployerCost`, and are excluded from `grossPay`, `totalDeductions` and
  `netPay`. HRM has no such concept, so this is ours to get right and to test.

Applied with `npm run db:push` — the repo has no migrations directory and every
script uses `prisma db push`. No raw SQL needed; every constraint here is expressible.

---

## Phase 1 — The pure layer (no Prisma, no Nest)

Three files, each with a spec beside it. These are ported from HRM in substance and
must be green before anything above them is trusted.

**`src/payroll/payroll-period.util.ts`** — the period and its working days.
`periodFor(month, year)` → `{ periodStart, periodEnd }` as date-only day keys;
`eachDayKey(start, end)`; `countWorkingDays(dayKeys, isWorking)` — the predicate is
injected so the util stays pure and the caller supplies
`AttendanceCalendarService.isBranchWorkingDay`. Date-only throughout: a period
boundary put through an instant parse is the previous day west of Greenwich.

**`src/payroll/payroll-calc.util.ts`** — the money engine, adapted from HRM's
`payroll-earnings.util.ts` to the target's line-first model. Input is the structure's
lines plus `workDays` and `paidDays`; output is the payslip's lines and totals.

```
gross            = Σ EARNING lines                       (full contracted amount)
lopDays          = max(0, workDays − paidDays)
lopAmount        = workDays > 0 ? gross × lopDays / workDays : 0     ← one DEDUCTION line, code LOP
totalDeductions  = Σ DEDUCTION lines + lopAmount
netPay           = max(0, gross − totalDeductions)
employerCost     = Σ EMPLOYER_CONTRIBUTION lines         ← excluded from all three above
```

Rules the spec must pin, each one a real failure mode HRM records:

- `workDays === 0` yields no LOP rather than a division by zero.
- LOP prorates the **whole** earning set, allowances included — HRM's MONTHLY branch
  divides `fullRate`, not `basicRate`.
- LOP is capped at gross, and net floors at zero. HRM's money-invariant spec asserts
  a negative net is never persisted.
- Every persisted figure is rounded to three decimals, and the rounding residual is
  absorbed into the largest line of its bucket so `Σ lines == the total exactly`.
  HRM enforces this in code with a tolerance check rather than a DB trigger; do the
  same, and throw if the residual exceeds `0.001 × lineCount`.
- Line order is deterministic: by `sequence`, then by `code`. Two runs of the same
  input produce byte-identical lines.
- An employee with no structure produces no payslip at all — never a zero one.

**`src/payroll/payroll-preflight.rules.ts`** — ported from HRM's file of the same
name, whose design is the point: these functions **return findings, never throw**, and
the same functions back both the pre-flight endpoint and generation's own guards, so
the pre-flight cannot say "ready" about a run that generation then refuses.

- `resolvePopulation` — who the run found, which requested ids matched nobody, and
  which of the two empty cases it is (`NO_EMPLOYEES` vs `ALL_UNMATCHED`).
- `resolveAttendanceCoverage` — who has no attendance in the period, and separately
  whether **nobody** does. The run-level case is the expensive one: with no attendance
  at all, LOP is zero for everyone and the run silently pays a full month against a
  period that was never processed. That is a BLOCKER.
- `resolveStructures` — who has no salary structure, or one with no earning line.
- `resolveContracts` — who has no `ACTIVE` contract.

Findings are `{ code, severity: 'BLOCKER' | 'WARNING', employeeId?, employeeName?, message }`.

---

## Phase 2 — Backend modules

Three modules, registered explicitly in `app.module.ts`.

### `src/salary-components/` — the catalogue (the "Salary Rules" screen's backend)

`GET /salary-components` (list, filters `type`, `isActive`, `search`, paginated) ·
`GET /salary-components/:id` · `POST` · `PATCH /:id` · `POST /:id/deactivate`.

No delete. A component behind a payslip line must keep resolving, and `PayslipLine`
already declares `onDelete: SetNull` for exactly that reason — deactivation is the
house idiom (users deactivate, employees terminate, contracts supersede). `code` is
uppercase-normalised and unique.

### `src/salary-structures/` — one per employee

`GET /salary-structures` (list, `search`, `branchId`, `departmentId`, paginated —
this is the Structure list / assignment register) ·
`GET /salary-structures/employee/:employeeId` · `GET /salary-structures/:id` ·
`POST` (structure + its lines in one transaction) · `PATCH /:id` (replace the whole
line set in one transaction) · `DELETE /:id` (refused once the employee has any
payslip).

Guards: `@Roles(ADMIN, PAYROLL_OFFICER)` to write, plus `HR_MANAGER` to read.
Validation: at least one `EARNING` line; no duplicate component (the `@@unique`
already exists, but answer 409 with a sentence rather than a Prisma error);
`currency` must match the employee's contract currency.

### `src/payroll/` — runs, payslips, hub, reports

Controllers registered **in this order**, because literal paths must be declared
before `:id` siblings and, where they live on another controller, that controller must
come first in the array:

```ts
controllers: [
  PayrollHubController,      // GET /payroll/hub-summary
  PayrollReportsController,  // GET /payroll/reports/*
  PayrollRunsController,     // /payroll-runs
  PayslipsController,        // /payslips
],
```

**Runs — `/payroll-runs`**

| Route | Roles | Notes |
|---|---|---|
| `GET /payroll-runs` | ADMIN · HR_MANAGER · PAYROLL_OFFICER | paginated, filter `status`, `year` |
| `POST /payroll-runs/preflight` | ADMIN · PAYROLL_OFFICER | writes nothing; **declared before `:id`** |
| `GET /payroll-runs/:id` | ADMIN · HR_MANAGER · PAYROLL_OFFICER | run + payslip summary rows |
| `POST /payroll-runs` | ADMIN · PAYROLL_OFFICER | `{ month, year, employeeIds? }` → DRAFT |
| `POST /payroll-runs/:id/calculate` | ADMIN · PAYROLL_OFFICER | generates payslips → CALCULATED |
| `POST /payroll-runs/:id/approve` | **ADMIN only** | → APPROVED |
| `POST /payroll-runs/:id/reject` | **ADMIN only** | `{ reason }` → back to DRAFT |
| `POST /payroll-runs/:id/mark-paid` | **ADMIN only** | APPROVED → PAID |
| `POST /payroll-runs/:id/cancel` | ADMIN · PAYROLL_OFFICER | anything but PAID → CANCELLED |
| `DELETE /payroll-runs/:id` | ADMIN | DRAFT only |
| `GET /payroll-runs/:id/export` | ADMIN · HR_MANAGER · PAYROLL_OFFICER | `.xlsx` via `exceljs` |

The role split is not invented — it is read off `utils/permissions.ts`, where
`PAYROLL_OFFICER` holds `MANAGE_PAYROLL` but deliberately **not** `APPROVE_PAYROLL`.
HRM enforces the same split (approve / reject are ADMIN-only there too). Mirroring it
server-side is what stops the rail offering a button the server refuses — the defect
`docs/MIGRATION.md` §8 already records once.

Lifecycle mapped onto the **existing** `PayrollRunStatus`, so the enum is untouched:
`DRAFT → CALCULATED → APPROVED → PAID`, with `CANCELLED` reachable from anything but
`PAID`, and reject sending `CALCULATED` back to `DRAFT` with a reason. Recalculation
is allowed while `DRAFT` or `CALCULATED` and refused after that.

`calculate()` runs in **one `$transaction`**: delete this run's previous payslips,
insert the new ones with their lines, stamp `totalGross` / `totalNet` /
`employeeCount` / `calculatedAt` and set `CALCULATED`. Half a recalculation is worse
than none. `approve()` uses the conditional-update idiom (`updateMany` with the
expected status in the `where`) rather than read-then-write, so two approvals racing
cannot both win — HRM measured that race happening 8 times out of 8.

Period is stored as `periodStart` / `periodEnd` date-only, and `@@unique([periodStart,
periodEnd])` already prevents a duplicate run for a period. HRM needed a raw
expression index only because its runs were batch- and branch-scoped; ours are not,
so the Prisma constraint is sufficient.

**Payslips — `/payslips`**

`GET /payslips/my` (own, any authenticated role — **declared before `:id`**) ·
`GET /payslips/my/:id` · `GET /payslips` (all, privileged, filter `runId`,
`employeeId`, paginated) · `GET /payslips/:id` (privileged, or own — narrowed in the
service against `@CurrentUser`, the `attendances` idiom, because whether the answer is
allowed depends on whose record it is and a decorator cannot see that) ·
`GET /payslips/employee/:employeeId`.

Self-service reads see only `APPROVED` and `PAID` runs. An employee must not read a
draft figure that is still being corrected.

**Hub — `GET /payroll/hub-summary?months=6|12`** (ADMIN · HR_MANAGER ·
PAYROLL_OFFICER). One request, following the rules the three existing hubs share:

- **Money means APPROVED or PAID.** This is HRM's "money means LOCKED" rule carried
  over; every money figure filters to those two statuses so the hub and the reports
  can never disagree.
- A rate is `null`, never `0`, when there was nothing to divide by; the frontend
  renders `null` as an em dash.
- Counts are counted in the database, never taken from a page length.
- The server owns every bucket label — `Aug 2026` arrives formatted.
- `attention.*.names` is a capped sample; `count` is the true total.
- `months=7` is a 400, not a silent default.

Returns: the anchor period and its predecessor; runs by status with the oldest
awaiting approval; money (gross, net, deductions, previous period, currency);
employees (paid, in an open run, active, without a structure) with a names sample;
an attention strip (no structure, no active contract, run awaiting approval, draft
for a closed period); and trend buckets with server-formatted labels.

**Reports — `/payroll/reports/*`** (ADMIN · HR_MANAGER · PAYROLL_OFFICER), all
reading `APPROVED` / `PAID` runs only: `register?runId=` (every payslip and its
lines), `cost?runId=&groupBy=department|branch`, `statutory?runId=` (deduction and
employer-contribution totals by component), `ytd/:employeeId?year=`.

---

## Phase 3 — Frontend

```
app/dashboard/payroll/
  page.tsx                          hub, on ModuleLandingPage
  runs/page.tsx                     Payruns list
  runs/new/page.tsx                 Run Payroll — period → pre-flight → generate
  runs/[id]/page.tsx                run detail: totals, payslip table, findings, approve/reject
  payslips/page.tsx                 all payslips
  payslips/[id]/page.tsx            payslip detail + Print
  salary-components/page.tsx        catalogue (the Salary Rules screen)
  salary-components/new/page.tsx
  salary-components/[id]/page.tsx
  structures/page.tsx               Structure list / assignment register
  structures/new/page.tsx           Create structure
  structures/[id]/page.tsx          edit structure + lines
  reports/page.tsx                  tabbed reports + Excel download
app/dashboard/my-payslips/
  page.tsx  ·  [id]/page.tsx        self-service
```

Services `payrollRunService.ts`, `payslipService.ts`, `salaryComponentService.ts`,
`salaryStructureService.ts`, `payrollReportService.ts` — classes exported as
singletons, one method per route. Hooks `usePayrollRuns`, `usePayrollHub`,
`usePayslips`, `useSalaryStructures`, `useSalaryComponents` with `payrollKeys`,
`payslipKeys`, `salaryStructureKeys` objects invalidating the whole subtree. Types in
`types/payroll.ts`, `types/payslip.ts`, `types/salaryStructure.ts`.

Components under `components/payroll/`: `PayrollRunForm`, `PreflightFindings`,
`RunSummaryCards`, `PayslipTable`, `PayslipLines`, `SalaryStructureForm`,
`SalaryComponentForm`, plus `hub/` panels. Follow the HRM idiom worth keeping: the
summary cards and the table derive from **one** pure `runTotals()` helper, so the
cards and the rows they summarise cannot disagree.

Non-negotiable adaptations:

- Period and effective dates through **`formatDateOnly`**; money through
  **`formatCurrency`**, which takes its decimals from the currency.
- Errors through **`err.message` / `apiErrorMessage()`** — the interceptor rejects
  with a flat object and `err.response.data.message` silently falls through.
- **Logical CSS** (`ps-*`, `me-*`, `text-start`) throughout; `rtl:rotate-180` on
  directional icons.
- Form fields are strings in the zod schema and converted only when building the
  payload — the house style in `ContractForm.tsx`.
- The Excel download goes through `responseType: 'blob'`, which the interceptor
  passes through untouched.
- Print is a `@media print` stylesheet on the payslip route plus `window.print()`.
  No PDF dependency.

**Nav — the one trap.** `navConfig.ts` already has a `payroll` group in all three
menu trees, pointing every role at `/dashboard/payroll`. But `/dashboard/payroll` is
the hub, and `MANAGER` and `EMPLOYEE` hold only `VIEW_OWN_PAYSLIP`. Left as it is,
those two roles click their own sidebar into a 403 — precisely the defect
`docs/MIGRATION.md` §8 records under "The rail offered a route the server refuses".
So: add `hubRoles: ['ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER']` and the children to the
admin tree's group, and **re-point the manager and employee trees' payroll entry at
`/dashboard/my-payslips`**.

---

## Phase 4 — Seed

`apps/backend/prisma/seed.ts`, following the file's own rules: upsert on a natural
unique key, never a bare create; deterministic variation from the employee index
(`(index * 7 + n) % 100`), never `Math.random()`; fixtures re-dated relative to today
on each run so the demo still shows something months later.

`seedSalaryStructures(employees)` — placed after `seedContracts`, since a structure
follows a contract. One structure per active employee, upserted on `employeeId`, with
lines derived from the contract salary: `BASIC` 60%, `HRA` 25%, `TRANSPORT` 10%,
`OTHER_ALLOW` 5%, `SOCIAL_SEC_EE` 7% of basic as a deduction, `SOCIAL_SEC_ER` 10.5% of
basic as an employer contribution. Fixed amounts, computed once at seed time — the
percentages are how the seed *derives* them, not a runtime rule.

`seedPayrollRuns(employees)` — three runs so every screen has a population:
one `PAID` two months back, one `APPROVED` last month, one `CALCULATED` awaiting
approval. Upserted on `(periodStart, periodEnd)`; payslips on
`(payrollRunId, employeeId)`. Amounts come from the real calculator against the seeded
attendance, so the seed and the app can never diverge.

One employee is deliberately left **without** a structure, so the pre-flight and the
attention strip have a real finding to show. A demo where every card reads zero cannot
show that the cards work.

---

## Phase 5 — Tests

| Layer | Files |
|---|---|
| Backend unit (jest) | `payroll-calc.util.spec.ts` · `payroll-preflight.rules.spec.ts` · `payroll-period.util.spec.ts` · `payroll-runs.service.spec.ts` · `payslips.service.spec.ts` · `payroll-hub.service.spec.ts` · `salary-structures.service.spec.ts` · `salary-components.service.spec.ts` |
| API integration (supertest, e2e DB on 8174) | `apps/backend/test/payroll.e2e-spec.ts` — the full lifecycle, the role matrix on every route, the response envelope, `forbidNonWhitelisted`, and the two 403 cases that matter: a payroll officer refused `approve`, an employee refused another employee's payslip |
| Frontend unit (`*.test.ts`) | `utils/payrollTotals.test.ts` |
| Component (`*.test.tsx`) | run detail, payslip detail, structure form, hub (null renders as an em dash, not `0.0%`) |
| Playwright | `payroll.admin-payroll.spec.ts` (create → pre-flight → calculate) · `payroll-approval.admin.spec.ts` (approve; reject demands a reason; officer sees no decision buttons) · `salary-structures.admin-payroll.spec.ts` · `payroll-hub.admin-payroll.spec.ts` · `payslips.employee.spec.ts` (own only; refused the hub) · `payroll.hr.spec.ts` (reads, cannot decide) |

Playwright role projects are `admin | hr | payroll | employee`, selected by the
filename segment; there is **no `manager` project or seed account**, so
manager-scoped paths get backend coverage only and the gap is recorded.

The money assertions use HRM's **twin idiom**, which is worth porting outright: assert
a *difference* between two otherwise-identical employees rather than an absolute
figure, so a test does not break when a seeded rate changes.

Run the calculator's spec first. Nothing above it is trustworthy until it is green.

---

## Phase 6 — Docs (rule 7)

- `docs/payroll-walkthrough.md` — following the `schedules-walkthrough.md` structure:
  what the module is · entry points · API surface · logic · data · tests · what
  changed from HRM and why · what was left out and why.
- `docs/interconnections-payroll.md` — following `interconnections-schedules.md`:
  a map, then one numbered section per counterpart (Employees, Contracts,
  Attendances, Branches/Departments, Holidays, Frontend contracts), each with
  direction, status, a reference table and an "if X changes" blast radius; then a
  pending section for every seam listed under Scope.
  It must also record that `docs/interconnections-schedules.md` §7.6 currently
  describes Payroll as not-yet-built and now needs updating **by that module's
  owner** — this branch does not edit another module's doc.
- This plan itself lives here as `docs/payroll-migration-plan.md`, and its status
  line is updated as the phases land.

---

## Shared-file edits (rule 3 — the complete list)

1. `apps/backend/prisma/schema.prisma` — additive fields on `PayrollRun`, `Payslip`, `PayslipLine` only
2. `apps/backend/prisma/seed.ts` — two new functions plus their calls in `main()`
3. `apps/backend/src/app.module.ts` — register `SalaryComponentsModule`, `SalaryStructuresModule`, `PayrollModule`
4. `apps/backend/src/main.ts` — one `.addTag('Payroll', …)`
5. `apps/frontend/components/layout/navConfig.ts` — `hubRoles` + children on the existing payroll group; re-point the manager and employee entries at `/dashboard/my-payslips`
6. `apps/frontend/messages/{en,ar}/index.ts` — register the `payroll` namespace
7. `apps/frontend/messages/{en,ar}/sidebar.json` — the new child labels

Nothing else outside the new module folders is touched. In particular
`attendances/` is **not** edited: `AttendanceCalendarService` is already exported by
`AttendancesModule`, so payroll imports the module and reads the branch calendar
through the existing service.

---

## Verification

```bash
# 1 — schema + client + seed
npm run db:push
npm run db:seed

# 2 — static
npm run typecheck        # both apps
npm run lint

# 3 — unit, calculator first
npm test --prefix apps/backend -- payroll-calc
npm test                 # jest backend + vitest unit and component

# 4 — API layer against the e2e database (8174)
npm run e2e:up
bash scripts/test-api.sh

# 5 — browser
npm run e2e:db reset
cd apps/backend && set -a && . ./.env.test && set +a && node dist/src/main.js &
cd apps/frontend && npm run test:e2e
```

`e2e:db reset` rather than a second `e2e:up`: a payroll run is history the application
never deletes, so re-seeding a live database accumulates runs across passes and no
assertion may depend on a whole-table count.

**Manual end-to-end** (`npm run dev`, portal 3010 / API 3011):

1. As `payroll@peoplepay360.com`, open `/dashboard/payroll` — the hub answers in one
   request, and a card with nothing to divide by shows an em dash, not `0.0%`.
2. Start a run for last month and check the pre-flight: the employee seeded without a
   structure is named as a BLOCKER, and generation refuses for the same reason in the
   same words.
3. Give that employee a structure, re-run the pre-flight, generate. Open a payslip and
   confirm earnings − deductions = net, and that the lines sum exactly to the totals.
4. Find an employee with absences and confirm the LOP line is
   `gross × lopDays / workDays`, and that a month with zero working days produces no
   LOP rather than an error.
5. Confirm the employer-contribution line appears on the payslip and is **not** in
   gross, deductions or net.
6. Still as the payroll officer, confirm there is no Approve button and that
   `POST /payroll-runs/:id/approve` answers 403.
7. As `admin@peoplepay360.com`, reject with a reason — the run returns to DRAFT and the
   reason is shown. Then approve, and mark it paid.
8. As `employee@peoplepay360.com`, open `/dashboard/my-payslips`: the approved payslip
   is there, the draft run's is not, another employee's id answers 403, and the
   sidebar offers no route that 403s.
9. Download the Excel export and open it; print a payslip and check the print layout.
10. Switch the portal to `dir="rtl"` and confirm the payroll screens mirror without a
    second stylesheet.

---

## Pending after this branch

Payroll is complete as a base system but not fully live until other modules land:
paid-leave classification and overtime tiers (Leave & Overtime), statutory tax and
social-insurance calculators, gratuity and end-of-service, loans and advances,
garnishments, reimbursements, WPS wage files, bank payment files, multi-tier approval,
and notification fan-out. Each is named in `docs/interconnections-payroll.md` with its
contract, so the counterpart module has something to build against.

**No git push, pull, fetch or PR at any point.** When the work is done it is reported
and stops there.
