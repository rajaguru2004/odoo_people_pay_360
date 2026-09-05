# Leave & Overtime — interconnections

Which modules this one touches, in which direction, what the contract between
them is, and what breaks if one side moves.

Companion to [leave-overtime-walkthrough.md](leave-overtime-walkthrough.md).
The deferred encashment half has its own document:
[interconnections-leave-encashment.md](interconnections-leave-encashment.md).

---

## Map

```
        ┌────────────────┐   Holiday rows,  ┌─────────────────────┐
        │   Holidays     │   Branch cal.    │  Time & Attendance  │
        │  (holidays/)   ├─────────────────►│   (attendances/)    │
        └───────┬────────┘                  └──────────▲──────────┘
                │ read only                            │ writes ON_LEAVE rows
                │                                      │ (one per working day)
                ▼                                      │
   ┌───────────────────────────────────────────────────┴──────────┐
   │                    LEAVE  &  OVERTIME                        │
   │  leave-requests · leave-balances · leave-attachments         │
   │  overtime · overtime-policy · library-items                  │
   └───┬──────────────┬───────────────┬──────────────┬────────────┘
       │              │               │              │
       │ reads        │ reads         │ reads        │ EXPOSES
       ▼              ▼               ▼              ▼
 ┌───────────┐  ┌────────────┐  ┌──────────────┐  ┌────────────────────────┐
 │ Employees │  │ Departments│  │   System     │  │  GET /overtime/employee│
 │ Branches  │  │            │  │   settings   │  │  /:id/hours/:year/:mon │
 └───────────┘  └────────────┘  └──────────────┘  └──────────┬─────────────┘
                                                             │ waiting on
                                                             ▼
                                                       ┌───────────┐
                                                       │  Payroll  │  ✗ not built
                                                       └───────────┘

  ✗ not built anywhere in this repository:
    approvals engine · notifications · mail · object storage · payroll · audit writes
```

**Implemented, both sides:** Employees, Branches, Departments, Holidays,
Attendances, System settings.
**Documented and waiting on a counterpart:** Payroll, Approvals, Notifications,
Storage, Audit.

---

## 1. Holidays — the branch calendar

**Direction:** Leave & Overtime **reads**. It never writes a holiday.
**Status:** implemented. One hand-over is owed — see below.

| | |
| --- | --- |
| Table | `holidays`, with a nullable `branch_id` |
| Read by | `WorkingDaysService.isHoliday`, `.getWorkingDatesBetween` (`leave-requests/working-days.service.ts`) |
| Also reads | `Branch.weeklyOffDays`, and the `attendance_weekly_off_days` setting |

### The contract

```ts
// A branch observes its own holidays AND the company-wide ones.
where: { date, OR: [{ branchId: null }, { branchId }] }
```

`branchId = x` never matches the NULL row in SQL. A plain equality silently drops
every national holiday, and a leave request over New Year is then priced as four
working days instead of two.

`Branch.weeklyOffDays` is `Int[]` in **ISO weekdays, 1 = Monday**. An EMPTY array
means *inherit the company calendar*, not *this branch works seven days* — the
column's own default documents that, and reading it the other way round makes
every day of a leave request billable at a branch nobody has configured yet.

### What breaks if the other side moves

| Change on the Holidays / Branches side | What breaks here |
| --- | --- |
| `Holiday.branchId` stops being nullable, or company-wide rows move to a per-branch fan-out | The `OR` fragment silently matches nothing; every leave request is priced too high and every holiday overtime shift is classified WEEKDAY. |
| `Branch.weeklyOffDays` changes to 0-indexed, or back to a CSV | `WorkingDaysService.isoWeekdayOf` is 1-indexed throughout. A `0` is currently **refused** rather than read as Monday, so the failure would be a branch with no rest days rather than the wrong ones — visible, but wrong. |
| `attendance_weekly_off_days` changes format | `WorkingDaysService.parseWeeklyOffCsv` is the only parser left; it drops anything outside 1–7. |
| A branch's calendar is edited | Requests already filed keep the `totalDays` they were priced with, by design. Only new requests move. |

### ⚠️ Hand-over owed to `holidays/`

`WorkingDaysService` answers branch-calendar questions and by rights belongs
beside the `Holiday` model. It lives in `leave-requests/` **only because
`holidays/` is another developer's module and this branch does not edit another
module's code** (rule 3 of `AGENT_INSTRUCTIONS.md`).

Two methods `holidays/` does not currently have and should adopt:

| Method | What it answers |
| --- | --- |
| `getWorkingDatesBetween(start, end, branchId)` | The working DATES in a range — not just the count, because leave approval needs both and deriving one from the other twice is how the two disagree. |
| `isWeeklyOff(date, branchId)` | Whether a date is a branch rest day, read at **UTC noon** so a `@db.Date` returned as local midnight still resolves to the day it means. |

If the owner of `holidays/` accepts them, this module should import from there
and delete `working-days.service.ts`, keeping its spec. Until then the two must
not drift: a second implementation of the noon rule is a second answer.

---

## 2. Time & Attendance — the write path

**Direction:** Leave & Overtime **writes** `Attendance` rows. Nothing reads back.
**Status:** implemented, both sides.

| | |
| --- | --- |
| Written by | `LeaveRequestsService.approve`, inside the approval transaction |
| Rows | one per **working** date in the range |
| Shape | `status: ON_LEAVE`, `source: SYSTEM`, `workHours: 0`, `branchId` stamped, `notes: "Approved <type>"` |
| Collision rule | `createMany({ skipDuplicates: true })` on `@@unique([employeeId, date])` |

### Three details that are load-bearing

1. **`source: SYSTEM`, not `MANUAL`.** `MANUAL` means a human entered the times
   and a later import must not overwrite them — that is the contract
   `attendance-corrections` relies on. Nobody typed these; the approval produced
   them. Blurring the two would make the correction flow lie about what a human
   decided.
2. **`branchId` is stamped.** Without it these rows carry a null branch and every
   branch-filtered view — the attendance list, the reports, the logs — loses
   them, while payroll still counts them.
3. **The skip count is returned, not swallowed.** A day the employee actually
   clocked keeps its own record, and the approver is told in the response
   `message` and `meta.attendanceSkipped`. Silently skipping meant a day of
   approved leave had no `ON_LEAVE` row behind it and nobody knew.

### What breaks if the other side moves

| Change on the Attendance side | What breaks here |
| --- | --- |
| `AttendanceStatus.ON_LEAVE` renamed or removed | Approval fails at the write. The attendance hub's `onLeave` figure and the schedules module's leave lane both read the same enum. |
| `@@unique([employeeId, date])` dropped | `skipDuplicates` stops protecting anything; an approval overwrites a real clocked day. |
| A new required column on `Attendance` | The `createMany` payload has to grow with it. |
| The attendance hub starts counting `SYSTEM` rows as worked | Approved leave would appear as attendance. It currently keys on `status`, not `source`, which is why it does not. |

**Not read back:** this module never asks the attendance module anything. An
employee who was on approved leave and also clocked in is a contradiction the
attendance module surfaces, not one this module resolves.

---

## 3. Employees, Departments, Branches

**Direction:** read only.
**Status:** implemented.

| Field | Read by | Why |
| --- | --- | --- |
| `Employee.supervisorId` | `assertMayDecide` (both services) | **The single-approver model.** Documented on the column as "who signs their leave and their timesheet". A supervisor typically holds no elevated role, so without this the person the system asks to decide cannot open the thing they are deciding. |
| `Employee.departmentId` | `scopeToCaller`, `canAccessRequestOf` | Manager narrowing. |
| `Employee.branchId` | `WorkingDaysService`, the attendance stamp | Which calendar prices the request. |
| `Employee.gender` | leave type restriction, `initBalance` | Maternity and paternity. A restricted type is not ALLOCATED to somebody who can never take it — 98 days of maternity on a male employee inflates every company total with leave nobody can use. |
| `Employee.status` | filing guard, accrual, balances grid | A terminated employee cannot file; only ACTIVE employees accrue. |
| `Department.managerId` | `managerDepartmentIds` | A manager's scope is the departments they **manage**, not the one they sit in — sharing a `departmentId` with a department head does not make you one. |

### Two columns this module ADDS to `Employee`

| Column | Meaning |
| --- | --- |
| `employmentType String?` | An `EMPLOYMENT_TYPE` library **label**, the middle tier of the overtime-policy chain. A label rather than an enum so HR can add a category without a deploy. |
| `overtimePolicyId String?` | A direct policy override, the top tier. `ON DELETE SET NULL`, so deleting a policy drops the employee back through the chain rather than orphaning them. |

### What breaks if the other side moves

| Change | What breaks here |
| --- | --- |
| `supervisorId` removed, or repurposed as the org line | Every supervisor loses the ability to decide, and the queue empties only through HR. `managerId` is **not** a substitute — the schema is explicit that they are different graphs. |
| A department's manager changes | The new manager's scope moves immediately; requests already decided keep their `approverId`. |
| An employee is terminated | They cannot file. Their existing requests and balances survive — `onDelete: Cascade` only fires on a real delete, which the platform does not do. |

---

## 4. System settings

**Direction:** read only, through the public `get(key)` door.
**Status:** implemented.

`SystemSettingsService` is shared infrastructure this branch does not own, so no
typed getter was added to it. `overtime-policy/overtime-config.ts` assembles the
whole configuration from `get(key)` calls and owns its own defaults.

| Key | Read for | Default |
| --- | --- | --- |
| `attendance_office_start` | The start of the working day — overtime may not begin inside it. | `08:00` |
| `attendance_office_end` | The end of it, and the default `shiftEndTime`. | `17:00` |
| `attendance_weekly_off_days` | The company rest days, when a branch sets none. | `5,6` |
| `default_timezone` | The company clock, when `Company.timezone` is unset. | `Asia/Muscat` |
| `overtime_*` (26 keys) | Rates, thresholds, allowances, caps, flags. | see `OVERTIME_SETTING_DEFAULTS` |

### One key this module ADDS

`overtime_day_end_boundary`, default `23:59`.

The attendance module's `attendance_day_end` means *"until this passes, an
absence count is a prediction"* and defaults to `20:00`. Reusing it for the
overtime clamp would silently stop paying overtime at eight in the evening. They
are different questions that happen to be times.

### What breaks if the other side moves

| Change | What breaks here |
| --- | --- |
| `attendance_office_start` / `_end` change | The outside-work-hours guard and the default shift end move with them, which is correct — but a company that shortens its day retroactively makes previously-legal overtime windows illegal for NEW requests only. |
| A key becomes a secret (`isSecret`) | `get()` still returns the plaintext; `getAll()` would mask it. Nothing here uses `getAll()`. |
| `attendance_weekly_off_days` is deleted | Falls back to `[5, 6]`, not to "no rest days". |

---

## 5. Payroll — **pending**

**Direction:** payroll would READ from here. Nothing is written back.
**Status:** ✗ not built. The seam exists and is stable.

### What this module already exposes

```
GET /overtime/employee/:employeeId/hours/:year/:month     ADMIN · HR · PAYROLL
```

```jsonc
{
  "employeeId": "…", "year": 2026, "month": 8,
  "hours": 42.5,             // the payable total, after the day-boundary clamp
  "regularHours": 30,        // ×  policy.regularRate
  "lateHours": 6.5,          // ×  policy.lateRate
  "doubleHours": 4,          // ×  policy.sunday.regularRate | holiday.regularRate
  "doubleLateHours": 2,      // ×  policy.sunday.lateRate    | holiday.lateRate
  "foodAllowance": 12,       // a flat amount, already decided
  "siteAllowance": 25        // approver-granted, never recomputed
}
```

APPROVED requests only. Four buckets rather than one total precisely so payroll
does not have to guess a rate.

### What payroll must do, and must not

| Must | Why |
| --- | --- |
| Read the rates from `OvertimeRequest.overtimePolicyId` via `OvertimePolicyService.configForPolicyId(id)` | The request stores the policy that CLASSIFIED its hours. Reading today's policy would re-rate a request approved months ago. |
| Choose the multiplier per bucket the way the detail page does — the Sunday/Holiday tier on a double day, the flat `doubleRate` otherwise | Or the payslip and the screen the approver agreed to disagree. |
| Treat `foodAllowance` and `siteAllowance` as **amounts**, not rates | They are money already. |
| Must NOT recompute the hour split | The split is frozen at approval, under the rules in force then. |

### What leave owes payroll

| Fact | Where |
| --- | --- |
| Which days were unpaid | `LibraryItem.isPaid === false` on the request's `leaveType` |
| Which days were absence at all | `Attendance` rows with `status: ON_LEAVE` |
| How many days of each type were taken in a year | `LeaveTypeBalance.used` |

**Not exposed yet:** a per-cycle "unpaid leave days in this payroll period"
endpoint. It is a `leaveRequest` + `LibraryItem` join over the cycle window;
whoever builds payroll should add it here rather than joining across modules.

### What breaks when payroll lands

Nothing in this module changes. If payroll needs an `OvertimeRequest` to be
locked once paid, that is a new nullable column (`payrollItemId` or similar) and
a guard in `approve`/`cancel` — both additive.

---

## 6. Approvals — **pending**

**Direction:** an approvals engine would wrap this module's decisions.
**Status:** ✗ not built. The single-approver model here is complete and working.

### What ships

One decision, one approver:

```
ADMIN | HR_MANAGER                      → always
MANAGER, inside Department.managerId    → their own departments
Employee.supervisorId                   → whatever role they hold
the requester themselves                → never
```

`LeaveRequest.approverId` / `OvertimeRequest.approverId` hold the single
decision-maker, and `approvedAt` the moment.

### What a chain engine would need

| Need | Where it goes |
| --- | --- |
| A trail table (HRM had `LeaveApproval` with `tier`) | New model. **Not** shipped here — an unused table with a tier column invites half-implementations. |
| `initiate(type, requestId, employeeId)` after create | One call at the end of `create` in both services. |
| `decide(...)` before the finalize step | `approve()` already isolates its finalize (`finalizeApproval` in overtime; the transaction body in leave), which is the shape a chain needs: an intermediate approver returns with the request still PENDING. |
| An "is this caller a participant" test | `assertMayDecide` is the extension point in both services. |
| `abandon(...)` on cancel | One call in `cancel()`. |

### The one property a chain must preserve

**An approver correction is persisted BEFORE the decision is recorded.** In a
multi-step chain an intermediate approver's `decide()` records their step and
returns with the request still PENDING, never reaching the finalize step — so an
edit deferred to there is silently dropped on every step but the last. The
ordering is already correct here and is covered by
`overtime-approver-edit.spec.ts`.

---

## 7. Notifications and mail — **pending**

**Direction:** this module would fire; nothing reads back.
**Status:** ✗ neither module exists.

Every place HRM sent something, this module returns and stops. The events, with
the data each carries:

| Event | Recipients | Payload available at the call site |
| --- | --- | --- |
| `LEAVE_APPLIED` | the applicant, their supervisor, HR | type, dates, `totalDays`, reason |
| `LEAVE_APPROVED` | the applicant | type, dates, `totalDays`, the approver's note, the attendance skip count |
| `LEAVE_REJECTED` | the applicant | type, dates, the reason |
| `OVERTIME_APPLIED` | the employee, their supervisor | date, window, payable hours, tier |
| `OVERTIME_APPROVED` | the employee | the frozen breakdown, both allowances, whether an approver corrected it |
| `OVERTIME_REJECTED` | the employee | date, hours, the reason |
| `ACCRUAL_RUN` | HR | month, credited, skipped |

Two rules for whoever builds it:

1. **Fire after the transaction commits, never inside it.** A notification sent
   from inside a transaction that then rolls back tells somebody their leave was
   approved when it was not.
2. **Failures must not fail the decision.** HRM used `.catch(() => undefined)`
   on every notification for this reason, and it is the right shape.

---

## 8. Object storage — **pending**

**Direction:** leave attachments would write bytes.
**Status:** ✗ not built. Metadata ships; the upload is deferred.

### What ships

| Route | Behaviour |
| --- | --- |
| `GET /leave-requests/:id/attachments` | Lists non-deleted rows, authorised against the request's OWNER — these are medical certificates. |
| `POST /leave-requests/:id/attachments` | Records `fileName`, `fileUrl`, `fileSize`, `mimeType`. **`fileUrl` is caller-supplied.** |
| `DELETE /…/attachments/:id` | Soft: `deletedAt`. The fact a certificate WAS produced is part of why the leave was approved. |

The DTO already enforces what an upload endpoint would: 10 MB, and
`application/pdf | image/jpeg | image/png`.

### What a storage module has to provide

```ts
uploadFile(buffer: Buffer, name: string, bucket: string): Promise<string /* url */>
deleteFile(url: string): Promise<void>
```

Then, in `leave-attachments/`: add a `FileInterceptor('file')` route that calls
`uploadFile` and hands the resulting URL to the **existing** `create` path, and
call `deleteFile` from `remove`. The validation, the authorisation and the
soft-delete stay exactly as they are — only where the bytes come from changes.

`multer` and `@types/multer` are already dependencies of `apps/backend` and are
currently unused.

---

## 9. Audit — **pending**

**Direction:** this module would write.
**Status:** ✗ `AuditLog` exists; no module populates it.

HRM wrote one entry this module does not: `OVERTIME_APPROVER_EDIT`, carrying the
before and after of the window, the hours, both allowances and the approver's
note. The data is all present in `applyApproverEdit`; only the writer is missing.

When an audit writer lands, the four calls worth adding are:
`LEAVE_APPROVED`, `LEAVE_REJECTED`, `OVERTIME_APPROVER_EDIT` and
`LEAVE_BALANCE_ADJUSTED` — the four places money moves without the employee
doing anything.

---

## 10. Module hubs — a shared utility, not a dependency

`apps/backend/src/common/hub/hub-range.util.ts` is **new** and shared. The
Leave & Overtime hub is its only consumer today; the attendance hub still carries
its own copy of the same arithmetic (`resolveHubRange` in
`attendances/attendance-hub.service.ts`).

That duplication is deliberate for now — `attendances/` is another developer's
module — but it is a place two hubs can start disagreeing about what "the week
before the 1st of March" means. Whoever owns `attendances/` should migrate to the
shared util; the behaviour is identical and the spec coverage is here.

The frontend equivalents (`useLeaveHub` / `useAttendanceHub`) are intentionally
separate hooks over separate payloads: the two hubs answer different questions
and share only their period control.

---

## 11. Frontend query keys — the invalidation contract

Cross-module invalidation, so a screen never shows a figure another screen has
already moved:

| Mutation | Invalidates | Why |
| --- | --- | --- |
| Approve leave | `leaveKeys.all`, `balanceKeys.all`, `attendanceKeys.all` | It moves all three. A page showing yesterday's balance beside today's approval is a disagreement nobody can resolve from the screen. |
| Reject / cancel leave | `leaveKeys.all` | Nothing else moved. |
| Create / approve overtime | `overtimeKeys.all`, `leaveHubKeys.all` | The hub reports approved hours. |
| Any policy write | `policyKeys.all`, `overtimeKeys.all` | A pending request's preview is priced against the live policy, so editing a rate changes what the review screen says the request is worth. |
| Any library write | `libraryKeys.all`, `leaveKeys.types()`, `balanceKeys.all` | Adding a leave type changes what a form may offer and what a balance grid has a column for. |

`attendanceKeys` is imported from `hooks/useAttendance.ts` — the one place this
module's frontend reaches into another module's code, and a read of a constant
rather than of behaviour.

---

## 12. Summary

| Counterpart | Direction | Status |
| --- | --- | --- |
| Holidays / Branches | read | ✔ implemented · hand-over of `WorkingDaysService` owed |
| Time & Attendance | write | ✔ implemented |
| Employees / Departments | read | ✔ implemented · two columns added to `Employee` |
| System settings | read | ✔ implemented · one key added |
| Payroll | would read | ✗ pending — seam exposed and stable |
| Approvals engine | would wrap | ✗ pending — extension points named |
| Notifications / mail | would fire | ✗ pending — events and payloads listed |
| Object storage | would write | ✗ pending — two-method contract listed |
| Audit | would write | ✗ pending — four call sites named |
| Leave encashment | would read + write | ✗ deferred — [own document](interconnections-leave-encashment.md) |
