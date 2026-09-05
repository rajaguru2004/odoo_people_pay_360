# Schedules — interconnections

Which modules the Schedules module touches, in which direction, what the
contract between them is, and what breaks if one side moves.

Companion to [schedules-walkthrough.md](schedules-walkthrough.md).

---

## Map

```
                        ┌─────────────────────┐
      reads the roster  │   Time & Attendance │  owns the branch calendar
        ◄───────────────┤   (attendances/)    ├────────────────►
                        └──────────┬──────────┘
                                   │ AttendanceCalendarService
                                   │ Attendance rows (ON_LEAVE)
                                   ▼
   ┌──────────────┐        ┌───────────────┐        ┌──────────────────┐
   │  Employees   │◄───────┤   SCHEDULES   ├───────►│  Work Schedules  │
   │  Departments │ scope  │  (reads only) │ writes │  (owns the rows) │
   │  Branches    │        └───────┬───────┘        └──────────────────┘
   └──────────────┘                │                          │
                                   │ Contract window          │
                                   ▼                          ▼
                            ┌──────────────┐          ┌──────────────┐
                            │  Contracts   │          │   Holidays   │
                            └──────────────┘          └──────────────┘
```

Everything above already exists in this repository. **Nothing in this module is
waiting on a counterpart that has not been built** — the pending items in §7 are
capabilities the *platform* does not have, not modules this one is blocked on.

---

## 1. Work Schedules — the write path

**Direction:** Schedules (read) and Work Schedules (write) share one table.
**Status:** implemented, both sides.

| | |
| --- | --- |
| Table | `work_schedules`, unique on `(employee_id, date)` |
| Schedules reads | `GET /schedules/*` — never writes |
| Work Schedules writes | `POST` / `PATCH` / `DELETE /work-schedules`, `POST /work-schedules/bulk` — ADMIN + HR |
| Shared rule | `windowsConflict`, `resolveWindow` and `shiftHours` in `schedules/shift-window.util.ts` |

`work-schedules.service.ts` imports `resolveWindow` from the Schedules module so
that "is this a valid shift window" has **one** definition. The write path
enforces it; the read path measures with it; the dashboard sweeps with it.

**If the write path changes:** any new field on `WorkSchedule` has to be added
to `SCHEDULE_INCLUDE`, to `ScheduleEvent`, and to the grid's cell renderer, or
it exists in the database and on no screen.

**If `shift-window.util.ts` changes:** both sides move together — which is the
point. Splitting the overlap rule into two copies is how one screen refuses a
shift the other reports as fine.

**Why they are not one module:** `WorkSchedulesService` owns *rows* — find one,
roster one, edit one. `SchedulesService` answers questions about the roster as a
whole. Merging them puts a month-wide calendar query inside the write path's
transaction.

---

## 2. Time & Attendance — the branch calendar

**Direction:** Schedules → Attendance (consumer).
**Status:** implemented.

`SchedulesModule` imports `AttendancesModule` for `AttendanceCalendarService`,
which already resolves:

| Method | Used for |
| --- | --- |
| `branchConfigs()` | Each branch's zone, office hours, grace and `weeklyOffDays`. |
| `configFor(configs, branchId)` | One branch's calendar, falling back to the company. |
| `holidayIndex(from, to)` | Holidays by day key. |
| `holidayOn(index, day, branchId)` | The holiday in force at a branch — branch row beats company-wide. |
| `isBranchWorkingDay(config, day, index)` | Was that branch open at all. |

**Why not re-derive it:** the two hubs would give different answers to "was the
office open on Friday". The Schedules dashboard would then report a coverage
hole on a day the Attendance hub expected nobody, and both numbers would be
defensible and one would be wrong.

**If `AttendanceCalendarService` changes:** a change to `ResolvedBranchConfig`
or `ResolvedHoliday` reaches `SchedulesService.sweep()` and
`branchCalendar()` directly. Removing `isBranchWorkingDay` or changing the
branch-beats-company precedence in `holidayOn` silently re-shades the whole
working-schedule grid.

### The other direction

`attendance-hub.service.ts` and `attendance-calendar.service.ts` already read
`WorkSchedule` — `calendarExpectation()` treats a row as an override on one
person's day, and `resolveDay()` lets a roster row beat the branch calendar
outright. **This module changed no column on that table**, so that reading is
unaffected. Anyone adding a column must check `attendance-calendar.service.ts`
before assuming otherwise.

---

## 3. Employees, Departments, Branches — scope

**Direction:** Schedules → each (consumer).
**Status:** implemented.

| Read | For |
| --- | --- |
| `Employee.status` | ACTIVE and ON_LEAVE only, never TERMINATED. |
| `Employee.branchId` | Which branch calendar applies to that person. |
| `Employee.departmentId` | The ranking panel and manager scope. |
| `Department.managerId` | What a MANAGER may see — read per request, not from the token. |
| `Branch.weeklyOffDays`, `officeStartTime`, `officeEndTime`, `timezone` | The working week, per branch. |

**If `Branch.weeklyOffDays` semantics change** — from ISO weekdays (1 = Monday)
to anything else — the grid shades the wrong columns and the conflict sweep
reports rest days that are not rest days. `isWeeklyOff` in
`attendances/attendance-calendar.util.ts` is the one place that reads it.

**An empty `weeklyOffDays` means "not configured", not "every day is a rest
day".** Read the other way round it closes every branch that has not filled the
field in.

**If an employee is terminated:** they leave `employeeScope` immediately, so
they stop counting against coverage. Their existing roster rows stay — soft
delete, and audit and payroll must keep resolving — but they no longer appear on
the grid.

---

## 4. Contracts — the schedulable window

**Direction:** Work Schedules → Contracts (consumer).
**Status:** implemented.

`assertSchedulable` reads the most recent **ACTIVE** contract and refuses a date
outside `startDate`…`endDate`.

The contract is **optional**. Plenty of employee records predate one, and
refusing to roster them would make the screen unusable on exactly the data most
likely to need a shift. Only an existing contract's boundaries are tested.

**If contract statuses change:** the filter is `status: 'ACTIVE'`. A new status
that also means "in force" — say `RENEWED` becoming current rather than
historical — must be added here, or renewals become unschedulable.

---

## 5. Holidays

**Direction:** Schedules → Holidays (consumer, through `AttendanceCalendarService`).
**Status:** implemented.

A branch-specific row and a company-wide one can both land on a date; the
**branch row wins**. That is how a national holiday observed in one country and
not another is expressed without maintaining a second calendar per branch.

Rostering somebody on a holiday is **allowed** and reported as a conflict —
skeleton cover on a public holiday is a real thing a plant does. The module's
job is to make it visible, not to refuse it.

**If the override precedence flips**, the plant's shutdown day stops shading and
the conflict count drops silently.

---

## 6. Frontend contracts

### Query keys

Every read is under `scheduleKeys.all = ['schedules']`, so one invalidation
reaches the grid, the calendar, the coverage sweep and all six dashboard panels.

Every write in `hooks/useSchedules.ts` invalidates the whole subtree. Deliberate
rather than lazy: one new shift changes all of them, and a screen still showing
yesterday's coverage after somebody rostered a night shift is worse than a
refetch nobody notices.

### Navigation

`navConfig.ts` gates the module for ADMIN, HR_MANAGER and MANAGER. The manager
tree omits **Shift management**, because every `/work-schedules` route is
ADMIN + HR server-side and a rail entry that leads to a page of 403 buttons is a
lie the user finds before we do.

`utils/permissions.ts` mirrors that with `VIEW_SCHEDULES` and
`MANAGE_SCHEDULES`. Both are **UI affordances**, not a boundary: every one has a
`RolesGuard` counterpart, and `schedules.payroll-employee.spec.ts` asserts the
denial rather than only the absence.

### The error envelope

The axios interceptor rejects with a **flat** object. Every catch in this module
goes through `apiErrorMessage(err, fallback)` — reaching for
`err.response.data.message` silently falls through to the generic fallback and
the user is told nothing.

---

## 7. Pending — platform capabilities this module cannot use yet

None of these block the module. Each is a lane that will light up when the
counterpart exists.

### 7.1 Shift reminders (email / in-app)

HRM's `ShiftNotificationScheduler` sends a reminder before a shift starts and an
alert after it has. It needs, none of which this repo has:

- `MailModule` with `shift-prior-reminder` / `shift-post-reminder` templates;
- `NotificationsModule` with `notifyUser(...)`;
- `SystemSettingsService.getSetting` for `shift_reminder_prior_mins` /
  `shift_reminder_post_mins`;
- a timezone resolver for the employee's effective zone;
- **two new columns on `WorkSchedule`**: `prior_email_sent`, `post_email_sent`,
  which are what make a replayed cron tick idempotent.

**When those land:** add `ShiftNotificationScheduler` to `SchedulesModule` and
the two boolean columns to the schema. The dedupe key must stay per schedule row
(`shift_reminder:prior:<id>`), or one replayed tick messages the same person
twice about one shift. The scheduler must read wall-clock `startTime` in the
employee's **branch** zone — HRM compared `DateTime` instants directly, which
this schema cannot do.

### 7.2 Leave requests

There is no `LeaveRequest` model. The leave lane on the calendar and the grid
reads `Attendance.status = ON_LEAVE`, which is a day already **recorded**. A
leave that has been approved but never posted to a day does not appear, and
`assertSchedulable` cannot refuse a date on the strength of an approval alone.

**When a leave module lands:** add the approved-leave check to
`assertSchedulable`, and add an `approved-leave` lane to `ScheduleEvent['type']`
alongside the recorded one. Both are wanted — an approved future leave and a
recorded past one are different facts.

### 7.3 Overtime

No `OvertimeRequest` model, so HRM's overtime lane is dropped. When one exists,
it is a fourth lane on `ScheduleEvent` and a fifth tile on the grid. The
Schedules module should still not *compute* overtime — that is a payroll rule,
and the hours here are a plan.

### 7.4 Lunch-break deduction

HRM subtracted a configured lunch break from scheduled hours, reading
`lunch_break_start` and `lunch_break_duration_minutes` from system settings.
Neither key exists here. `shiftHours` therefore measures the **whole window**.

Inventing a default would silently reduce every hours figure on the page by an
hour, and nobody would know which of the two rules the number came from. When
the settings exist, the deduction belongs in `shift-window.util.ts` so the
server, the grid and the modal all move together.

### 7.5 Audit logging

The repo has an `AuditLog` model, but no `@AuditResource` decorator or audit
interceptor. HRM audited every roster write (`auditResourceType: 'WorkSchedule'`)
because each one changes when somebody is expected at work.

**When an audit interceptor lands:** it belongs on `WorkSchedulesController`,
which is where the writes are — not on `SchedulesController`, which is read-only.

### 7.6 Payroll

Not connected, and correctly so. Scheduled hours are a **plan**; payroll pays
for what attendance **recorded**. If a payroll run ever needs a planned figure —
a shift allowance, a night-differential — it should read `shiftHours` from
`shift-window.util.ts` rather than recompute the window, and it must handle the
midnight crossing that a naive subtraction gets wrong by sixteen hours.
