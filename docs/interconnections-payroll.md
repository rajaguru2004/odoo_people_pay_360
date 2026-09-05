# Payroll — interconnections

Which modules the Payroll module touches, in which direction, what the contract
between them is, and what breaks if one side moves.

Companion to [payroll-walkthrough.md](payroll-walkthrough.md).

---

## Map

```
                        ┌─────────────────────┐
      paid days from    │   Time & Attendance │  owns the branch calendar
        ◄───────────────┤   (attendances/)    ├────────────────►
                        └──────────┬──────────┘
                                   │ AttendanceCalendarService
                                   │ Attendance rows (status per day)
                                   ▼
   ┌──────────────┐        ┌───────────────┐        ┌────────────────────┐
   │  Employees   │◄───────┤    PAYROLL    ├───────►│ Salary Structures  │
   │  Departments │ scope  │ runs·payslips │ reads  │ Salary Components  │
   │  Branches    │        │  hub·reports  │        │  (owns the rows)   │
   └──────────────┘        └───────┬───────┘        └────────────────────┘
                                   │
                    currency +     │                          │
                    ACTIVE check   ▼                          ▼
                            ┌──────────────┐          ┌──────────────┐
                            │  Contracts   │          │   Holidays   │
                            └──────────────┘          └──────────────┘
```

Everything above already exists in this repository. **Nothing in the payroll
backend is waiting on a counterpart that has not been built** — the pending
items in §7 are capabilities the *platform* does not have.

The one thing that **is** unbuilt is on this module's own side of the line: the
payroll frontend has types, services, hooks and `utils/payrollTotals.ts`, but no
route and no component. §6 says exactly which contracts that leaves unfulfilled.

---

## 1. Salary Components and Salary Structures — where "what to pay" is defined

**Direction:** Payroll (read) and the two salary modules (write) share three
tables.
**Status:** implemented, both sides.

| | |
| --- | --- |
| Tables | `salary_components`, `salary_structures` (`employee_id @unique`), `salary_structure_lines` (`@@unique([structure_id, component_id])`) |
| Payroll reads | `PayrollRunsService.gatherFacts` loads `salaryStructure` with `lines.component` — never writes any of the three |
| Components written by | `POST /salary-components`, `PATCH /:id`, `POST /:id/deactivate`, `POST /:id/activate` — ADMIN + PAYROLL_OFFICER |
| Structures written by | `POST /salary-structures`, `PATCH /:id`, `DELETE /:id` — ADMIN + PAYROLL_OFFICER (delete ADMIN only) |
| Shared rule | `calculatePayslip` and `isPayable` in `payroll/payroll-calc.util.ts` decide what a line set is worth; the structures service enforces the same "at least one positive EARNING line" rule on the way in |

The calculator reads exactly four properties off a component — `code`, `name`,
`type`, `sequence` — plus the line's `amount`. `isTaxable` and `isGratuityBase`
are stored and **read by nothing**; they are the inputs a tax calculator and a
gratuity calculator will need (§7.7, §7.3).

**If a component's `type` changes:** it cannot. `UpdateSalaryComponentDto` omits
both `code` and `type`, because turning an earning into a deduction would change
the meaning of money already paid under it, and renaming a code would orphan
every report that groups by it. The route to change either is: deactivate, then
create the successor.

**If a component is deleted:** it cannot be. There is no DELETE route.
`PayslipLine.componentId` declares `onDelete: SetNull`, which keeps a payslip
readable if a row ever does go away — but a component that has paid somebody is
part of a legal record, so retirement is `isActive: false`.

**If a structure is edited:** `PATCH` with `lines` **replaces** the whole set
inside one transaction. A merge cannot express a removal, and a pay revision
that drops an allowance is exactly the case the screen exists for. Existing
payslips are untouched — they snapshot their own lines.

**Why they are not one module with payroll:** `SalaryStructuresService` owns
rows — assign one, edit one. `PayrollRunsService` answers "what does this month
cost". Merging them puts a month-wide payslip generation inside the assignment
write path.

---

## 2. Time & Attendance — paid days and the branch calendar

**Direction:** Payroll → Attendance (consumer).
**Status:** implemented.

`PayrollModule` imports `AttendancesModule` for `AttendanceCalendarService`,
which it already exports. **Nothing in `attendances/` is edited.**

| Method | Used for |
| --- | --- |
| `branchConfigs()` | Every branch's calendar, loaded once per run. |
| `configFor(configs, branchId)` | One branch's calendar, falling back to the company. |
| `holidayIndex(from, to)` | The period's holidays, by day key. |
| `isBranchWorkingDay(config, dayKey, index)` | The predicate that produces the working-day set. |

Plus, from `attendances/attendance-calendar.util.ts`: `toDayKey`,
`dayKeyToDate`, `DAY_KEY_PATTERN` and `rate` — the last of which is why a
payroll rate is `null` rather than `0` when there is nothing to divide by.

`Attendance` rows themselves are read raw — `employeeId`, `date`, `status` — and
turned into paid days by `payroll-attendance.util.ts`.

**Why not re-derive the calendar:** two definitions of "working day" is how a
payslip and an attendance report start disagreeing about the same month. A
payslip's `workDays` is a stored number an employee will query; it has to be the
same number the attendance page showed them.

**If `AttendanceStatus` gains a value:** `UNPAID_WEIGHT` in
`payroll-attendance.util.ts` is a `Partial<Record<AttendanceStatus, number>>`
with a `?? 0` fallback, so a new status is **silently paid**. That is the safe
default — a missing row is already paid — but any new status meaning "not at
work and not entitled to pay" must be added there explicitly, or the workforce
is quietly overpaid for it.

**If `isBranchWorkingDay` or the branch-beats-company holiday precedence
changes:** `workDays` moves on every payslip generated afterwards, and with it
the LOP denominator. Payslips already written keep their stored `workDays`,
`paidDays` and `lopDays` — that is what those columns are for — so the change
does not rewrite history, but two adjacent months will have been computed under
two rules.

**If an attendance import fails:** nothing breaks and everybody is paid a full
month. This is deliberate (§4.2 of the walkthrough) and it is the single reason
the `NO_ATTENDANCE_AT_ALL` **blocker** exists.

### The other direction

Attendance reads nothing from payroll. `attendance-hub.service.ts` and
`attendance-calendar.service.ts` do not import anything from `payroll/`, and no
payroll column was added to any attendance table.

---

## 3. Employees, Departments, Branches — scope and the reporting axes

**Direction:** Payroll → each (consumer).
**Status:** implemented.

| Read | For |
| --- | --- |
| `Employee.status` | The run population is `status: { not: TERMINATED }`. The hub's cards count `ACTIVE` only. A structure cannot be assigned to a TERMINATED employee. |
| `Employee.hireDate` | `OR: [{ hireDate: null }, { hireDate: { lte: periodEnd } }]` — somebody hired after the period closed was not employed in it. A null hire date is included rather than excluded. |
| `Employee.branchId` | Which branch calendar produces that person's working days. |
| `Employee.departmentId` | The cost report's default axis. |
| `Employee.employeeCode` | The population's sort order, and the register. |
| `Employee.position` | The payslip header and the register. |
| `Department.id`, `.name` / `Branch.id`, `.name` | The two `groupBy` axes on `GET /payroll/reports/cost`. |
| `Company.timezone` | `companyToday()` — which month "now" falls in. |

**A terminated employee is still paid, if their termination falls inside the
period.** The filter is `not: TERMINATED` on the employee's *current* status, so
somebody terminated before the run is generated drops out of it — including a
run for a month they worked. That is a known sharp edge of the current filter,
not a decision the code states a reason for; the final-settlement run type that
would answer it properly is out of scope (§7.10).

**If an employee has no department or branch:** the cost report buckets them
under the literal string `Unassigned` and reports `id: null`. A real bucket, not
a dropped row.

**A person who moves department is reported under the department they are in
now.** The unit is denormalised nowhere on the payslip, so `cost` joins live.
That is the honest answer to "what does this department cost", which is the
question the page asks — but it means last month's cost report can change shape
after a reorganisation. If a point-in-time answer is ever needed, it needs a
department column on `Payslip`, which is a schema change nobody has asked for.

**If `Employee` is hard-deleted:** it cannot be. `Payslip.employeeId` declares
`onDelete: Restrict`, so the database refuses. `SalaryStructure` cascades, which
is correct — a structure is a live instruction, not a record.

---

## 4. Contracts — currency and the "somebody forgot" warning

**Direction:** Payroll and Salary Structures → Contracts (consumer).
**Status:** implemented.

Payroll reads exactly two things off a contract:

| Read | Where | Effect |
| --- | --- | --- |
| `status === 'ACTIVE'` | `resolveContracts` in `payroll-preflight.rules.ts` | A `NO_ACTIVE_CONTRACT` **WARNING**, never a blocker. |
| `currency` | `PayrollRunsService.resolveCurrency`, `SalaryStructuresService.resolveCurrency` | The run's currency; and a structure whose currency disagrees with the contract is refused, naming both. |

**Payroll does NOT read `Contract.salary`.** This is worth stating plainly,
because it is the opposite of what a reader expects and the opposite of how HRM
works. The contracted rate on the contract is not an input to any payslip. What
an employee is paid is the sum of their `SalaryStructureLine` amounts, and
nothing reconciles the two. A contract that says 1,200 and a structure that adds
up to 900 will produce a payslip for 900 and no warning at all.

**The warning is a warning on purpose.** Refusing the whole run over one lapsed
record would strand everybody else. But an employee with no active contract is
usually a renewal somebody forgot, and paying them without saying so is how it
stays forgotten.

**If contract statuses change:** the filter is the literal `'ACTIVE'` in three
places — `resolveContracts`, `PayrollRunsService.resolveCurrency`, and
`SalaryStructuresService.resolveCurrency`. A new status that also means "in
force" must be added to all three, or every renewal starts warning and the
currency check stops firing.

**If a contract is in a different currency from the structure:** the structure
write is refused with both currencies named. Two currencies against one employee
is not a rounding problem — the run totals in one and the contract promises the
other, and nothing in the system can say which the employee is owed.

**Run currency has a weaker rule than structure currency.**
`PayrollRunsService.resolveCurrency` takes the **most recently created ACTIVE
contract's** currency for the whole run, falling back to `'OMR'`. A workforce
genuinely split across two currencies would be totalled in one of them. Nothing
detects that today; a mixed-currency run is a seam, not a supported case.

---

## 5. Holidays

**Direction:** Payroll → Holidays (consumer, through `AttendanceCalendarService`).
**Status:** implemented.

Payroll never queries the `holidays` table. It calls `holidayIndex(from, to)`
and lets `isBranchWorkingDay` apply it, which means a branch-specific row beats
a company-wide one on a shared date — the same precedence every other module
sees.

A holiday is therefore **not a working day**, so it is not in the LOP
denominator and an absence recorded on it costs nothing. `AttendanceStatus`
`HOLIDAY` also carries a weight of 0, so the day is harmless from both
directions.

**If the branch-beats-company precedence flips:** the working-day count changes
for every branch that overrides a company holiday, and with it every LOP figure
computed afterwards. Payslips already written keep their stored counts.

**If a holiday is added retroactively, inside a period already paid:** nothing
recomputes. The payslip states the `workDays` it was generated against. Deciding
whether that is a correction to make is a business decision the module does not
take.

---

## 6. Frontend contracts

**Status: partially implemented.** The data layer exists; the UI does not.

### Query keys — implemented

Five factories, each with its own root:

| Factory | `all` | File |
| --- | --- | --- |
| `payrollKeys` | `['payroll-runs']` | `hooks/usePayrollRuns.ts` |
| `payslipKeys` | `['payslips']` | `hooks/usePayslips.ts` |
| `payrollHubKeys` | `['payroll-hub']` | `hooks/usePayrollHub.ts` |
| `salaryComponentKeys` | `['salary-components']` | `hooks/useSalaryComponents.ts` |
| `salaryStructureKeys` | `['salary-structures']` | `hooks/useSalaryStructures.ts` |

Five roots rather than one, unlike Schedules. A payroll write does not
invalidate everything: approving a run changes the run, the hub and the
payslips, but not the salary component catalogue, and re-fetching the catalogue
on every approval is work with no reader.

**If a new payroll read is added:** it goes under an existing factory. A guessed
key is a stale screen nobody can reproduce.

### One place money is added up — implemented

`utils/payrollTotals.ts` exports `payslipTotals`, `runTotals` and `totalCost`,
and the summary cards and the payslip table on the same screen must both read
it. A card totalling the response while a row totals its own lines is how a page
ends up showing two different net figures for the same run.

It encodes the calculator's three rules on the client: employer contributions
sit outside every bucket, net floors at zero per payslip, and **money arrives as
a `Decimal(18, 3)` string** — `'1250.500' + '90.250'` is string concatenation,
which is why every amount goes through `toAmount`.

**If `calculatePayslip` changes, `payrollTotals.ts` moves with it.** Two
definitions of "net" is how the server and the browser disagree about a payslip.

### The error envelope — the rule, unexercised

The axios interceptor rejects with a **flat** object. Every catch in this module
must go through `apiErrorMessage(err, fallback)`; reaching for
`err.response.data.message` silently falls through to the generic fallback and
the user is told nothing.

The backend's refusal messages are written to be read by a person — "This
employee has 3 payslips already, so their salary structure cannot be deleted",
"months must be 6 or 12", "The Aug 2026 run is DRAFT. Payroll reports read
locked runs only…". None of that reaches anybody until a screen renders it.

### The Excel download — implemented in the service

`payrollRunService.exportXlsx` uses `responseType: 'blob'`, which
`lib/axios.ts` passes through untouched, and returns the raw `AxiosResponse`
rather than the `{ success, data }` envelope. A caller that destructures `data`
off it expecting the envelope gets the blob, which is correct but easy to
misread.

### Navigation and permissions — NOT yet aligned

`utils/permissions.ts` already carries the five payroll strings, and they are
the source the server's decorators were written from:

| Permission | Roles |
| --- | --- |
| `VIEW_ALL_PAYROLL` | ADMIN, HR_MANAGER, PAYROLL_OFFICER |
| `MANAGE_PAYROLL` | ADMIN, PAYROLL_OFFICER |
| `APPROVE_PAYROLL` | **ADMIN only** |
| `VIEW_OWN_PAYSLIP` | all five roles |
| `MANAGE_SALARY_COMPONENTS` | ADMIN, PAYROLL_OFFICER |

These are **UI affordances**, not a security boundary: every one has a
`RolesGuard` counterpart server-side.

`components/layout/navConfig.ts` carried a `payroll` entry in all three menu
trees — `menuItems`, `departmentHeadMenuItems` and `employeeMenuItems` — every
one pointing at `/dashboard/payroll` with no `hubRoles` and no children. That
route is the **hub**, and `GET /payroll/hub-summary` is ADMIN + HR_MANAGER +
PAYROLL_OFFICER only, while MANAGER and EMPLOYEE hold just `VIEW_OWN_PAYSLIP`.
Left alone, those two roles would have clicked their own sidebar into a 403.

**What was done:**

| Tree | Roles | `href` now | Why |
| --- | --- | --- | --- |
| `menuItems` | ADMIN, HR_MANAGER, PAYROLL_OFFICER | `/dashboard/payroll` | Plus `hubRoles` mirroring `@Roles` on the aggregate, and six children. |
| `departmentHeadMenuItems` | MANAGER | `/dashboard/my-payslips` | Re-pointed. The hub is a 403 for this role. |
| `employeeMenuItems` | EMPLOYEE | `/dashboard/my-payslips` | Re-pointed, same reason. |

The `runPayroll` child is narrowed further to ADMIN + PAYROLL_OFFICER, mirroring
`POST /payroll-runs`: an HR manager reads payroll and does not run it.

`components/layout/navConfig.test.ts` asserts both directions — that MANAGER and
EMPLOYEE get `myPayslips` and never `payroll`, and that `runPayroll` reaches only
the roles the server accepts it from. That test is the standing guard against
this class of defect, which `docs/MIGRATION.md` §8 records once already.

**Translations.** `messages/{en,ar}/sidebar.json` carry the six child labels and
`myPayslips`; `messages/{en,ar}/moduleLanding.json` carry the module's title,
subtitle and a `desc` line per tile. No `payroll` namespace was registered in
`messages/*/index.ts`: the hub reads `moduleLanding`, the rail reads `sidebar`,
and the remaining payroll screens follow the untranslated `contracts` /
`employees` precedent, so the namespace would exist with nothing reading it.

---

## 7. Pending — capabilities this module deliberately excludes

None of these block the module as a base system. Each is a seam, named with the
contract the counterpart can build against.

### 7.1 Leave and overtime — the two that touch the calculator directly

Leave & Overtime is an approved but **unimplemented** module. There is no
`LeaveRequest` and no `OvertimeRequest` model in this schema.

**What that means today:** `UNPAID_WEIGHT.ON_LEAVE = 0`. Leave is paid, all of
it, because there is nothing to ask whether a particular leave was approved as
unpaid. A month of unpaid sabbatical is currently paid in full unless somebody
also writes `ABSENT` rows for it.

**Paid-leave classification — the contract:** when a leave module lands, the
seam is `payroll-attendance.util.ts`. `resolvePaidDays` needs a second input —
the approved-leave decisions for the period, keyed by day — and `ON_LEAVE` must
resolve through it rather than through the constant. The weight belongs in that
one function, not spread across the run service, so the unit test that pins it
keeps working.

**Overtime — the contract:** overtime is money the calculator does not currently
know about. It arrives as an additional `EARNING` line, computed by the overtime
module and handed to `calculatePayslip` alongside the structure's lines — **not**
computed inside `payroll-calc.util.ts`. Tiered rates (weekday, rest day, public
holiday) are the overtime module's rules; payroll's job is to pay the figure and
snapshot it on the payslip. Note that an overtime line added this way **would be
prorated by LOP**, which is wrong — overtime is earned per hour worked, not per
month contracted. Whoever adds it must exclude it from the proration base, which
is a change to `calculatePayslip`'s earning split.

HRM's `payroll-edge-leave` and `payroll-edge-overtime` specs stay deferred:
they assert against models that do not exist.

### 7.2 WPS wage files

No wage-protection-system export. The contract: a fixed-width or CSV file per
run, per bank, over `APPROVED`/`PAID` payslips only, requiring an employer
establishment id, each employee's bank IBAN and a labour-card number — **none of
which exist as columns** on `Company`, `Employee` or anywhere else.

**When it lands:** it belongs beside `payroll-export.service.ts`, reading the
same locked-run set the reports read, and it must read the payslip's snapshotted
lines rather than the structure behind them.

### 7.3 Gratuity / end-of-service

`SalaryComponent.isGratuityBase` exists, is settable through the API, and is
**read by nothing**. It is the input a gratuity accrual needs: the subset of
earning components that count toward the accrual base.

**When it lands:** an accrual is a liability, not a payslip line, so it needs its
own table rather than a component. HRM's `gratuity-liability` report is the shape
to aim at; it was left out here for exactly this reason.

### 7.4 Advances and loans

`LOAN_REPAY` exists as an ordinary `DEDUCTION` component. That means an amount
somebody types into a structure and which then repeats every month forever —
there is no principal, no balance, no schedule and no stopping condition.

**The contract:** a loan module owns the balance and the instalment schedule, and
hands payroll a per-employee, per-period deduction amount at generation time.
Payroll writes it as a normal `DEDUCTION` line and reports the amount back so the
balance can be decremented **only for runs that reach `PAID`** — a cancelled run
must not repay a loan. Nothing exists today to carry that acknowledgement.

### 7.5 Garnishments

Court-ordered deductions with statutory priority ordering and a protected-earnings
floor. Nothing in `calculatePayslip` orders deductions by priority — they are
summed — and `netPay` floors at zero rather than at a protected minimum.

**When it lands:** the ordering and the floor both belong in
`payroll-calc.util.ts`, because they change what the net is, not merely what is
displayed.

### 7.6 Reimbursements

Expense claims paid through payroll. They are `EARNING` lines that must **not**
be prorated by LOP — an expense already incurred is not reduced by absence — and
usually not taxable. The same earning-split change §7.1 describes for overtime.

### 7.7 Statutory tax and social-insurance calculators

`SOCIAL_SEC_EE` and `SOCIAL_SEC_ER` are catalogue components with a typed amount.
Nothing computes them from a rate, a ceiling or a nationality rule, and
`SalaryComponent.isTaxable` is stored and read by nothing.

**The contract:** a calculator module resolves, per employee per period, a set of
statutory line amounts from the taxable earning subset (`isTaxable: true`), and
hands them to `calculatePayslip` as `DEDUCTION` and `EMPLOYER_CONTRIBUTION`
lines. Payroll must not grow a rate table.

### 7.8 Leave encashment and carry-forward

Both are leave-balance concepts. Encashment is an `EARNING` line the leave module
computes; carry-forward never reaches payroll at all. Neither is representable
without a leave balance.

### 7.9 Run versioning and unlock-relock

HRM has `POST /payrolls/:id/lock`, `/unlock`, `/create-revision` and
`GET /:id/history`. None ships here. `PayrollRunStatus` has no version column and
`Payslip` has `@@unique([payrollRunId, employeeId])`, so a run holds exactly one
payslip per employee and a correction is a recalculation that **deletes and
replaces** the previous set.

**Consequence to know:** a corrected run keeps no record of what it said before
the correction. That is acceptable while corrections happen in `DRAFT` or
`CALCULATED` — the only statuses `calculate()` accepts — because nothing was
signed. It stops being acceptable the moment an approved run needs amending,
which is what versioning is for. HRM's `variance` report was dropped for the same
reason: it compares versions.

**When it lands:** a version column on `PayrollRun` plus a relaxed unique
constraint, and `RECALCULABLE` in `payroll-runs.service.ts` is the one list that
decides what may still move.

### 7.10 Payroll batches, calendar periods, cut-off enforcement, run types

HRM has `payroll-batches/`, `payroll-calendar/` and a `PayrollRunType` enum
(`REGULAR`, `OFF_CYCLE`, `BONUS`, …). None ships here.

- **Batches** — a run here is company-wide, optionally narrowed by an explicit
  `employeeIds` list on `POST /payroll-runs`. That list is the seam: a batch
  module supplies the ids.
- **Calendar periods and cut-off** — a period here is a calendar month,
  `periodFor(month, year)`, and `@@unique([periodStart, periodEnd])` prevents a
  duplicate. There is no cut-off date and no enforcement that a period is closed
  before it is run; the hub's `DRAFT_FOR_CLOSED_PERIOD` attention item is the
  only thing that notices a period has ended.
- **Run types** — no column. Off-cycle, bonus and final-settlement runs would
  each need one, and the `@@unique([periodStart, periodEnd])` constraint would
  have to include it, or a bonus run for August collides with August's payroll.

### 7.11 Bank transfer files

Distinct from WPS: a payment instruction file for a specific bank. Same missing
inputs — no IBAN on `Employee`, no employer account on `Company`. `markPaid` is
currently a status change a human makes after paying by other means; there is no
reconciliation with anything a bank returns.

### 7.12 Notifications

No `MailModule` and no `NotificationsModule` in this repo. Four events would want
one: a run reaching `CALCULATED` (tell the approver), a run rejected (tell the
officer, with the reason — which is already stored on
`PayrollRun.rejectionReason`), a run reaching `PAID` (tell the workforce their
payslip is available), and the hub's `DRAFT_FOR_CLOSED_PERIOD` (tell somebody
before the month is two months old).

**When it lands:** the fan-out belongs on the transition methods in
`payroll-runs.service.ts`, **outside** the `$transaction` — a mail failure must
not roll back an approval.

### 7.13 The approval engine

Approval here is one conditional `updateMany`, ADMIN-only, with no delegation, no
multi-tier chain, no threshold rules and no bulk approve. That is sufficient for
a base system and it is race-safe, which a read-then-write would not be.

**When a general approval engine lands:** the seam is `approve()` and `reject()`.
The conditional-update idiom must survive it — whatever decides *who* may approve,
the write itself has to keep the expected status in its `where`, or two approvals
racing both win and the second overwrites the first approver's name.

### 7.14 Audit logging

The repo has an `AuditLog` model, and exactly one thing writes to it:
`auth.service.ts` records a `LOGIN` row. There is no `@AuditResource` decorator
and no audit interceptor, so no business write anywhere in the app is audited.

Payroll is the module that most wants one: every transition changes what a
company owes people, and `approvedById` / `approvedAt` / `rejectionReason` on
`PayrollRun` are a hand-rolled audit trail covering exactly one of the five
transitions.

**When an audit interceptor lands:** it belongs on `PayrollRunsController`,
`SalaryStructuresController` and `SalaryComponentsController` — the three write
surfaces. `PayrollHubController` and `PayrollReportsController` are read-only and
should not carry it.

### 7.15 Percentage-of-basic salary rules

Not a missing module — a deliberate decision, recorded here because it is the one
place "match HRM" and "what a payroll clerk expects" differ. Every
`SalaryStructureLine` is an absolute amount. There is no `valueType` column and
no expression evaluator anywhere in either repository.

**When it is wanted:** one nullable enum column on `SalaryStructureLine` plus one
branch in `calculatePayslip`, resolving percentage lines against the `BASIC` line
**before** the LOP proration runs. It must not become a general expression
language; a rule the engine cannot read is a rule that quietly does nothing.

---

## 8. A note for the Schedules module's owner

[`interconnections-schedules.md`](interconnections-schedules.md) **§7.6
"Payroll"** currently reads:

> Not connected, and correctly so. Scheduled hours are a **plan**; payroll pays
> for what attendance **recorded**.

The first half is still true — payroll reads `Attendance`, never `WorkSchedule`,
and there is no import from `schedules/` or `work-schedules/` anywhere in
`payroll/`. But the section describes Payroll as a module that does not yet
exist, and it now does.

**That section needs updating by the Schedules module's owner. This branch does
not edit another module's doc.**

Two things are worth saying when it is updated:

1. The separation still holds and should stay. `payroll-attendance.util.ts`
   reads `Attendance.status` on the branch calendar's working days. It does not
   consult `WorkSchedule` at all, so a rostered shift neither creates nor
   removes a paid day.
2. The advice in the existing §7.6 — that a payroll run needing a planned figure
   should read `shiftHours` from `schedules/shift-window.util.ts` rather than
   recompute the window — remains exactly right, and remains unexercised. Shift
   allowances and night differentials are not built (they would be
   `SalaryComponent` rows whose amount somebody types today), so nothing in
   `payroll/` imports from `schedules/`. If either is ever computed rather than
   typed, that import is the seam, and the midnight crossing a naive subtraction
   gets wrong by sixteen hours is why.
