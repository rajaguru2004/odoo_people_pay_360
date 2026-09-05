# Schedules — walkthrough

Migrated from `human-resource-management`, where the same subsystem lives in
`apps/backend/src/calendar/` and `apps/frontend/app/dashboard/schedules/`.
Adapted to this repository's conventions rather than copied: the data model,
the response envelope, the time representation and the component library all
differ, and the differences are listed under [What changed from HRM](#what-changed-from-hrm).

---

## 1. What the module is

The roster as a **plan**, as opposed to Time & Attendance, which is the
**record** of what happened. The two share the `work_schedules` table and
nothing else.

Four screens:

| Screen | Route | What it answers |
| --- | --- | --- |
| Schedule dashboard | `/dashboard/schedules` | Is the coming week covered, and what contradicts the roster? |
| Working schedule | `/dashboard/schedules/overview` | The whole workforce against a month, one row each. |
| Shift calendar | `/dashboard/schedules/calendar` | One person's shifts, month by month, with the lanes the grid has no room for. |
| Shift management | `/dashboard/schedules/shifts` | The roster as rows: add one, edit one, remove one, lay a pattern over a range. |

### The rule the whole module rests on

A `WorkSchedule` row exists **only** when somebody deviates from their branch
calendar on one day. A row per employee per day would be headcount × 365 rows a
year saying nothing `Branch.officeStartTime`, `Branch.weeklyOffDays` and the
`holidays` table do not already say. Every screen therefore resolves a day in
this order:

1. a rostered **shift** — which wins outright, because deviating is the only
   reason the row was written;
2. **leave** already recorded against the day;
3. the branch's **holiday**, company-wide or its own;
4. the branch's **weekly off**.

Nothing left is a plain working day, and it draws an empty cell.

### Three things this module deliberately does not claim

`WorkSchedule` has a required `employeeId`, no capacity column, no shift
template and no hourly demand anywhere in the schema. So an *open shift* (a
shift with nobody on it), an *over-capacity shift* and a staffing *requirement*
are **not representable**. Every name in the API and on the screens says what it
actually measures:

| What a roster tool usually draws | What ships here, and why |
| --- | --- |
| Open shifts | **Coverage gaps** — working days whose scheduled headcount is below the window's own median. |
| Over capacity | **Conflicts** the roster is happy to contain: rostered on a holiday, on a weekly off, or overlapping. |
| Required vs scheduled | **Staff on shift by hour**, against a flat active-headcount baseline. It says how the day is staffed, not whether that is enough — nothing stores "enough". |

---

## 2. Entry points

### Backend — `apps/backend/src/schedules/`

Reads only. Every write goes through `work-schedules`, which owns the rows.

| File | Role |
| --- | --- |
| `schedules.controller.ts` | Six GET routes under `/schedules`. |
| `schedules.service.ts` | Employee calendar, month stats, the company grid, the coverage sweep, the conflict check, and the authorization behind all of them. |
| `schedules-hub.service.ts` | The dashboard payload: two windows, trend buckets, shift mix, status donut, hourly curve, department ranking, action queue. |
| `shift-window.util.ts` | Pure wall-clock arithmetic: overlap, length, hourly spread, coverage rate. No Prisma, no Nest. |
| `schedule-range.util.ts` | Period → window resolution, bucket keys, labels. |
| `dto/hub-summary.dto.ts`, `dto/schedule-range.dto.ts` | Query validation. |
| `shift-window.util.spec.ts`, `schedules-hub.service.spec.ts` | 55 unit tests. |

Registered explicitly in `app.module.ts` — never through a transitive import.

### Backend — `apps/backend/src/work-schedules/` (extended, not created)

Already existed. Now carries the roster rules; see
[Shared files touched](#shared-files-touched).

### Frontend

| File | Role |
| --- | --- |
| `app/dashboard/schedules/page.tsx` | Dashboard, on `ModuleLandingPage`. |
| `app/dashboard/schedules/overview/page.tsx` | The working-schedule grid. |
| `app/dashboard/schedules/calendar/page.tsx` | One person's month. |
| `app/dashboard/schedules/shifts/page.tsx` | Roster rows and the write path. |
| `components/schedules/ShiftCalendar.tsx` | The month grid — hand-built, see [What changed](#what-changed-from-hrm). |
| `components/schedules/ScheduleModal.tsx` | Roster or edit one shift. |
| `components/schedules/BulkScheduleModal.tsx` | Lay a pattern over a range. |
| `components/schedules/ScheduleLegend.tsx`, `EmployeeChip.tsx`, `shiftStyles.ts` | Shared cell rendering and the one palette all three screens read. |
| `hooks/useSchedules.ts` | Every query and mutation, behind one `scheduleKeys` factory. |
| `services/scheduleService.ts` | Reads. |
| `services/workScheduleService.ts` | Writes (rewritten — see below). |
| `types/schedules.ts` | The full payload contract. |
| `utils/scheduleHours.ts` | Wall-clock and day-key arithmetic, shared by all four screens. |
| `utils/chartAxis.ts` | Axis derivation and CSV export. |

---

## 3. API surface

All responses go through the global envelope: `{ success, data, message?, meta? }`.
Nothing below hand-rolls a different shape.

| Route | Roles | Returns |
| --- | --- | --- |
| `GET /schedules/hub-summary?period&anchor` | ADMIN, HR, MANAGER | The whole dashboard, plus the previous window for every delta. |
| `GET /schedules/overview?startDate&endDate&branchId?&departmentId?` | ADMIN, HR, MANAGER | Employees, shifts, leave days, holidays and each branch's calendar — the whole grid in one request. |
| `GET /schedules/my?startDate&endDate&employeeId?` | all five roles | One employee's events. Defaults to the caller. |
| `GET /schedules/stats?month&year&employeeId?` | all five roles | One month as figures. |
| `GET /schedules/coverage?startDate&endDate` | ADMIN, HR, MANAGER | Coverage, the thinnest day, and every conflict. |
| `GET /schedules/conflicts?employeeId&startDate&endDate` | ADMIN, HR, MANAGER | The colliding rows for one person. |

Writes stay on the existing surface: `GET/POST/PATCH/DELETE /work-schedules`
and `POST /work-schedules/bulk`, all ADMIN + HR.

Guards are on the controller class (`@UseGuards(JwtAuthGuard, RolesGuard)`) with
`@Roles(...)` per route, as `CLAUDE.md` requires.

---

## 4. Logic

### 4.1 Wall-clock arithmetic — `shift-window.util.ts`

`WorkSchedule.startTime` / `endTime` are `VarChar(5)` wall clock — `"22:00"`,
not an instant. Everything is minute arithmetic on a 24-hour dial.

- **An end at or before the start crossed midnight.** A night shift of
  22:00–06:00 is eight hours. The naive subtraction that makes it minus sixteen
  turns every night worker into a payroll anomaly and drops the row out of every
  total it touches.
- **Equal clocks are a zero-length window, not 24 hours.** An unconfigured pair
  is far likelier than a genuine round-the-clock rota, and zero is the answer a
  caller can detect and fall back from.
- **Overlap is half-open.** An end equal to the next start is a split day, not a
  collision. A `FLEXIBLE` shift is date-level exclusive in both directions
  because it has no window for anything to fit around.
- **A midnight-crossing shift is split at midnight for comparison**, not
  extended past 1440. The second half belongs to the *following date*, and rows
  are only ever compared within one date — folding it back is what stops a
  22:00–06:00 rota colliding with its own next occurrence.
- **Partial hours round up** on the hourly curve. A shift ending at 06:30
  occupies the 6 o'clock hour; rounding down reports an empty hour somebody is
  standing in.

`windowsConflict` is the single definition, read by the create path, the bulk
path, the conflicts endpoint and the dashboard's window sweep. Two definitions
of "overlap" is how one screen refuses a shift the other reports as fine.

### 4.2 Coverage — `coverageRate`

The working week is a **branch** property. Head Office rests Friday and
Saturday; the Sohar plant rests Friday only. `expected` for a day therefore
counts only the branches that were open — but the roster is company-wide, and
somebody from a closed branch can legitimately be rostered on that day. Divide
one by the other and a Saturday with three people on it against two expected
reports **150% covered**.

`coverageRate` takes `max(expected, scheduled)` as the denominator. That can
only ever *raise* it, so it never hides an unassigned person; it only stops a
rate claiming more than everybody. The same shape as `reconcileExpected` in
`attendance-hub.service.ts`, which exists for the same reason.

A day the calendar expects **nobody** has no coverage rate at all — `null`, not
0%. 100% would say the day was fully staffed and 0% that it was abandoned, and
neither is a claim about a day the branch was shut.

### 4.3 Coverage gaps — `gapsBelowMedian`

Working days whose headcount is below the window's **own median**. Not an
absolute threshold: a six-person branch and a six-hundred-person one have
different normals, and a fixed number would shout at one and stay silent for the
other. Under three working days there is no meaningful middle, so it reports
nothing rather than noise.

### 4.4 Conflicts — the window sweep

`SchedulesService.sweep()` reads every roster row in a window once and answers
six questions from it. Both `coverageStats` and the dashboard call it, because
two passes over the same table is two chances for them to disagree about the
window — and a KPI that contradicts the endpoint behind the same number is
worse than either being wrong alone.

Three conflict kinds:

- **On a holiday** — the branch's own row wins over the company-wide one on a
  shared date, which is how a national holiday observed in one country and not
  another is expressed.
- **On a weekly off** — `else`, not a second `if`. A holiday that lands on a
  weekly off is *one* conflict; counting it twice inflates every total on the
  page.
- **Overlapping** — swept per employee-**day**, never per employee-window. Two
  shifts on different dates cannot overlap, and comparing them would be O(n²)
  over the month.

> The `@@unique([employeeId, date])` constraint means the API cannot *create* an
> overlap. The sweep is a safety net for rows written another way — a seed, an
> import, direct SQL — and it costs one pass it was already making.

### 4.5 Authorization

Expressed against an actor, not against a role string alone, because two rules
need the caller's identity:

- **`resolveCalendarTarget`** — the override is honoured only for ADMIN, HR,
  PAYROLL and MANAGER, and only then is the object-level check consulted. The
  guard is never applied to the token-derived id: doing so is how "my calendar"
  breaks for every administrator who is not also a member of staff.
- **`assertEmployeeViewable`** — a manager reaching outside their departments
  gets **404, not 403**. A 403 concedes the employee is real, which lets a
  department head enumerate the company by probing ids. An employee reaching for
  somebody else gets 403, because inside their own scope the row's existence is
  not the secret.
- **Manager scope** is read from `Department.managerId` on every request, not
  from a claim on the token: a reorganisation takes effect on the next request
  instead of on the next sign-in, and a token cannot be edited into a wider
  scope than the table grants.
- **`employeeScope`** is ACTIVE and ON_LEAVE, never TERMINATED. A leaver has no
  future roster, and counting them would report a permanent coverage hole nobody
  can close.

### 4.6 Roster rules on the write path

`assertSchedulable` runs before any single-row create:

1. the employee exists and is **ACTIVE** (a leaver has no future roster; a
   suspended employee is not expected in);
2. the date falls inside the **active contract**, if there is one — the contract
   is optional, and refusing to roster the records that predate one would make
   the screen unusable on exactly the data most likely to need a shift;
3. the day is not already a recorded **leave** day.

`assertShiftShape` runs on create, update and bulk:

- `FLEXIBLE` needs `requiredHours` and nothing else;
- every other type needs both clocks, and they must differ;
- **`start < end` is deliberately NOT required** — a night shift runs 22:00 to
  06:00, and refusing that makes a plant's whole roster unenterable.

The bulk path applies the same three date rules but **reports** them per row
rather than throwing: somebody laying a month over fifty people wants the eleven
cells that could not be written, not a batch that stops at the first one. A day
already rostered is reported as `skipped`, not silently replaced, unless the
caller sends `overwrite`.

`update` re-runs the *shape* rules against the merged row (so switching to
FLEXIBLE without sending hours fails) but **not** the date rules — `date` and
`employeeId` are not editable, so an update can never move a row into a state
create would have refused, and re-checking would make a note edit fail for a row
that was legal when it was written.

### 4.7 Period resolution

Separate from the attendance hub's resolver, because the two disagree about time
in a way that is not cosmetic:

- **No `today` period.** "Who is rostered today" is a calendar screen. Week
  leads and is the default.
- **Forward paging is allowed.** Attendance never aggregates past today — a day
  that has not happened cannot be an absence. A roster is a plan, and "is next
  week covered" is the question this module exists for. It stops one year out,
  where the roster is empty by definition and a wall of zeros reads as broken.
- `anchor` is a date *inside* the period, never an offset, so stepping back a
  month from the 31st cannot land on a day February does not have.

---

## 5. Data

### Models read

| Model | Fields the module reads | Why |
| --- | --- | --- |
| `WorkSchedule` | `employeeId`, `date`, `shiftType`, `startTime`, `endTime`, `requiredHours`, `isWorkDay`, `notes` | The roster itself. |
| `Employee` | `id`, names, `employeeCode`, `avatarUrl`, `status`, `branchId`, `departmentId` | Who is in scope, and which calendar applies. |
| `Branch` | `timezone`, `officeStartTime`, `officeEndTime`, `graceMinutes`, `weeklyOffDays` | The working week, per branch. |
| `Holiday` | `date`, `name`, `branchId` | Company-wide plus per-branch, branch row winning. |
| `Company` | `timezone` | Bottom of the zone inheritance chain. |
| `Department` | `id`, `name`, `managerId` | The ranking panel, and manager scope. |
| `Contract` | `startDate`, `endDate`, `status` | The window a person may be rostered in. |
| `Attendance` | `date`, `status = ON_LEAVE`, `notes` | The nearest thing this schema has to an approved leave day. |

**No schema change was made.** `WorkSchedule` and every model above are
untouched — which is what keeps the attendance module, which reads the same
table, working unchanged.

### Money and dates

No money crosses this module. Every date-only value goes through `dayKeyToDate`
/ `toDayKey` on the server and `formatDateOnly` / the day-key helpers in
`utils/scheduleHours.ts` on the client. `2026-01-15` put through an instant
parse is the 14th anywhere west of Greenwich, and a grid built on that draws the
whole month one column out.

### Seed

`seedWorkSchedules` in `apps/backend/prisma/seed.ts` now lays two working weeks
so that every panel has something true to draw:

| Pattern | People | Why it is there |
| --- | --- | --- |
| Night rotation 20:00–04:00 | EMP-0012, EMP-0013 | The midnight crossing — the case the whole table exists for. |
| Morning 06:00–14:00 | EMP-0014 | Gives the shift-mix panel more than one bar. |
| Afternoon 14:00–22:00 | EMP-0019 | Gives the hourly curve a shape rather than a block. |
| Compressed week, Mon–Thu 06:00–16:00 | EMP-0015 | Exercises the `weekdays` filter. |
| Flexible, 7h | EMP-0007 | Makes `flexibleExcluded` non-zero, so the curve reports what it leaves out. |
| Full day on the branch **weekly off** | EMP-0011 | The conflict the roster is happy to contain. Relative to today, so it is always inside the week the dashboard opens on. |
| Skeleton cover on the next **holiday** | EMP-0010 | The other conflict kind. On a real holiday date, so it is reported on the date it occurs. |

Roughly half the workforce is left unrostered on purpose: "who has no shift" is
the number the module exists to surface, and a seed where everybody is covered
cannot show that the card works.

---

## 6. Tests

| Suite | Where | Count |
| --- | --- | --- |
| Backend unit (jest) | `src/schedules/*.spec.ts` | 55 |
| Frontend unit (vitest) | `utils/scheduleHours.test.ts`, `utils/chartAxis.test.ts` | 36 |
| Frontend component (vitest) | `app/dashboard/schedules/**/page.test.tsx` | 32 |
| Playwright | `e2e/specs/schedules.hr-admin.spec.ts`, `schedules.payroll-employee.spec.ts` | 22 per role project |

`npm run lint`, `npm run typecheck` and `npm test` are green across both apps
(451 tests). The Playwright specs are collected and role-scoped correctly but
**were not executed** — they need `npm run e2e:up`, and Docker was not running
on this machine.

What the tests actually pin down, rather than restate:

- a night shift is eight hours, on both sides of midnight, in the util, in the
  hourly curve and in the grid cell;
- a branch's weekly off shades that branch and not the other;
- a branch holiday applies to that branch only; a company-wide one to everybody;
- a holiday landing on a weekly off is counted **once**;
- a rate is an em dash when nothing could be divided, never `0.0%`;
- a department with no roster reports **0%**, not "no data" — unlike the
  attendance hub, where the absence of a punch is genuinely unknown;
- the bulk `weekdays` list is the days the pattern **applies to**, not a skip
  list, and a pattern landing on no days will not run;
- the stepper walks *forward* out of the current window, unlike attendance;
- a refused delete surfaces an error and leaves the row on screen.

---

## 7. What changed from HRM

| HRM | Here | Why |
| --- | --- | --- |
| `startTime`/`endTime` are `DateTime` | Wall-clock `VarChar(5)` | This schema's existing column type. Every hour computation, the overlap rule, the hourly curve and the modal were rewritten as minute arithmetic on a dial. |
| `LeaveRequest` / `OvertimeRequest` models | Neither exists here | The leave lane now reads `Attendance.status = ON_LEAVE`, which is the nearest true thing. The overtime lane is **dropped** — see the interconnection doc. |
| `ShiftType.CUSTOM` | Five values, no `CUSTOM` | This schema's enum. |
| `Employee.fullName` column | `firstName` + `lastName` | Joined at the edge, in one helper. |
| Branch-context middleware (`getBranchContext`, `assertInBranch`) | Not present here | Scope is role-derived instead: manager departments read from `Department.managerId`, branch narrowing offered as an explicit filter. |
| `HolidaysService.getHolidaysInRange` / `getWeeklyOffDays` / `getWorkingDatesBetween` | `AttendanceCalendarService` | This repo already resolves a branch's working day there. Re-deriving it would give the two hubs different answers to "was the office open". |
| `ShiftNotificationScheduler` (email + in-app shift reminders) | **Not migrated** | It needs `MailModule`, `NotificationsModule`, `SystemSettingsService.getSetting` and `TimezoneService`, plus `priorEmailSent` / `postEmailSent` columns. None exist here. Recorded as pending. |
| FullCalendar (`@fullcalendar/*`) | Hand-built `ShiftCalendar.tsx` | Three reasons: every calendar library wants an *instant*, and synthesising one re-introduces exactly the drift the wall-clock column avoids; the portal is RTL in Arabic and a grid of logical CSS properties flips for nothing; and the interactions needed are "click a day" and "click a shift" — a drag-and-drop scheduler is a large dependency for two click handlers. |
| Three screens (`schedules`, `overview`, `shifts`) | Four | HRM's `shifts` page combined a per-employee calendar with management. Split into **Shift calendar** and **Shift management**, matching the four names the module is described by. |
| `sonner` toasts for shift details | Inline detail and a real modal | A toast is not a place to read a shift window. |
| `useEffect` + `setState` to seed modal forms | Mount/unmount keyed on the row | React's own guidance, and it is what the repo's lint rules enforce. The effect also re-rendered the form twice per open. |

### Shared files touched

Every one, with the minimum edit:

| File | Edit |
| --- | --- |
| `apps/backend/src/app.module.ts` | Import and register `SchedulesModule`. Two lines. |
| `apps/backend/src/work-schedules/work-schedules.service.ts` | Added `assertSchedulable` and `assertShiftShape` to the create, update and bulk paths; bulk now pre-loads leave days in one query and reports non-ACTIVE employees per person. Existing signatures unchanged. |
| `apps/backend/prisma/seed.ts` | `seedWorkSchedules` rewritten (see §5). Nothing else in the seed touched. |
| `apps/frontend/components/layout/navConfig.ts` | One new nav group in the admin tree and one in the department-head tree. |
| `apps/frontend/utils/permissions.ts` | `VIEW_SCHEDULES` / `MANAGE_SCHEDULES`, mirroring the server's `RolesGuard`. |
| `apps/frontend/services/workScheduleService.ts` | Rewritten. Its `bulk` payload did not match the backend DTO — it sent `skipWeekdays` where the server reads `weekdays`, and omitted `overwrite`, `isWorkDay` and `notes`. Its declared return type was wrong too. The file was unreferenced, so nothing depended on the broken shape. |
| `apps/frontend/hooks/useWorkSchedules.ts` | **Deleted.** Unreferenced, and superseded by `hooks/useSchedules.ts`. Two hooks over one endpoint is the drift this repo's conventions warn against. |
| `apps/frontend/messages/{en,ar}/` | New `schedules.json` namespace, registered in both `index.ts`; four sidebar keys and one module-landing block added to each locale. |

### Left out, and why

| Not migrated | Reason |
| --- | --- |
| Shift email / in-app reminders | No `MailModule`, `NotificationsModule` or notification columns in this repo. Documented in the interconnection doc as pending. |
| The overtime lane on the calendar | No `OvertimeRequest` model. |
| Approved-but-unrecorded leave | No `LeaveRequest` model. The leave lane shows days already written to `Attendance`; a leave approved but never posted to a day does not appear. |
| Lunch-break deduction in scheduled hours | HRM read `lunch_break_start` and `lunch_break_duration_minutes` from system settings. Those keys do not exist here, and inventing a default would silently change every hours figure on the page. |
| `calendar_weekly_holidays` global setting | This repo resolves the working week per **branch** (`Branch.weeklyOffDays`), which is strictly more specific. |
