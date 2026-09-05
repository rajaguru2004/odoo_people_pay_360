# Leave & Overtime — walkthrough

Migrated from `human-resource-management`, where the same subsystem lives across
`apps/backend/src/{leave-requests,leave-balances,leave-attachments,overtime,overtime-policy,library-items}/`
and `apps/frontend/app/dashboard/{leaves,my-leaves,overtime,my-overtime}/`.

Adapted to this repository's conventions rather than copied: the data model, the
response envelope, the guard stack, the employee shape and the component library
all differ. Every difference is listed under
[What changed from HRM](#8-what-changed-from-hrm), and everything deliberately
left out is under [What is not built](#9-what-is-not-built).

---

## 1. What the module is

The module that turns **absence into a balance deduction** and **worked hours
into pay tiers**. Its correctness is measured in money, not in pixels.

Two halves on one rail, because they are the same trade: hours the company owes
against hours it has bought.

| Screen | Route | What it answers |
| --- | --- | --- |
| Leave & overtime hub | `/dashboard/leave` | What is owed, what is waiting, and who is working late. |
| Leave requests | `/dashboard/leaves` | Every request, by status, type and date. |
| Pending leave | `/dashboard/leaves/pending` | What is waiting on a decision, oldest first. |
| Leave request | `/dashboard/leaves/[id]` | One request, the balance behind it, and the decision. |
| File leave | `/dashboard/leaves/new` | Raise a request against a type's own rules. |
| Leave balances | `/dashboard/leaves/balances` | What everybody is entitled to, and what is left. |
| Leave types | `/dashboard/leave/types` | The types leave may be filed against, and their rules. |
| Leave allocations | `/dashboard/leave/allocations` | Accrual runs, bulk grants, and the record of both. |
| My leave | `/dashboard/my-leaves` | The caller's own balance and requests. |
| Overtime | `/dashboard/overtime` | Hours worked outside the shift, and how they are paid. |
| Log overtime | `/dashboard/overtime/new` | Record a worked window. |
| Overtime request | `/dashboard/overtime/[id]` | One request, the payable breakdown, and the decision. |
| Overtime policies | `/dashboard/overtime/policies` | The rate sets, and which employees each governs. |
| My overtime | `/dashboard/my-overtime` | The caller's own overtime. |

### The four rules the whole module rests on

1. **A leave request is priced ONCE, at filing, from the branch calendar.**
   `LeaveRequest.totalDays` is WORKING days — the branch weekly rest days and the
   holidays in force at that branch are already removed — and it is stored. A
   branch that changes its working week next quarter does not silently re-price
   leave somebody has already taken.

2. **Approval deducts BEFORE it writes `APPROVED`, in one transaction.** Nothing
   is reserved at filing, so two pending requests can each have passed the
   filing-time check against the same days. Status-first left the row APPROVED
   with attendance written and nothing deducted, while reporting a 400 to the
   caller — an approved absence nobody paid for, presented as a failure.

3. **Overtime is split into four hour buckets, not one total.** A window that
   crosses the late threshold is paid at two rates. One `hours` figure would have
   to be monetized at one rate, which is how an evening gets paid entirely at the
   higher tier or entirely at the lower one.

4. **A rate is `null`, never `0`, when there was nothing to divide by.** An empty
   month and a month where nothing was approved are different claims. The
   frontend renders `null` as an em dash.

---

## 2. Entry points

### Backend

| Folder | Owns |
| --- | --- |
| `apps/backend/src/library-items/` | The `LEAVE_TYPE` and `EMPLOYMENT_TYPE` pick lists, and their defaults. |
| `apps/backend/src/leave-balances/` | Entitlements, the monthly accrual, the company overview. |
| `apps/backend/src/leave-requests/` | Requests, decisions, the module hub, and the working-day helpers. |
| `apps/backend/src/leave-attachments/` | Evidence filed against a request (metadata only — see §9). |
| `apps/backend/src/overtime-policy/` | The rule sets, the inheritance chain, and the global config. |
| `apps/backend/src/overtime/` | Requests, the calc engine, decisions and reporting. |
| `apps/backend/src/common/hub/hub-range.util.ts` | Period/anchor arithmetic shared by module hubs. |
| `apps/backend/src/common/utils/manager-scope.util.ts` | Who may read and decide whose requests. |

### Frontend

| Layer | Files |
| --- | --- |
| Services | `services/leaveService.ts`, `overtimeService.ts`, `overtimePolicyService.ts`, `libraryItemService.ts` |
| Hooks | `hooks/useLeaveRequests.ts`, `useLeaveBalances.ts`, `useLeaveHub.ts`, `useOvertime.ts`, `useOvertimePolicies.ts`, `useLibraryItems.ts` |
| Types | `types/leave.ts`, `types/leaveHub.ts`, `types/overtime.ts` |
| Pure logic | `utils/overtimeCalc.ts`, `components/leave/leaveFormat.ts` |
| Components | `components/leave/LeaveRequestTable.tsx`, `OvertimeTable.tsx`, `components/leave/hub/*` |

---

## 3. Main functions

### `LeaveRequestsService` (`leave-requests/leave-requests.service.ts`)

| Method | What it does |
| --- | --- |
| `create` | Resolves the type from the library, checks the gender restriction, the notice period, the overlap and the balance; prices the request in working days; stores it PENDING. |
| `findAll` | Paginated, filtered, scoped to the caller. Date filters ask for **overlap**, not containment. |
| `stats` | Queue health. `avgDecisionHours` is `null` when nothing has been decided. |
| `findOne` | One request, guarded by `assertCanAccessRequestOf`. |
| `getTeamBalances` | What the people a manager is responsible for have left. |
| `approve` | Deduct → mark approved → write attendance, **in that order, in one transaction**. |
| `reject` | Records the reason; a rejection without one is refused by the DTO. |
| `cancel` | Withdraw a PENDING request. An approved one has already moved money. |

### `WorkingDaysService` (`leave-requests/working-days.service.ts`)

The branch calendar, answered over a RANGE.

| Method | Rule it carries |
| --- | --- |
| `getWeeklyOffDays` | Branch `weeklyOffDays` → the `attendance_weekly_off_days` setting → `[5, 6]`. An EMPTY branch array means *inherit*, not "works seven days". |
| `isHoliday` | `OR: [{ branchId: null }, { branchId }]` — a plain equality never matches the company-wide NULL row and would drop every national holiday. |
| `isWeeklyOff` | Reads the ISO weekday from **UTC noon**, not UTC midnight. |
| `getWorkingDatesBetween` | The dates themselves, so pricing and attendance-writing cannot disagree. |
| `getWorkDaysBetween` | Their count. |

**The noon rule.** Postgres `DATE` values arrive through the driver as midnight
in the SERVER's zone. On a +05:30 server the row `2026-08-24` comes back as
`2026-08-23T18:30:00Z`, and a raw UTC weekday reports Sunday for a Monday — every
leave request priced against the wrong calendar, silently, and only east of
Greenwich. Moving the instant to the middle of the day puts it past any such
offset in either direction before the weekday is taken. Covered by
`working-days.service.spec.ts`.

### `LeaveBalancesService` (`leave-balances/leave-balances.service.ts`)

| Method | Notes |
| --- | --- |
| `initBalance` | Creates the year's rows. Gender-restricted types are filtered out at creation, not allocated and hidden. |
| `getBalance` | **Looks like a read and is not** — it materialises rows, so it is guarded like a write. |
| `getAllBalances` | The HR grid. `headline: null` when the year was never initialised, never zeroes. |
| `deductDays` / `addDays` | Spend and refund. `deductDays` **throws** when short; leave approval depends on that. `addDays` floors `used` at zero. |
| `updateBalance` / `updateTypeBalance` | Allocations only; `used` is never touched. |
| `setBulkDefaultBalances` | Reset every allocation from the library. |
| `accrueLeaveForAllEmployees` | One day a month, idempotent through `LeaveAccrualHistory`. |
| `accrueLeaveForEmployee` | A manual credit, with a reason, on the record. |
| `getCompanyLeaveOverview` | Per-type totals; `utilisation` is `null` when nothing was allocated. |
| `getLeaveTypes` | The picker's source, with each type's own rules attached. |
| `monthlyAccrualTick` | `@Cron(EVERY_HOUR)`, gated on the 1st **in the company's timezone**. |

The accrual ticks hourly and the gate decides, rather than a cron firing at
midnight server time: a company in Muscat on a UTC server would otherwise be
credited four hours into the previous month, and the accrual would land in the
wrong year every January. Idempotence is in the database, not in the in-memory
flag — the flag only saves a query.

### `LeaveHubService` (`leave-requests/leave-hub.service.ts`)

`GET /leave-requests/hub-summary?period=&anchor=` — everything the landing page
draws, in ONE request. Fanning out to the list endpoints and counting rows off
them reports the length of a PAGE as a count.

Three things it gets right that the endpoints beneath it do not have to:

1. **A straddling request is prorated, not double-counted.** A ten-day leave
   running 28 Aug → 6 Sep is four days of August and six of September. The
   proration counts WORKING days through the same service that priced the
   request, so the halves add back up to `totalDays`. A request wholly inside the
   window keeps the number the request carries, rather than a recount that could
   differ at a branch whose calendar changed since.
2. **CANCELLED is counted.** Four statuses, so the donut's slices sum to the
   caption above them.
3. **Overtime is windowed and aggregated in the database**, not month-locked and
   reduced in memory off the first page of a list.

`attention.*` carries a COUNT plus a capped sample of names. The count is the
truth; the names are a task.

### `OvertimeService` (`overtime/overtime.service.ts`)

| Method | Notes |
| --- | --- |
| `create` | Eligibility, reason, window/hours agreement, day classification, daily cap, outside-work-hours, monthly and yearly caps, one-per-date. |
| `findAll` / `stats` | Paginated and scoped; `avgDecisionHours` is `null` when nothing has been decided. |
| `findOne` | One request plus the SERVER's `preview`. |
| `approve` | Persists an approver correction **before** recording the decision, then re-prices from the stored window. |
| `previewApproverEdit` | A dry run of a correction. Writes nothing. |
| `reject` / `cancel` | Reason required; withdrawal is the filer's or an administrator's. |
| `getApprovedOvertimeHours` | The four payable buckets for one employee-month — what a payroll run reads. |
| `getMonthlyReport` | Aggregated in the database, so a month with more than twenty requests reports the right money. |

### `overtime/overtime-calc.util.ts` — the engine

Pure, Prisma-free and Nest-free: rules that can only be exercised through a
database and an injector do not get exercised.

```
shift end 17:00, late threshold 22:00, worked until 23:00
  → 17:00–22:00 = 5h @ the regular multiplier
  → 22:00–23:00 = 1h @ the late multiplier
```

Two invariants, both covered by `overtime-calc.util.spec.ts`:

- **All arithmetic is UTC wall-clock.** Overtime times are stored tz-naive
  tagged UTC — an entered 17:30 is persisted as `…T17:30:00Z` — so UTC getters
  recover the entered hour on any server. Local getters drift by the server
  offset: on +05:30, 17:00 reads as 22:30 and every evening shift is classified
  as late.
- **The noon rule** for both the day boundary and the late threshold. A time
  before 12:00 is an early-MORNING clock time, which on an evening shift means
  the coming midnight and after — so it belongs to the NEXT calendar day. Without
  it, an administrator who stores an AM time meaning a PM one pays EVERY evening
  hour at the late multiplier: the threshold lands behind the overtime start, the
  regular tier collapses to zero, and `isLate` is true from the first minute. The
  rule is keyed on noon and **not** on "is the threshold before the start" — a
  22:00 threshold with a 22:30 start is genuinely late overtime and must stay
  same-day.

### `OvertimePolicyService` (`overtime-policy/overtime-policy.service.ts`)

The chain, top-down:

```
Employee override → Employment type → Company default → global settings
```

It **always resolves**. There is no kill switch on the engine: an employee
covered by nothing falls through to the company default, and only a database with
no policies at all reaches the globals. `onModuleInit` seeds the company default
on every boot — without it, every uncovered employee silently resolves to the raw
`overtime_*` settings, so rates edited on the Policies screen would never reach
them and there would be no editable surface for the rates that did.

`configForPolicyId` honours the snapshot an approved request carries **regardless
of the policy's current active flag**, so a request approved in March still
monetizes against the rules that classified its hours after the policy is retired
in June. A deleted policy falls back to the globals rather than throwing: it must
not make a historical payslip unreadable.

---

## 4. Logic worth knowing

### The order in `approve` (leave)

```ts
await this.prisma.$transaction(async (tx) => {
  await this.balances.deductDays(...);       // throws when short
  const row = await tx.leaveRequest.update({ status: APPROVED, ... });
  const { count } = await tx.attendance.createMany({ ..., skipDuplicates: true });
});
```

`skipDuplicates` because a day the employee actually clocked keeps its own
record: an approval must never overwrite real attendance. The skip COUNT is
returned in `meta` and printed in the response message — silently skipping meant
a day of approved leave had no `ON_LEAVE` row behind it and nobody knew.

The written rows are stamped with the branch. Without it they carry a null
`branchId`, and every branch-filtered view — the attendance list, the reports,
the logs — loses them while payroll still counts them.

### The order in `approve` (overtime)

The correction is persisted **before** the decision, and the finalize step then
recomputes from the STORED window — which is now the corrected one. Writing them
the other way round would have the approval freeze the numbers the employee
filed and then overwrite the times underneath them.

Three details in the finalize payload:

1. `foodAllowance` takes the override when there is one. **Null is not "no
   allowance"** — it means nobody overrode it, which is why the column is
   nullable and why the test is against `null` rather than falsiness. A 0 is a
   decision.
2. `siteAllowance` is deliberately **absent** from the payload. It is
   approver-granted with nothing to recompute it from, so naming it would zero it
   on every approval.
3. `originalStartTime` / `originalEndTime` are snapshotted on the FIRST edit
   only, so a second approver's correction cannot overwrite the original with an
   already-edited value.

### Who may decide

ADMIN and HR always; a MANAGER inside the departments they **manage**
(`Department.managerId`, not the department they sit in); and the **supervisor**
named on the employee's own record, whatever role they hold —
`Employee.supervisorId` is documented as *"who signs their leave and their
timesheet"*, and a supervisor who cannot approve is a queue that never empties.

Nobody decides their own request, however senior. An approval is a second pair of
eyes or it is nothing.

### Scoping a list

`scopeToCaller` is built from the PRINCIPAL, never from the query string: a scope
that trusts `?employeeId=` is one edited URL away from being no scope at all. The
principal's own id is ANDed with whatever was asked for, so naming somebody else
narrows the result to nothing and can never widen it.

`canAccessRequestOf` refuses an EMPLOYEE who is neither the owner nor the
supervisor **before** the manager-scope branch. That ordering is load-bearing:
`managerDepartmentIds` returns `null` (meaning "no narrowing") for every role
that is not a MANAGER, so falling through would have let any colleague read
anybody's leave reason by walking request ids. Covered by
`overtime-detail-preview.spec.ts`.

### The client does not price anything

The leave form does not compute `totalDays` and the overtime form computes only
the LENGTH of the window. Both depend on the employee's policy and on the branch
calendar, neither of which the browser has. A client-side estimate would
disagree with the balance the approval actually spends, and the reader would have
no way to tell which was right. `utils/overtimeCalc.ts` says so at the top.

---

## 5. Data

### New enums

| Enum | Values | Why |
| --- | --- | --- |
| `LibraryType` | `LEAVE_TYPE`, `EMPLOYMENT_TYPE` | Only the two this module reads. A library value nothing consumes is one an administrator can set and then wonder why nothing happened. |
| `OvertimeDayType` | `WEEKDAY`, `SUNDAY`, `HOLIDAY` | Stored, not derived: a request approved as HOLIDAY keeps its premium after somebody edits next year's calendar. |
| `OvertimeType` | `REGULAR`, `LATE`, `DOUBLE`, `DOUBLE_LATE` | The headline tier above the four buckets, not a replacement for them. |

### New models

| Model | Key columns | Notes |
| --- | --- | --- |
| `LibraryItem` | `libraryType`, `label`, `defaultDays`, `requiresNoticeDays`, `affectsBalance`, `genderRestriction` | `@@unique([libraryType, label])`. `label` is the KEY everything else stores. |
| `LeaveRequest` | `leaveType`, `startDate`/`endDate` `@db.Date`, `totalDays`, `status RequestStatus` | Indexed on `(employeeId, startDate)` and `status`. |
| `LeaveAttachment` | `fileUrl`, `fileSize BigInt?`, `deletedAt` | Soft delete. |
| `LeaveBalance` | `annualLeave`, `sickLeave`, `usedAnnual`, `usedSick`, `carriedOver` | `@@unique([employeeId, year])`. |
| `LeaveTypeBalance` | `leaveTypeKey`, `allocated`, `used`, `carriedOver` + four carry-forward columns | `@@unique([employeeId, year, leaveTypeKey])`. No `remaining` column. |
| `LeaveAccrualHistory` | `year`, `month`, `daysAdded`, `accrualType` | What makes the accrual idempotent. |
| `OvertimePolicy` | `name @unique`, `isDefault`, `employmentType`, `schemaVersion`, `rules Json` | Partial unique indexes in `prisma/sql/`. |
| `OvertimeRequest` | four hour buckets, `dayType`, `otType`, allowances, `overtimePolicyId` | `@@unique([employeeId, date])`. |

### Additions to existing models

| Model | Added |
| --- | --- |
| `Employee` | `employmentType String?`, `overtimePolicyId String?` + relation, and the back-relations for the five new tables. |
| `User` | Back-relations only: `leaveRequestsDecided`, `overtimeDecided`, `overtimeEdited`, `leaveAttachments`. |

### Why `label` is the key, not the id

`LeaveRequest.leaveType`, `LeaveTypeBalance.leaveTypeKey` and
`Employee.employmentType` all store the LABEL. A balance row has to keep naming
the leave it belongs to even after somebody deletes the library item, or a year
of history stops resolving. The cost is that renaming a library item does not
rename the history behind it — the correct trade for a record an auditor reads,
and the reason removing a type is a **deactivation** rather than a delete.

### The carry-forward columns nothing writes

`LeaveTypeBalance.carriedOverExpiresOn`, `carriedFromYear` and
`carryForwardRunId` ship unused. Year-end carry-forward and leave encashment are
deferred (see `interconnections-leave-encashment.md`), and the module that lands
them must not have to migrate a table this one owns — a migration on a live
balances table is exactly the change nobody wants to run twice.

### Partial indexes

Prisma's `@@unique` is unconditional; both rules below are conditional on
`is_active`. They live in `apps/backend/prisma/sql/leave-overtime-indexes.sql`:

```bash
npm run db:push
npx prisma db execute --file prisma/sql/leave-overtime-indexes.sql --schema prisma/schema.prisma
```

- one active **default** policy;
- at most one active policy per **employment type**.

Without them two rows can both claim the default and `findFirst` picks by
whatever order the planner happens to use — so the same employee resolves to
different overtime rates on different requests, and nothing in the data says
which answer was right. `db push` drops indexes it does not know about, so
re-running the SQL after every push IS the maintenance procedure.

---

## 6. Routes

### Leave

| Method | Route | Roles |
| --- | --- | --- |
| `GET` | `/leave-requests/hub-summary` | ADMIN, HR, MANAGER |
| `GET` | `/leave-requests/team-balances` | ADMIN, HR, MANAGER |
| `GET` | `/leave-requests/pending` | ADMIN, HR, MANAGER |
| `GET` | `/leave-requests/stats` | ADMIN, HR, MANAGER |
| `GET` | `/leave-requests/my-requests` | all |
| `GET` | `/leave-requests` | ADMIN, HR, MANAGER |
| `GET` | `/leave-requests/employee/:employeeId` | ADMIN, HR, MANAGER |
| `GET` | `/leave-requests/:id` | all (narrowed in the service) |
| `POST` | `/leave-requests` | ADMIN, HR, MANAGER, EMPLOYEE |
| `POST` | `/leave-requests/:id/approve` | ADMIN, HR, MANAGER, EMPLOYEE¹ |
| `POST` | `/leave-requests/:id/reject` | ADMIN, HR, MANAGER, EMPLOYEE¹ |
| `DELETE` | `/leave-requests/:id` | ADMIN, HR, MANAGER, EMPLOYEE |

¹ EMPLOYEE is admitted so a SUPERVISOR — who usually holds no elevated role — can
decide the requests they are named on. Eligibility is enforced in the service
against `Employee.supervisorId`, not by the route guard.

Every literal route is declared BEFORE `:id`. `GET /leave-requests/pending` after
`GET /leave-requests/:id` is parsed as a uuid and answers 400 — for the whole
queue, not one row.

### Balances

`GET /leave-balances` · `/leave-types` · `/company-overview` · `/accrual/history`
· `/employee/:id` — `POST /accrual/run` · `/accrual/employee/:id` ·
`/set-default-allocation` · `/employee/:id/init/:year` — `PATCH
/employee/:id/year/:year` · `/employee/:id/year/:year/type/:leaveTypeKey`.

`leave-types` is open to every role: an employee filing leave has to see what
they may pick.

### Attachments

`GET` / `POST /leave-requests/:leaveRequestId/attachments`, `DELETE
/leave-requests/:leaveRequestId/attachments/:id`.

`LeaveAttachmentsModule` is registered **before** `LeaveRequestsModule` in
`app.module.ts` so the nested path is matched before `/leave-requests/:id` can
claim the prefix.

### Overtime

`POST /overtime` · `/overtime/employee/:id` — `GET /overtime` · `/pending` ·
`/stats` · `/my-requests` · `/report/:year/:month` ·
`/employee/:id/hours/:year/:month` · `/employee/:id` · `/:id` — `POST
/:id/approve` · `/:id/edit-preview` · `/:id/reject` — `DELETE /:id`.

Payroll is admitted to the overtime list and refused the leave list: overtime
hours ARE a payroll fact, and a sick note is not.

### Policies

`GET /overtime-policies` · `/resolve/:employeeId` · `/:id` — `POST
/overtime-policies` — `PATCH /assign` · `/:id` · `/:id/default` · `/:id/active` —
`DELETE /:id`. Writes are ADMIN; reads are ADMIN + HR.

### Library

`GET /library-items` (any authenticated caller) · `/:id` — `POST /library-items`
· `/seed` — `PATCH /:id` — `DELETE /:id` (deactivates).

---

## 7. Tests

| Layer | Files |
| --- | --- |
| Backend unit (jest) | `overtime/overtime-calc.util.spec.ts` (ported unchanged), `overtime/overtime.service.spec.ts`, `overtime/overtime-approver-edit.spec.ts`, `overtime/overtime-detail-preview.spec.ts`, `overtime-policy/overtime-policy.types.spec.ts`, `overtime-policy/overtime-policy.service.spec.ts`, `leave-requests/leave-requests.service.spec.ts`, `leave-requests/leave-hub.service.spec.ts`, `leave-requests/working-days.service.spec.ts`, `leave-balances/leave-balances.service.spec.ts` |
| Frontend unit (node) | `utils/overtimeCalc.test.ts` |
| Component (jsdom) | `app/dashboard/leaves/new/page.test.tsx`, `app/dashboard/overtime/new/page.test.tsx`, `app/dashboard/overtime/[id]/page.test.tsx`, `components/leave/LeaveRequestTable.test.tsx` |
| Playwright | `e2e/specs/leave-hub.hr-admin.spec.ts`, `leave-requests.hr-admin.spec.ts`, `leave-approval.hr-admin.spec.ts`, `leave-balances.hr-admin.spec.ts`, `leave.employee.spec.ts`, `overtime.hr-admin.spec.ts`, `overtime-request.employee.spec.ts`, `overtime-policies.hr-admin.spec.ts` |

`overtime-calc.util.spec.ts` is the one file ported **byte for byte** from HRM,
including its regression block for the production incident that produced the noon
rule. It is the first thing to run green: nothing downstream is trustworthy while
the split is wrong.

> ⚠️ **No `manager` Playwright project.** The role projects are
> `admin | hr | payroll | employee` and there is no manager seed account, so the
> manager-scoped paths — `team-balances`, department narrowing in `findAll`,
> supervisor approval — have **no browser coverage**. They are covered in the
> backend specs (`leave-requests.service.spec.ts`, `overtime.service.spec.ts`)
> instead. Adding a manager account to the seed and a fifth project to
> `playwright.config.ts` would close the gap; both are outside this module.

---

## 8. What changed from HRM

Every deviation, with the reason.

### Schema

| HRM | Here | Why |
| --- | --- | --- |
| `status String @db.VarChar(50)` | `status RequestStatus` | The target already has the enum, and a VarChar status is one typo away from a row nothing matches. |
| `dayType`/`otType` as VarChar | `OvertimeDayType` / `OvertimeType` enums | Same reason. |
| `Decimal(10,2)` / `Decimal(12,2)` money | `Decimal(18, 3)` | House rule: OMR/KWD/BHD are thousandths. |
| Thirteen `LibraryType` values | Two | The other eleven belong to modules that do not exist here; a value nothing reads is a trap. |
| `LibraryItem.payBasis`, `perDiemRate`, `loanDeductionPolicy` | dropped | Payroll, travel and loans are not in this repository. |
| `LeaveApproval` (multi-tier trail) | dropped | Single approver — see below. |
| No `@@unique` on `OvertimeRequest` | `@@unique([employeeId, date])` | The service already refused a second request per date; the constraint makes it true under concurrency and makes the seed idempotent. |
| `Employee.fullName`, `email`, `baseSalary`, `salaryType` | `firstName`/`lastName`, `workEmail`, no salary on the employee | The target's shape. The approver's hourly-rate preview is dropped with `baseSalary` — see §9. |

### Removed dependencies

| HRM used | Here | Why |
| --- | --- | --- |
| `ApprovalEngineService` (multi-tier chains) | `@Roles` + `assertMayDecide` | No approvals module in this repository. The single-approver model is `Employee.supervisorId`, which is already documented as "who signs their leave". |
| `NotificationsService`, `MailService`, WhatsApp | nothing | No notification or mail module. The seam is documented in the interconnection doc. |
| `AuditService` | nothing | No audit module wired for writes; `AuditLog` exists but nothing populates it. |
| `StorageService` (MinIO) | caller-supplied `fileUrl` | No storage module; `multer` is an unused dependency. See §9. |
| `assertInBranch` / branch middleware | nothing | The target has no branch-scoping middleware. `Principal.branchId` exists but no other module narrows by it, and inventing a rule here would make this module behave unlike every other one. |
| `managerDeptScope(user)` from `user.managedDepartmentIds` | `managerDepartmentIds(prisma, user)` | The target's `Principal` carries no managed-department list, so the scope is resolved from `Department.managerId`. That is also the stricter reading: sharing a `departmentId` with a department head does not make you one. |
| `TimezoneService` + `CompanyCronGate` | `Company.timezone` + luxon, in-service | No timezone module. The gate is four lines and lives in the accrual. |
| `HolidaysService.getWorkDaysBetween` | `WorkingDaysService` (ours) | `holidays/` belongs to another developer and this branch does not edit it. Recorded for hand-over in the interconnection doc. |

### Behavioural adaptations

| HRM | Here | Why |
| --- | --- | --- |
| Attendance `status: 'LEAVE'`, `source: 'LEAVE'` | `AttendanceStatus.ON_LEAVE`, `AttendanceSource.SYSTEM` | The target's enums. There is no `LEAVE` source; `SYSTEM` is the honest one — nobody typed these times, the approval produced them. `MANUAL` is reserved for a human decision an import must not overwrite, and blurring the two would make the correction flow lie. |
| `weeklyOffDays` as a CSV string, 0 = Sunday | `Int[]`, **ISO 1 = Monday** | The target's column. The whole helper is 1-indexed as a result; a `0` in the global CSV is now refused rather than read as Monday. |
| `office_start_time`, `calendar_weekly_holidays` | `attendance_office_start`, `attendance_weekly_off_days` | The target's setting keys. |
| `attendance_day_end_time` for the OT clamp | **new** `overtime_day_end_boundary` | The target's `attendance_day_end` means "until this passes, an absence count is a prediction" and defaults to 20:00. Reusing it would silently stop paying overtime at eight in the evening. |
| `getOvertimeConfig()` on `SystemSettingsService` | `loadOvertimeConfig()` in `overtime-policy/overtime-config.ts` | `system-settings/` is shared infrastructure this branch does not own. Everything goes through its public `get(key)` door, so nothing about that module changes. |
| An unknown leave type was stored as typed | refused | `LeaveRequest.leaveType` and `LeaveTypeBalance.leaveTypeKey` have to be the same string or the balance is never found; inventing one silently creates leave nobody has an entitlement for. |
| A range of only non-working days was accepted | refused | It would deduct nothing and write no attendance: a request that means nothing, filed in good faith. |
| `getMonthlyReport` reduced page 1 of a list | aggregated in the database | Any month with more than twenty requests reported the wrong money on the one screen whose job is to say what overtime cost. |
| `remove()` on a library item was a hard delete | deactivation | A hard delete leaves a year of history naming a type the list no longer offers. |
| Anyone could approve their own request if their role allowed it | refused | An approval is a second pair of eyes or it is nothing. |

### One defect found and fixed during the port

`canAccessRequestOf` originally fell through to the "no narrowing" branch for any
role that is not a MANAGER — which includes EMPLOYEE. An unrelated colleague
could therefore read anybody's leave reason and overtime pay by walking request
ids. The explicit EMPLOYEE refusal and its regression test
(`overtime-detail-preview.spec.ts`, *"refuses a colleague with no relationship to
it"*) were added in response.

---

## 9. What is not built

Everything here is deliberate. Nothing was dropped silently.

| Left out | Why | Where the contract is |
| --- | --- | --- |
| **Binary attachment upload** | The platform has no storage module and `multer` is an unused dependency. The model, the list, the metadata create and the soft delete all ship; `fileUrl` is caller-supplied, and the DTO already enforces the size and MIME rules an upload endpoint would. | `interconnections-leave-overtime.md` §Storage |
| **Leave encashment** (HRM: 1,247 lines) | Needs `PayrollItem`, per-employee `SalaryComponent` and `PayrollFeaturesService`, none of which exist. | `interconnections-leave-encashment.md` |
| **Year-end carry-forward** | Same dependency. The four `LeaveTypeBalance` columns it needs ship now so it never has to migrate this table. | `interconnections-leave-encashment.md` |
| **Payroll monetisation of the four buckets** | No payroll module. `GET /overtime/employee/:id/hours/:year/:month` is the seam and returns all four buckets plus both allowances. | `interconnections-leave-overtime.md` §Payroll |
| **Multi-tier approval chains** | No approvals module. The single-approver model is complete and working. | `interconnections-leave-overtime.md` §Approvals |
| **Notifications and mail** | No notification or mail module. Every place HRM fired one is a place this module returns and stops. | `interconnections-leave-overtime.md` §Notifications |
| **Audit trail on decisions** | `AuditLog` exists but no module writes to it. HRM's `OVERTIME_APPROVER_EDIT` entry has no counterpart. | `interconnections-leave-overtime.md` §Audit |
| **The approver's hourly-rate preview** | HRM read `Employee.baseSalary` and `salaryType`; neither exists here, and salary lives on `SalaryStructure`. The preview shows hours and MULTIPLIERS, which is everything the decision needs and nothing it does not. | — |
| **`demo-overtime` as a runtime module** | Folded into `prisma/seed.ts` as idempotent upserts, which is how this repository seeds. | — |
| **Two HRM specs** (`payroll-edge-leave`, `payroll-edge-overtime`) | They assert on payslip lines. Deferred with payroll. | — |
| **Manager Playwright coverage** | No `manager` project or seed account — see §7. | — |

---

## 10. Shared files touched

The complete list. Nothing else outside the new module folders was edited.

1. `apps/backend/prisma/schema.prisma` — three enums, eight models, two
   `Employee` columns plus relations, four `User` back-relations.
2. `apps/backend/prisma/seed.ts` — the `overtime_*` settings, the library
   defaults, two policies, three employment-type assignments, a year of
   balances, seven leave requests and six overtime requests. All idempotent.
3. `apps/backend/src/app.module.ts` — six modules registered explicitly.
4. `apps/frontend/components/layout/navConfig.ts` — one group in the admin tree,
   one in the manager tree, two flat entries in the employee tree.
5. `apps/frontend/utils/permissions.ts` — nine permission strings across the
   five roles.
6. `apps/frontend/messages/{en,ar}/sidebar.json` and `moduleLanding.json` — the
   labels and tile descriptions for the new routes.
7. `apps/frontend/components/layout/navConfig.test.ts` — the employee-menu
   assertion is exact, so adding two self screens to that tree changed it. A new
   case covers the group's per-role child list at the same time.
8. `docs/README.md` — the index line for each of the three documents below.

New shared files created (not edits to another module's code):

- `apps/backend/src/common/hub/hub-range.util.ts`
- `apps/backend/src/common/utils/manager-scope.util.ts`
- `apps/backend/src/common/testing/prisma-mock.util.ts`
- `apps/backend/prisma/sql/leave-overtime-indexes.sql`

---

## 11. Verification

```bash
# 1 — schema + client
npm run db:push
cd apps/backend && npx prisma db execute \
  --file prisma/sql/leave-overtime-indexes.sql --schema prisma/schema.prisma
npm run db:seed

# 2 — static
npm run typecheck
npm run lint

# 3 — unit / component
npm test
# the calc engine has to be green before anything else is trusted:
npm test --prefix apps/backend -- overtime-calc

# 4 — browser
npm run e2e:up
npm run test:e2e
npm run e2e:down
```

### Manual end-to-end (`npm run dev`, portal 3010 / API 3011)

1. As `employee@peoplepay360.com`, file annual leave spanning a Friday —
   `totalDays` must exclude it **and** any seeded holiday in the range.
2. As `hr@peoplepay360.com`, approve it: the balance drops, an `ON_LEAVE`
   attendance row appears for every working date, and the response reports any
   day that already had attendance.
3. Approve a second request that overdraws the balance — it must fail with the
   request still `PENDING`, nothing deducted and no attendance written.
4. Log overtime 17:00–23:00 against a 22:00 late threshold — the split is 5h
   regular + 1h late, not 6h at one rate.
5. Log overtime on a seeded holiday — `dayType: HOLIDAY` and the double tier,
   not weekday.
6. Approve with a food-allowance override of `0` — it must survive the finalize
   recompute and not be replaced by the policy figure.
7. Switch the portal to `dir="rtl"` — the leave and overtime screens mirror
   without a second stylesheet (every spacing utility on them is logical:
   `ps-*`, `me-*`, `start-*`).
