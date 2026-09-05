# Payroll — walkthrough

Migrated from `human-resource-management`, where the same subsystem lives across
`apps/backend/src/payrolls/`, `payroll-reports/`, `payroll-batches/` and
`payroll-calendar/`. Adapted to this repository's conventions rather than
copied: the data model, the run lifecycle, the role split and the definition of
"what to pay somebody" all differ, and the differences are listed under
[What changed from HRM](#what-changed-from-hrm).

> **State at the time of writing.** The backend is complete and green: three
> modules, 33 routes, 125 passing unit tests. The frontend's **data layer**
> exists — types, services, hooks and `utils/payrollTotals.ts`, with its own
> test — but **no route and no component under `components/payroll/` has been
> written yet**, and the seed writes no salary structure and no payroll run.
> Every section below says which side of that line a thing falls on. Nothing is
> documented here that was not read in the code.

---

## 1. What the module is

The thing that turns **a salary structure and a month of attendance** into a
payslip, and then walks that payslip through an approval it cannot skip.

It is the first module in this repository whose output is a **legal record**
rather than a view. Everything about its design follows from that: the figures
are snapshotted, the transitions are conditional writes, and the person who runs
payroll is not the person who signs it.

### The rule the whole module rests on

**A payslip is its own history.** `SalaryStructure.employeeId` is `@unique`, so
there is exactly one structure per employee and a pay rise **overwrites** it —
nothing is kept of what it used to say. That loses nothing, because
`PayslipLine` snapshots `code`, `label`, `type` and `amount` at generation. The
record of what was actually paid lives on the payslip, never in the structure it
was derived from.

Every report in the module reads accordingly. `payroll-reports.service.ts`
groups on the payslip line's own `code` and `label` — never through
`componentId`, which is nullable and points at a catalogue row that may since
have been renamed or retired.

### The second rule, which is easier to get wrong

**Employer contributions are recorded, never paid.** `SalaryComponentType` has
three values, and `EMPLOYER_CONTRIBUTION` lines are stored on the payslip and
summed into `totalEmployerCost` — and excluded from `grossPay`,
`totalDeductions` and `netPay`. They are what the employer spends, not what the
employee receives. Adding them to gross inflates every wage in the company by
its own social-security bill.

The exclusion is enforced in three separate places that must agree:
`calculatePayslip` in `payroll-calc.util.ts`, the hub's and reports' `_sum`
selections, and `utils/payrollTotals.ts` on the client.

### Three things this module deliberately does not claim

| What a payroll system usually does | What ships here, and why |
| --- | --- |
| Percentage rules — `HRA = 40% of BASIC` | **Fixed amounts only.** `SalaryStructureLine.amount` is a `Decimal(18, 3)`; there is no `valueType` column and no expression evaluator. A rule the engine cannot read is a rule that quietly does nothing. This matches HRM's live engine, which is also fixed-amount. |
| Statutory tax and social-insurance calculation | **Nothing is calculated.** `SOCIAL_SEC_EE` and `SOCIAL_SEC_ER` are ordinary catalogue components with an amount somebody typed. The module records them; it does not derive them from a rate table it does not have. |
| A daily-wage pay basis | **Monthly only.** `Employee` in this schema has no `salaryType` and no `baseSalary` column, so HRM's `DAILY` branch has nothing to key off. See [What changed from HRM](#what-changed-from-hrm). |

---

## 2. Entry points

### Backend — `apps/backend/src/payroll/`

| File | Role |
| --- | --- |
| `payroll-calc.util.ts` | The money engine. `calculatePayslip`, `isPayable`, `roundMoney`, `roundDays`. Pure — no Prisma, no Nest, no clock. |
| `payroll-period.util.ts` | `periodFor`, `eachDayKey`, `countWorkingDays`, `previousPeriod`, `periodLabel`, `isValidPeriod`. Date-only throughout. |
| `payroll-attendance.util.ts` | `resolvePaidDays` — how a month of attendance rows becomes a number of paid days. |
| `payroll-preflight.rules.ts` | `resolvePopulation`, `resolveAttendanceCoverage`, `resolveStructures`, `resolveContracts`, `hasBlocker`. Return findings, never throw. |
| `payroll-runs.service.ts` | The lifecycle, `gatherFacts`, `buildFindings`, `calculate`, and the four transitions. |
| `payslips.service.ts` | Self-service and privileged reads, with the self-or-privileged narrowing. |
| `payroll-hub.service.ts` | The landing aggregate, plus `companyToday`, `money`, `trendWindow`, `tallyStatuses`, `buildTrend`, `buildAttention`. |
| `payroll-reports.service.ts` | `register`, `cost`, `statutory`, `ytd`, and the `lockedRun` gate all four pass through. |
| `payroll-export.service.ts` | `runWorkbook` — a run as a two-sheet `.xlsx` via `exceljs`. |
| `payroll-hub.controller.ts`, `payroll-reports.controller.ts`, `payroll-runs.controller.ts`, `payslips.controller.ts` | The four controllers, registered in that order. |
| `payroll.module.ts` | Imports `AttendancesModule`; exports `PayrollRunsService` and `PayslipsService`. |
| `dto/` | `create-payroll-run`, `preflight-payroll-run`, `reject-payroll-run`, `list-payroll-runs`, `list-payslips`, `hub-query`, `report-query`. |
| `*.spec.ts` | Seven suites, 104 unit tests. |

Registered explicitly in `app.module.ts` — never through a transitive import.

### Backend — `apps/backend/src/salary-components/`

The catalogue, and the "Salary Rules" screen's backend. A component **is** the
salary rule in this design: `type` says which bucket the amount lands in,
`isTaxable` and `isGratuityBase` say how the rest of the system must treat it,
`sequence` says where it prints. There is no separate rule model because the
engine reads exactly these properties and nothing else.

`salary-components.service.ts` · `.controller.ts` · `.module.ts` · `dto/`.
**No spec file** — the one gap in the module's unit coverage.

### Backend — `apps/backend/src/salary-structures/`

One structure per employee, with its lines. `salary-structures.service.ts` ·
`.controller.ts` · `.module.ts` · `dto/` · `salary-structures.service.spec.ts`
(21 tests).

### Frontend — the data layer (present)

| File | Role |
| --- | --- |
| `types/payroll.ts` | Runs, pre-flight findings, and all four report payloads. `Money` is a **string** — see [Money and dates](#money-and-dates). |
| `types/payslip.ts` | `Payslip`, `PayslipLine`, `PayrollRunDetail`, the two list queries. |
| `types/salaryStructure.ts` | Both the component catalogue and the structure types. There is no `types/salaryComponent.ts`. |
| `types/payrollHub.ts` | The hub payload; re-exports `TrendMonths` from `organizationHub`. |
| `services/payrollRunService.ts` | Every `/payroll-runs` route plus `hubSummary`. `exportXlsx` uses `responseType: 'blob'` and returns the raw response, not the envelope. |
| `services/payslipService.ts`, `salaryComponentService.ts`, `salaryStructureService.ts`, `payrollReportService.ts` | One method per route. |
| `hooks/usePayrollRuns.ts` | 15 hooks behind `payrollKeys` (`all: ['payroll-runs']`). |
| `hooks/usePayslips.ts` | `payslipKeys` (`all: ['payslips']`). |
| `hooks/usePayrollHub.ts` | `payrollHubKeys` (`all: ['payroll-hub']`). |
| `hooks/useSalaryComponents.ts`, `hooks/useSalaryStructures.ts` | `salaryComponentKeys`, `salaryStructureKeys`. |
| `utils/payrollTotals.ts` | `payslipTotals`, `runTotals`, `totalCost`, `toAmount`. The ONE place payroll money is added up on the client. |

### Frontend — screens

| Route | What it is |
| --- | --- |
| `app/dashboard/payroll/page.tsx` | The hub, on `ModuleLandingPage`: KPI cards, the attention strip, a 6/12-month trend and the nav tiles. |
| `payroll/runs/page.tsx` | Every run, filtered by status and year. |
| `payroll/runs/new/page.tsx` | Period → pre-flight → findings → Generate. Generate is disabled unless the server said `canGenerate`. |
| `payroll/runs/[id]/page.tsx` | Summary cards, the payslip table, the rejection reason, and Calculate / Approve / Reject / Mark paid / Cancel / Export. |
| `payroll/payslips/page.tsx`, `payslips/[id]/page.tsx` | Every payslip, and one payslip with a print stylesheet. |
| `payroll/structures/` (`page`, `new`, `[id]`) | The assignment register and the structure editor. |
| `payroll/salary-components/` (`page`, `new`, `[id]`) | The catalogue — the Salary Rules screen. No Delete anywhere. |
| `payroll/reports/page.tsx` | Register · Cost · Statutory · YTD, plus the Excel download. |
| `app/dashboard/my-payslips/` (`page`, `[id]`) | Self-service. The first `my-*` route in the repo. |

Components live under `components/payroll/` — `RunSummaryCards`, `PayrollRunTable`,
`PayslipLines`, `PreflightFindings`, `PayrollRunForm`, `RunStatusBadge`,
`SalaryStructureForm`, `SalaryComponentForm`, `SalaryStructureTable`,
`ComponentTypeBadge`, and `hub/` (`MoneyComposition`, `RunPipelineDonut`,
`ProcessingCoverage`).

The summary cards and the table under them both derive from **one** helper,
`utils/payrollTotals.ts`. That is the HRM idiom worth keeping: cards computed
separately from the rows they summarise are cards that eventually disagree with
them.

### The nav trap, and how it was avoided

`components/layout/navConfig.ts` carried a `payroll` entry in all three menu
trees, every one pointing at `/dashboard/payroll`. But that route is the **hub**,
and `GET /payroll/hub-summary` is ADMIN + HR_MANAGER + PAYROLL_OFFICER only,
while MANAGER and EMPLOYEE hold just `VIEW_OWN_PAYSLIP`. Left alone, those two
roles would click their own sidebar into a 403 — the defect `docs/MIGRATION.md`
§8 records under "The rail offered a route the server refuses".

So the admin tree's group gained `hubRoles` mirroring the aggregate's `@Roles`
plus its six children, and the manager and employee entries were **re-pointed at
`/dashboard/my-payslips`**. `components/layout/navConfig.test.ts` asserts both
directions: that those two roles get `myPayslips` and never `payroll`, and that
`runPayroll` is offered only to the roles `POST /payroll-runs` accepts.

### Translations

`messages/{en,ar}/sidebar.json` carry the six child labels and `myPayslips`;
`messages/{en,ar}/moduleLanding.json` carry `payroll.title`, `payroll.subtitle`
and a `desc` line per tile, which is what `ModuleLandingPage` reads.

There is deliberately **no `messages/{en,ar}/payroll.json`**. The hub is covered
by `moduleLanding` and the rail by `sidebar`; the remaining payroll screens
follow the `contracts` / `employees` precedent and are not translated, so
registering a `payroll` namespace would register something nothing reads. It
belongs with the screens that would use it, not ahead of them.

---

## 3. API surface

All responses go through the global envelope: `{ success, data, message?, meta? }`.
Nothing below hand-rolls a different shape. Guards are on the controller class
(`@UseGuards(JwtAuthGuard, RolesGuard)`) with `@Roles(...)` per route, as
`CLAUDE.md` requires.

### Runs — `/payroll-runs`

Class-level `@Roles(ADMIN, HR_MANAGER, PAYROLL_OFFICER)`; each row below shows
the effective set.

| Route | Roles | Returns |
| --- | --- | --- |
| `GET /payroll-runs?page&limit&status&year` | ADMIN, HR, PAYROLL | Paginated runs, newest period first. |
| `POST /payroll-runs/preflight` | ADMIN, PAYROLL | Everything the run would refuse. **Writes nothing.** 200, not 201. |
| `GET /payroll-runs/:id` | ADMIN, HR, PAYROLL | One run with its payslips and each payslip's employee. |
| `GET /payroll-runs/:id/export` | ADMIN, HR, PAYROLL | `.xlsx`, two sheets. |
| `POST /payroll-runs` | ADMIN, PAYROLL | Opens a DRAFT over the whole month. |
| `POST /payroll-runs/:id/calculate` | ADMIN, PAYROLL | Generates the payslips → CALCULATED. |
| `POST /payroll-runs/:id/approve` | **ADMIN only** | CALCULATED → APPROVED. |
| `POST /payroll-runs/:id/reject` | **ADMIN only** | `{ reason }`, CALCULATED → DRAFT. |
| `POST /payroll-runs/:id/mark-paid` | **ADMIN only** | APPROVED → PAID. |
| `POST /payroll-runs/:id/cancel` | ADMIN, PAYROLL | Anything but PAID or CANCELLED → CANCELLED. |
| `DELETE /payroll-runs/:id` | **ADMIN only** | DRAFT only. |

The three decision routes are ADMIN-only because `utils/permissions.ts` gives a
`PAYROLL_OFFICER` `MANAGE_PAYROLL` and deliberately **not** `APPROVE_PAYROLL`.
The decorators mirror the permission table exactly; the officer who runs payroll
does not sign it.

`POST /payroll-runs/preflight` is declared **before** `GET /payroll-runs/:id`.
Express matches in declaration order, so with `:id` first the literal segment
would be handed to `ParseUUIDPipe` and every pre-flight would answer 400.

### Payslips — `/payslips`

There is **no class-level `@Roles`** on this controller.

| Route | Roles | Returns |
| --- | --- | --- |
| `GET /payslips/my?page&limit` | any authenticated | Own payslips, **APPROVED and PAID runs only**. |
| `GET /payslips/my/:id` | any authenticated | One of your own, settled runs only. 404 for anything else. |
| `GET /payslips?runId&employeeId` | ADMIN, HR, PAYROLL | All payslips, paginated. |
| `GET /payslips/employee/:employeeId` | narrowed in the service | One employee's payslips. **Does not apply the settled-runs filter** — see §4.6. |
| `GET /payslips/:id` | narrowed in the service | Own, or any for a payroll role. |

The last two carry no decorator on purpose: whether the answer is allowed
depends on **whose** payslip it is, and a decorator cannot see that.
`PayslipsService.assertMayRead` decides — the same idiom `attendances.service.ts`
uses. `my` and `my/:id` are declared before `:id` for the same reason
`preflight` is.

### Hub — `/payroll`

| Route | Roles | Returns |
| --- | --- | --- |
| `GET /payroll/hub-summary?months=6\|12` | ADMIN, HR, PAYROLL | The whole landing page in one request. |

`months` is validated with `@IsIn([6, 12])`. Anything else is a **400 with the
message `months must be 6 or 12`**, not a silent fall back to six.

### Reports — `/payroll/reports`

All four are ADMIN, HR_MANAGER, PAYROLL_OFFICER, and all four read
**APPROVED and PAID runs only**.

| Route | Returns |
| --- | --- |
| `GET /payroll/reports/register?runId` | Every payslip in the run with its lines, plus run totals. Not paginated. |
| `GET /payroll/reports/cost?runId&groupBy=department\|branch` | Gross, deductions, net, employer cost and `totalCost` per group, each with its `share`. |
| `GET /payroll/reports/statutory?runId` | DEDUCTION and EMPLOYER_CONTRIBUTION totals per line code. |
| `GET /payroll/reports/ytd/:employeeId?year` | One employee's calendar year across locked runs, with a per-period breakdown. |

`runId` is **required** on the first three. A payroll register with no run named
on it is a document nobody can file.

### Salary components — `/salary-components`

Class-level `@Roles(ADMIN, HR_MANAGER, PAYROLL_OFFICER)`.

| Route | Roles |
| --- | --- |
| `GET /salary-components?page&limit&type&isActive&search` | ADMIN, HR, PAYROLL |
| `GET /salary-components/:id` | ADMIN, HR, PAYROLL |
| `POST /salary-components` | ADMIN, PAYROLL |
| `PATCH /salary-components/:id` | ADMIN, PAYROLL |
| `POST /salary-components/:id/deactivate` | ADMIN, PAYROLL |
| `POST /salary-components/:id/activate` | ADMIN, PAYROLL |

**There is no DELETE.** `PayslipLine.componentId` declares `onDelete: SetNull`
precisely so a payslip survives a component that goes away, but a component that
has already paid somebody is part of a legal record and erasing it would leave a
payslip nobody can explain. Retirement is deactivation — the house idiom users
and contracts already follow. `activate` is the way back.

`UpdateSalaryComponentDto` omits `code` and `type`. Both are joined on by
payslip lines that already exist: renaming a code orphans every report that
groups by it, and turning an earning into a deduction changes the meaning of
money already paid.

### Salary structures — `/salary-structures`

Class-level `@Roles(ADMIN, HR_MANAGER, PAYROLL_OFFICER)`.

| Route | Roles | Notes |
| --- | --- | --- |
| `GET /salary-structures?page&limit&search&branchId&departmentId` | ADMIN, HR, PAYROLL | The assignment register: employee, currency, `lineCount`, summed `grossPay`. |
| `GET /salary-structures/employee/:employeeId` | ADMIN, HR, PAYROLL | Declared before `:id`. |
| `GET /salary-structures/:id` | ADMIN, HR, PAYROLL | With lines and their components. |
| `POST /salary-structures` | ADMIN, PAYROLL | Structure and lines in one transaction. |
| `PATCH /salary-structures/:id` | ADMIN, PAYROLL | Supplying `lines` **REPLACES** the set. |
| `DELETE /salary-structures/:id` | **ADMIN only** | Refused once the employee has any payslip. |

---

## 4. Logic

### 4.1 The calculator — `payroll-calc.util.ts`

Pure: no Prisma, no Nest, no clock. Layer 0, and the only place that decides
what an employee is owed. The run service, the reports and (eventually) the seed
all read these numbers rather than recomputing them.

```
gross           = Σ EARNING lines                       (the full contracted amount)
lopDays         = max(0, workDays − paidDays)
lopAmount       = workDays > 0 ? gross × lopDays / workDays : 0
totalDeductions = Σ DEDUCTION lines + lopAmount
netPay          = max(0, gross − totalDeductions)
employerCost    = Σ EMPLOYER_CONTRIBUTION lines         (in none of the above)
```

Five rules the formula alone does not show:

- **LOP prorates the WHOLE earning set, allowances included.** An employee
  absent half the month did not earn half a housing allowance either. It is
  emitted as a single generated `DEDUCTION` line with code `LOP`, label
  `Loss of Pay`, `sequence: 900` and `componentId: null` — last in the
  deductions block, because it is derived from that bucket rather than
  contracted alongside it.
- **`workDays === 0` yields no LOP**, rather than a division by zero. A month a
  branch never opens is not a month everybody was absent.
- **LOP is capped at gross and net floors at zero.** A LOP larger than
  everything earned would make the payslip claim the employee owes the company
  money for turning up at all, and a negative net is never persisted — a
  shortfall is a recovery to raise against the next period, not a figure to pay.
- **Line order is deterministic**: `sequence`, then `code`. Two runs of the same
  input produce byte-identical lines, because a recalculation that only reorders
  rows still reads as a changed payslip to anyone comparing two exports.
- **No structure means no payslip**, never a zero one. `isPayable` requires at
  least one `EARNING` line with a positive amount. "Paid nothing this month" and
  "nobody said what to pay them" are different claims, and only the second is a
  data problem.

#### The rounding residual

Money is `Decimal(18, 3)`, so `roundMoney` is three decimals, half-up, and never
`-0`. Rounding each line independently leaves `Σ lines` a few thousandths away
from the total the header states, and a payslip whose rows do not add up to its
own gross is the first thing anybody notices.

`absorbResidual` therefore pushes the residual **into the largest line of its
bucket** — a thousandth is invisible there and conspicuous on a small allowance.
It runs once per bucket: earnings, deductions, employer contributions.

It also refuses to hide a real error. A residual larger than
`0.001 × lineCount` is not rounding, it is a bug in the caller, and
`absorbResidual` **throws** rather than silently absorbing the money.

### 4.2 A missing attendance row is PAID — `payroll-attendance.util.ts`

This is the module's most consequential rule and the reason the pre-flight
exists.

`resolvePaidDays` starts from **the whole month paid** and claws back recorded
absence, weighted:

| `AttendanceStatus` | Days deducted |
| --- | --- |
| `ABSENT` | 1 |
| `HALF_DAY` | 0.5 |
| `PRESENT`, `LATE`, `HOLIDAY`, `WEEKEND` | 0 |
| `ON_LEAVE` | **0 — leave is paid.** See §4.7. |

So **a working day with no attendance row at all is PAID.** A missing row is a
gap in the data, not evidence that somebody stayed home, and treating it as an
absence would dock a whole workforce the first time an import failed.

Two guards sit around it:

- Only rows falling on a **working day for that employee's branch** are counted
  at all, so an absence recorded on a weekly off or a public holiday costs
  nothing.
- **One row per day.** A duplicate import must not dock the same day twice.

### 4.3 The pre-flight, and why the rule above requires it

`payroll-preflight.rules.ts` returns **data, never throws**. The pre-flight
endpoint renders those findings; `calculate()` guards on the same functions and
raises its own `BadRequestException` **with the finding's own message**. One
definition of "is this run safe", two presentations of it, and no possibility of
the pre-flight saying "ready" about a run generation then refuses.

Both call one private method, `PayrollRunsService.gatherFacts`, which is what
keeps the two answers identical.

| Finding | Severity | Because |
| --- | --- | --- |
| `NO_EMPLOYEES` | BLOCKER | Nobody was on the books in the period. |
| `ALL_UNMATCHED` | BLOCKER | Every named employee id matched nobody. |
| `UNMATCHED_EMPLOYEES` | WARNING | Some named ids matched nobody; the rest can still be paid. |
| `NO_ATTENDANCE_AT_ALL` | **BLOCKER** | **The expensive one.** With no attendance anywhere, LOP is zero for everybody and the run quietly pays a full month against a period that was never processed. |
| `NO_ATTENDANCE` | WARNING | One employee has no attendance and will be paid a full month. |
| `NO_STRUCTURE` | BLOCKER | Nothing says what to pay them. |
| `NO_EARNING_LINE` | BLOCKER | A structure exists, but nothing in it pays anything. |
| `NO_ACTIVE_CONTRACT` | WARNING | Usually a renewal somebody forgot. Refusing the whole run over one lapsed record would strand everybody else. |

`NO_ATTENDANCE_AT_ALL` and `NO_ATTENDANCE` are mutually exclusive: when nobody
has attendance the per-employee warnings are suppressed, because ninety copies
of the same warning bury the one line that matters.

Per-employee findings are capped at `NAME_SAMPLE_CAP = 10`, after which a single
`<CODE>_MORE` finding says how many were left out. A named sample is not a
count.

### 4.4 Generation — `calculate()`

Guarded by the pre-flight's blockers, refused in the pre-flight's words. Then
**everything happens inside ONE `$transaction`**: the run's previous payslips are
deleted, the new ones are written with their lines, and `totalGross`, `totalNet`,
`employeeCount` and `calculatedAt` are stamped as the status moves to
`CALCULATED`. Half a recalculation is worse than none — a run showing
yesterday's total over today's payslips is a figure nobody can reconcile.

`rejectionReason` is cleared in the same write. A reason left over from a
previous rejection, sitting next to fresh figures, reads as a live objection to
them.

Payslip numbers are `PS-YYYY-MM-NNNN`, derived from the period and a 1-based
index within the run.

The working-day set is resolved **once per branch**, not once per employee:
every employee of a branch shares its calendar, and recomputing it per person is
a month of predicate calls multiplied by the headcount. The calendar itself
comes from `AttendanceCalendarService` — `branchConfigs()`, `configFor()`,
`holidayIndex()`, `isBranchWorkingDay()` — because two definitions of "working
day" is how a payslip and an attendance report start disagreeing about the same
month.

### 4.5 The lifecycle

```
DRAFT ──calculate──► CALCULATED ──approve──► APPROVED ──mark-paid──► PAID
  ▲                       │
  └──────reject───────────┘
                     (cancel: anything but PAID or CANCELLED)
                     (delete: DRAFT only)
```

Recalculation is allowed while `DRAFT` or `CALCULATED` and refused after that:
past approval the figures are a decision somebody signed, not a draft.

Every transition is a **conditional `updateMany` with the expected status in the
`where`**, not a read-then-write. Two approvals racing would otherwise both read
`CALCULATED`, both win, and the second would overwrite the first approver's
name. `changed.count === 0` becomes the refusal message.

`approvedById` is stored as a plain `@db.Uuid`, not a relation. An approver may
later be deactivated, and the run must keep saying who signed it.

`cancel` excludes `PAID` and `CANCELLED`. Money that has left the company cannot
be cancelled by editing a status.

### 4.6 Authorization

Expressed against an actor rather than a role string alone wherever the answer
depends on whose record it is:

- **`assertMayRead(employeeId, user)`** — ADMIN, HR_MANAGER and PAYROLL_OFFICER
  read anybody's payslip; anybody else reads only their own
  (`user.employeeId === employeeId`).
- **Self-service sees settled runs only.** `SELF_VISIBLE_STATUSES` is APPROVED
  and PAID. An employee who reads a draft figure and then reads a different
  approved figure has been told two different things about the same month.
  `findOne` re-applies this even for a caller's own row.
- **`findMineOne` answers 404, not 403.** An employee asking for an id that is
  not theirs should not learn from the answer that it exists.
- **An account with no employee record gets a sentence**, not an empty list:
  `ownEmployeeId` throws "Your account is not linked to an employee record, so
  it has no payslips."

> **A leak that was found and closed.**
> `PayslipsService.findByEmployee` called `assertMayRead` and then delegated to
> `findAll`, which applied **no run-status filter**. An EMPLOYEE calling
> `GET /payslips/employee/<their own id>` therefore passed the permission check
> and received their DRAFT and CALCULATED payslips — the exact thing `findMine`
> and `findOne` are written to prevent. The same person, asking about the same
> month, got a different answer depending on which door they used.
>
> `findAll` now takes a `settledOnly` flag, and `findByEmployee` passes it
> whenever the caller is not a management role. It is passed by the caller
> rather than decided inside `findAll`, because a payroll role listing the same
> employee **is** entitled to the draft rows. Two tests in
> `payslips.service.spec.ts` pin both halves.

### 4.7 Leave is paid, because nothing here can say otherwise

`ON_LEAVE` costs zero days. Leave & Overtime is not implemented in this
repository — there is no `LeaveRequest` model — so there is nothing to ask
whether a particular leave was approved as **unpaid**. Until that module lands,
leave is treated as paid and the seam is recorded in
[interconnections-payroll.md](interconnections-payroll.md) §7.1.

### 4.8 The hub

Two rules hold the page together, and they are the same two the reports obey:

- **Money means APPROVED or PAID.** Every money figure filters to
  `LOCKED_RUN_STATUSES`. A hub that added a draft to "paid this month" would
  disagree with the register the moment somebody printed one.
- **A rate is `null`, never `0`, when there was nothing to divide by.**
  `changePct` uses `rate()` from `attendances/attendance-calendar.util.ts`,
  which returns `null` for a non-positive denominator. The frontend renders
  `null` as an em dash.

Plus the four rules the hubs share, each visible in the code:

- **Counts are counted in the database.** `payrollRun.groupBy({ by: ['status'] })`
  spans all history rather than measuring a page; `tallyStatuses` names all five
  statuses so a card never reads `undefined` as zero.
- **`employees.inOpenRun` is `groupBy(['employeeId'])`, not `count`.** Somebody
  sitting in two open runs is one person waiting, not two.
- **The server owns every bucket label.** `periodLabel` formats `Aug 2026`
  server-side; the browser does no calendar maths.
- **`attention.*.names` is capped at `NAME_CAP = 5`** while `count` stays the
  true total.

The anchor month comes from `companyToday()` — `Company.timezone`, not the
server's clock — so the hub, the reports and the attendance pages agree about
what month it is. `buildTrend` gives **every** month in the window a bucket
whether or not a run was locked for it; a chart that omitted the empty months
would draw a continuous line through a period nobody was paid in. And it reads
the run's own stamped `totalGross` / `totalNet` rather than re-summing payslips,
so the chart cannot argue with the header it sits under.

`buildAttention` **drops** every entry whose count is zero. A strip that always
has four rows on it stops being read.

### 4.9 Reports read locked runs only

`lockedRun()` refuses an unapproved run with a sentence that **names the status
it found** — "not allowed" without it sends the reader looking for a permission
problem they do not have. A register printed off a draft would be a document
stating numbers the company has not agreed to pay, filed and sent to an auditor.

`cost` groups **in memory**, deliberately: the axis lives on the `Employee`, not
the payslip, and one run's payslips is a bounded set. It also means a person who
has since moved department is reported under the department they are in **now**
— the honest answer to "what does this department cost".

`statutory` groups **in the database** on `PayslipLine.code`, `label` and
`type`, never through `componentId`. The id is nullable and the snapshot is the
point.

`ytd` is a **calendar** year, defaulting to the current year in the company
clock rather than to "the last twelve months": a payslip summary an employee
takes to a bank has to line up with the tax year they are asked about.

---

## 5. Data

### The six models

All six pre-existed this work in the `// PAYROLL` section of
`apps/backend/prisma/schema.prisma`; the run, payslip and payslip-line models
gained the additive fields listed below.

| Model | Table | What it holds |
| --- | --- | --- |
| `SalaryComponent` | `salary_components` | The catalogue. `code @unique @db.VarChar(32)`, `name`, `type`, `isGratuityBase`, `isTaxable`, `sequence`, `isActive`. |
| `SalaryStructure` | `salary_structures` | One per employee — `employeeId @unique`. `currency @db.VarChar(3)`, `effectiveFrom @db.Date`. Cascades from `Employee`. |
| `SalaryStructureLine` | `salary_structure_lines` | `structureId`, `componentId`, `amount @db.Decimal(18, 3)`. `@@unique([structureId, componentId])`. `onDelete: Restrict` on the component. |
| `PayrollRun` | `payroll_runs` | `periodStart`/`periodEnd @db.Date`, `status`, `currency`, `totalGross`, `totalNet`, `notes`, `approvedById`, `rejectionReason`, `approvedAt`, `calculatedAt`, `paidAt`, `employeeCount`. `@@unique([periodStart, periodEnd])`, `@@index([status])`. |
| `Payslip` | `payslips` | `payslipNumber @unique`, `workDays Int`, `paidDays`/`lopDays @db.Decimal(5, 2)`, `grossPay`, `totalDeductions`, `netPay`, `totalEmployerCost @db.Decimal(18, 3)`. `@@unique([payrollRunId, employeeId])`, `@@index([employeeId])`. |
| `PayslipLine` | `payslip_lines` | `componentId` **nullable**, `code @db.VarChar(32)`, `label`, `type`, `amount`, `sequence`. `onDelete: SetNull` on the component. |

Enums, both untouched: `PayrollRunStatus { DRAFT CALCULATED APPROVED PAID CANCELLED }`
and `SalaryComponentType { EARNING DEDUCTION EMPLOYER_CONTRIBUTION }`.

### The two schema invariants

Both are stated in the docblock on `Payslip` in the schema itself, so nobody
reads the columns without reading the reason for them:

1. **A payslip is its own history.** `SalaryStructure.employeeId` is `@unique`,
   so a pay rise overwrites the structure and nothing is kept of what it used to
   say. That loses nothing, because `PayslipLine` snapshots `code`, `label`,
   `type` and `amount` at generation. `code` exists as its own denormalised
   column precisely because `componentId` is nullable — the `LOP` line has no
   component behind it, and nothing may be resolved through the component at
   display time anyway.
2. **Employer contributions are recorded, never paid.** `EMPLOYER_CONTRIBUTION`
   lines are stored and summed into `totalEmployerCost`, and are excluded from
   `grossPay`, `totalDeductions` and `netPay`.

Two smaller ones worth knowing:

- **`Payslip.workDays`, `paidDays` and `lopDays` are stored, not recomputed.**
  The payslip must still explain itself after the branch calendar is edited.
- **`PayrollRun.employeeCount` is stamped at calculation**, not derived from a
  page of payslips. The number the run header states is the number the run
  actually produced.

### Models read but never written

| Model | Fields the module reads | Why |
| --- | --- | --- |
| `Employee` | `id`, `employeeCode`, `firstName`, `lastName`, `position`, `status`, `hireDate`, `branchId`, `departmentId` | Who a run pays, and which branch calendar applies. |
| `Contract` | `status`, `currency` | The active-contract warning, the currency check, and the run's own currency. |
| `Attendance` | `employeeId`, `date`, `status` | Paid days. |
| `Branch` | via `AttendanceCalendarService` — `weeklyOffDays`, office hours, `timezone` | The working week, per branch. |
| `Department`, `Branch` (name/id) | `name`, `id` | The cost report's two axes. |
| `Holiday` | via `holidayIndex` / `holidayOn` | Non-working days, branch row beating company-wide. |
| `Company` | `timezone` | `companyToday()`. |

**No model outside the `// PAYROLL` section was changed.**

### Money and dates

- **Money is `Decimal(18, 3)` everywhere**, never `Float`. `roundMoney` is three
  decimals because that is the storable precision. Prisma returns a Decimal,
  which serialises as a **string** — hence `toAmount` in
  `utils/payrollTotals.ts`: `'1250.500' + '90.250'` is string concatenation.
- **Day counts are `Decimal(5, 2)`**, and `roundDays` matches.
- **Every period boundary is date-only.** `periodFor` builds in UTC and formats
  with `toFormat('yyyy-MM-dd')`; `dayKeyToDate` appends `T00:00:00.000Z`. A
  period boundary put through an instant parse is the previous day anywhere west
  of Greenwich, which is how a September run starts paying against August's last
  day.
- **Currency has one source.** A structure's currency must match the employee's
  active contract, named in both directions when it does not. A run takes its
  currency from the most recently created ACTIVE contract, falling back to
  `OMR`.

### Seed

`apps/backend/prisma/seed.ts` seeds **six salary components** in
`seedSalaryComponents()` — `BASIC`, `HRA`, `TRANSPORT`, `OTHER_ALLOW`
(earnings), `SOCIAL_SEC_EE` (deduction) and `SOCIAL_SEC_ER`
(employer contribution). These pre-dated this work.

`seedSalaryStructures(employees)` runs after `seedContracts`, since a structure
follows a contract. One per active employee, upserted on `employeeId` — the
natural unique key, so a re-run updates the one structure rather than inserting
a second the constraint would refuse. The whole line set is replaced on each
run, exactly as `PATCH` does, so a changed split here leaves no stale line
behind. Amounts derive from the contract salary: `BASIC` 60%, `HRA` 25%,
`TRANSPORT` 10%, `OTHER_ALLOW` 5%, `SOCIAL_SEC_EE` 7% of basic,
`SOCIAL_SEC_ER` 10.5% of basic. **The percentages are how the seed derives the
figures once, at seed time — they are not a runtime rule.** Every stored
`amount` is absolute, which is what the calculator reads.

`seedPayrollRuns(employees)` seeds three runs so every screen has a population:
one `PAID` two months back, one `APPROVED` last month, one `CALCULATED` waiting
on a decision. Runs are upserted on `(periodStart, periodEnd)` and payslips on
`(payrollRunId, employeeId)`. **The amounts come from the real calculator** —
`calculatePayslip` and `resolvePaidDays`, imported from `src/payroll/` — run
against the seeded attendance and the seeded structures. Hand-written figures
would drift from what the app computes the first time the calculator changed,
and the demo would start disagreeing with the thing it demonstrates.

**EMP-0021 (Reem Al Saadi) is left without a structure on purpose.** The
pre-flight and the hub's attention strip exist to name somebody the run cannot
safely pay, and a demo where every card reads zero cannot show that the card
works. She is also the newest hire, which is the realistic version of the case.

**`seedAttendance` was extended from 30 days to 100** (`ATTENDANCE_DAYS_BACK`).
The seeded runs cover the two previous periods, and a period with no attendance
behind it is precisely what the pre-flight calls a BLOCKER — a seeded run built
on one would pay a full month against a month nobody recorded, demonstrating the
mistake instead of the guard.

A seeded run produces 19 structures and 57 payslips across the three periods,
40 of which carry a real LOP line.

---

## 6. Tests

| Suite | Where | Count |
| --- | --- | --- |
| Backend unit (jest) | `src/payroll/*.spec.ts` | 106 |
| Backend unit (jest) | `src/salary-structures/salary-structures.service.spec.ts` | 21 |
| Backend unit (jest) | `src/salary-components/salary-components.service.spec.ts` | 15 |
| Backend API (supertest, e2e DB) | `apps/backend/test/payroll.e2e-spec.ts` | 55 |
| Frontend unit (vitest) | `utils/payrollTotals.test.ts` | 10 |
| Frontend unit (vitest) | `components/layout/navConfig.test.ts` | 27 (4 payroll-specific) |
| Frontend component (vitest) | `components/payroll/**/*.test.tsx` | see the files |
| Playwright | `e2e/specs/payroll*.spec.ts`, `salary-structures.*`, `payslips.employee.*` | see the files |

`npx jest` across the backend is green — 20 suites, 319 tests, of which the
payroll surface contributes 142. `bash scripts/test-api.sh` is green — 5 suites,
141 tests, the payroll spec contributing 55.

The API spec isolates itself by **period rather than by table**: a payroll run is
history the application never deletes, so it claims free months from a sandbox
window (2022-02 … 2024-12) that neither the seed nor the hub's 6/12-month look-back
can see. No assertion anywhere depends on a whole-table count.

Playwright projects are `anonymous | admin | hr | payroll | employee`, selected
by the filename segment. There is **no `manager` project and no manager seed
account**, so manager-scoped paths get backend coverage only — the gap is real
and recorded rather than hidden behind a skipped test.

What the tests actually pin down, rather than restate:

- an employer contribution stays out of gross, deductions **and** net, while
  still appearing on the payslip;
- LOP prorates the whole earning set, is capped at gross, and floors net at
  zero;
- a month with zero working days produces **no LOP**, not a division by zero;
- the lines add up to the totals **exactly**, and the order is identical on
  every run;
- a missing attendance row pays the day, a duplicate row does not dock it twice,
  and an absence on a closed day costs nothing;
- `calculate()` refuses in the same words the pre-flight used;
- `approve()` puts the expected status in the `where` rather than reading first;
- a rejection reason is cleared by the next calculation;
- an employee is refused another employee's payslip, and cannot see their own
  draft one;
- the hub's `changePct` is `null` — not `0` — against a period that paid
  nothing;
- `months=7` is refused rather than defaulted;
- a person in two open runs is counted once;
- a structure with an earning line of zero is refused, because it pays nobody
  anything.

---

## 7. What changed from HRM

| HRM | Here | Why |
| --- | --- | --- |
| `Payroll` / `PayrollItem` / `PayrollItemLine` | `PayrollRun` / `Payslip` / `PayslipLine` | The target's models already existed, with the payslip-denormalisation rationale already in their docblocks. Building onto them beat porting HRM's shapes over the top. |
| `PayrollStatus { DRAFT PENDING_APPROVAL APPROVED REJECTED LOCKED }` | `PayrollRunStatus { DRAFT CALCULATED APPROVED PAID CANCELLED }` | This schema's existing enum, untouched. `REJECTED` becomes DRAFT + `rejectionReason`, because a rejected run's next state is "being fixed", not a terminal one. `LOCKED` becomes `PAID`. |
| `Employee.salaryType` — `MONTHLY` vs `DAILY`, with a separate hourly-rate formula per basis | **Monthly only** | This schema has no `salaryType` and no `baseSalary` on `Employee`. There is nothing to branch on, and inventing a column to carry a basis nothing else in the repo understands would be a schema change outside this module's remit. |
| `resolveContractedRates` splitting a rate into `basicRate` + `allowanceRate` + `fullRate` | Proration applies to the **earning set** | HRM split the rate because its payslip did not itemise. This model is line-first. Not a behaviour change: HRM's MONTHLY branch divides `fullRate`, not `basicRate`. |
| `resolveSalary` reading `Employee.baseSalary` + components | `resolveStructures` reading `SalaryStructure` | Pay is defined by a structure here, so the pre-flight has **two** cases where HRM had one: no structure at all, and a structure with no earning line. The fix differs — create one, or add a line to the one that exists. |
| Payroll writes are ADMIN + HR_MANAGER | Writes are ADMIN + **PAYROLL_OFFICER**; HR_MANAGER reads only | Read off `utils/permissions.ts`, which already gave `PAYROLL_OFFICER` `MANAGE_PAYROLL` and HR_MANAGER only `VIEW_ALL_PAYROLL`. The separation of duties (approve is ADMIN-only) is the same on both sides. |
| Six reports: `register`, `cost`, `statutory-summary`, `ytd`, `gratuity-liability`, `variance` | Four: `register`, `cost`, `statutory`, `ytd` | `gratuity-liability` needs an end-of-service calculator that is out of scope; `variance` needs run versioning, which is also out. |
| `GET /payrolls/my-payslips/list`, `/my-payslips/:itemId`, `/my-ytd-summary` | `GET /payslips/my`, `/payslips/my/:id` | Self-service lives on its own resource rather than under the run. **There is no self-service YTD route** — `ytd` is a privileged report only, recorded as a gap rather than half-built. |
| `lock` / `unlock`, `create-revision`, `:id/history`, `bulk-approve` | None | Run versioning and unlock-relock are out of scope. Recorded as pending. |
| `payroll-batches/`, `payroll-calendar/`, `payroll-features.service.ts` | None | Batches, calendar periods with cut-off enforcement, and feature flags are out of scope. Recorded as pending. |
| `PayrollRunType { REGULAR OFF_CYCLE BONUS … }` | No run type at all | Off-cycle, bonus and final-settlement runs are out of scope, and a column with one legal value is worse than no column. |
| `hasBlocker` did not exist | Exported from `payroll-preflight.rules.ts` | The pre-flight needed one predicate both it and `calculate()` could ask, so that "ready" and "generate" cannot disagree. |
| Payroll re-derives its own working days | `AttendanceCalendarService` | This repo already resolves a branch's working day there. Re-deriving it would give a payslip and an attendance report different answers about the same month. |
| `exceljs` export inside the reports service | `payroll-export.service.ts` | A workbook builder is not a query. `exceljs` was already a backend dependency and unused. |

### Shared files touched

| File | Edit |
| --- | --- |
| `apps/backend/prisma/schema.prisma` | Additive fields on `PayrollRun`, `Payslip` and `PayslipLine` only, inside the `// PAYROLL` section. No enum change, no change to `Employee`, no change to the three salary models. |
| `apps/backend/prisma/seed.ts` | `seedSalaryStructures` and `seedPayrollRuns`, plus their calls in `main()`. `ATTENDANCE_DAYS_BACK` raised from 30 to 100 — see [Seed](#seed). |
| `apps/backend/src/app.module.ts` | Import and register `SalaryComponentsModule`, `SalaryStructuresModule`, `PayrollModule`. |
| `apps/backend/src/main.ts` | One `.addTag('Payroll', …)`. |
| `apps/frontend/components/layout/navConfig.ts` | `hubRoles` + six children on the admin group; the manager and employee entries re-pointed at `/dashboard/my-payslips`. |
| `apps/frontend/components/layout/navConfig.test.ts` | Two existing assertions updated for the re-point, plus three new ones guarding it. |
| `apps/frontend/messages/{en,ar}/sidebar.json` | The six child labels and `myPayslips`. |
| `apps/frontend/messages/{en,ar}/moduleLanding.json` | The module title, subtitle and one `desc` line per tile. |
| `apps/frontend/types/payslip.ts` | `payrollRun` added to `Payslip` — the service decorates it onto every row. |
| `apps/frontend/types/payroll.ts` | The four report shapes corrected against the wire. |
| `apps/frontend/utils/chartAxis.ts` + its test | `axisFor` returned ticks in display order while `BarOverviewChart` reverses them itself. The two cancelled, so the axis drew 0 at the top with the bars hanging downwards. **The Schedules hub was drawing the same way and is fixed by the same change.** |

That is the whole list. In particular **`attendances/` is not edited**:
`AttendanceCalendarService` is already exported by `AttendancesModule`, so
`PayrollModule` imports the module and reads the calendar through the existing
service.

`utils/chartAxis.ts` is the one edit outside the plan's list. It is shared
infrastructure, its contract is defined by its only consumer — `BarOverviewChart`,
whose own `yAxisTicks` default is ascending — and the bug was visible on two
hubs, not one. Fixing it at the payroll call site alone would have meant writing
a compensating double-reverse here and knowingly leaving the Schedules chart
upside down.

Two of these are worth stating as deviations from the plan rather than as line
items. `messages/{en,ar}/index.ts` was **not** given a `payroll` namespace — see
[Translations](#translations) for why. And `ATTENDANCE_DAYS_BACK` is a change to
another module's fixture, made because the payroll seed could not otherwise
produce an honest demo.

### Left out, and why

| Not built | Reason |
| --- | --- |
| Percentage-of-basic salary rules | Fixed amounts only, matching HRM's live engine. Adding it later is one nullable enum column plus one branch in the calculator. |
| Statutory tax and social-insurance **calculators** | The components exist as catalogue rows with typed amounts. Deriving them needs a rate table and jurisdiction rules the platform does not have. |
| Gratuity / end-of-service | `SalaryComponent.isGratuityBase` is captured and stored, so the input is ready. Nothing reads it yet. |
| Bank transfer files | No banking integration in the repo. |
| Garnishments, leave encashment, carry-forward | Each needs its own model. |
| Run versioning, unlock-relock, payroll batches, payroll calendar periods and cut-off enforcement, off-cycle / bonus / final-settlement run types | Out of scope for a base system; each is recorded as a seam with its contract. |
| Notifications, the approval engine, audit logging | No `MailModule`, no `NotificationsModule`, and no audit interceptor in the repo. The `AuditLog` model exists but only `auth.service.ts` writes to it, and only a `LOGIN` row — no business write in any module is audited. |
| The overtime lane and paid-leave classification | No `OvertimeRequest`, no `LeaveRequest`. `ON_LEAVE` is treated as paid. |

Every one is named with the contract a counterpart module can build against in
[interconnections-payroll.md](interconnections-payroll.md) §7.
