# Screen-depth audit, and what MVP covers

Route coverage is complete; **screen depth is not**. Measured as non-test source
lines for each area (page + its components), against the system this was ported
from:

| Area | Reference | Ours | |
| --- | --- | --- | --- |
| employees | 10,074 | 1,617 | **16%** |
| contracts | 3,862 | 1,298 | **33%** |
| time hub | 815 | 304 | **37%** |
| attendance | 7,067 | 2,960 | **41%** |
| departments | 4,400 | 1,937 | **44%** |
| branches | 1,676 | 1,127 | 67% |
| organization hub | 772 | 755 | 97% |
| people hub | 381 | 398 | 104% |
| visa reports | 401 | 462 | 115% |

Some of that bulk is genuinely out of scope — `SalaryStructure` (payroll),
`OvertimePolicyModal` (leave & overtime), `EmployeeRewardsAndDisciplines`
(talent). Those belong to modules nobody migrated.

## The decision: MVP

The product is targeting **MVP — the core features plus UI parity with the
existing system**, not depth for its own sake. The audit below is therefore
split into what is being closed now and what is deliberately deferred. It is a
record of a decision, not an open list of defects.

Nothing already working is being replaced to get there. The one exception is the
attendance log, which is not thin but *wrong*: a flat paginated list where the
original is a month grid.

## In MVP scope

**The list pattern, repeated.** Four things sit on almost every list screen in
the original and on none of the first cut here. They are the bulk of the visible
gap and the cheapest half of it to close:

1. a view switcher — Cards / Table;
2. a stats bar above the list;
3. a filter panel beyond the single search box;
4. export to XLSX.

Applied to: employees, branches, departments, contracts, and the two attendance
list screens.

**Attendance log as a month grid.** Employees as rows, every day of the month as
a column, check-in over check-out per cell, weekend/holiday/future shading, and a
per-employee summary (Present · Absent · Late/Early · Hours · Early In · Late
Out). Backed by a new `GET /attendances/monthly-report` that includes every
active employee — not only those with rows — and derives absence from the
working calendar.

**`/dashboard/attendance/detail/[id]`** — the one route with no page at all.
Deliberately simple: one card, no tabs.

## Deferred, with the reason

| Deferred | Why it is not MVP |
| --- | --- |
| `EmployeeOnboardingStepper` (1,841 lines) | The flat form creates a valid employee. A stepper is a nicer way to do something that already works. |
| `ImportModal`, `ExportModal` beyond XLSX | Bulk import needs a mapping step, a dry run and per-row reconciliation — a feature, not a screen. |
| `AvatarUpload` / crop | Cosmetic; `avatarUrl` already renders where set. |
| Kanban view, `ColumnPicker`, `QuickFilterChips` | A third view and per-viewer table config, on top of two views that cover the need. |
| Employee record sections — `ActivityTimeline`, `VisaSection`, `DocumentUpload`, `ProfileCompletionBar` | Each needs its own storage or endpoint. Permits already have their own screen. |
| `DepartmentOrgView`, `PerformanceDashboard` | The indented tree already answers "what is the shape of the organisation". |
| `TerminationApprovalPanel`, `TerminationHistory` | The queue approves and rejects correctly today. The panel is presentation over a working flow — though its confirm step now states the consequence in words. |
| `AutoAbsentTrigger`, `AttendanceLiveFeed`, `AttendanceGauge`, insight charts | The hub already carries the trend, the department ranking and the attention strip. |

## The lesson worth keeping

Route parity is not feature parity. Every route existed and every test passed
while several screens were a fraction of their originals — counting routes
reported this migration as finished when it was not. Compare screens, not URLs.
