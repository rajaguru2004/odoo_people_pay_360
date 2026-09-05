# Payroll analytics — walkthrough

The Power BI-style analytics page at **`/dashboard/payroll/analytics`**, backed by
**`GET /payroll/dashboard`**.

This is the *analytics* page, not the payroll hub. The hub (`/dashboard/payroll`,
`GET /payroll/hub-summary`) already shipped and is unchanged — see
`payroll-walkthrough.md`. [Why a second endpoint](#why-a-second-endpoint) says why
they are two.

---

## Contents

- [What it does](#what-it-does)
- [Why a second endpoint](#why-a-second-endpoint)
- [Files](#files)
- [The endpoint](#the-endpoint)
- [The visual register](#the-visual-register)
- [Colour](#colour)
- [The rules, and where each is enforced](#the-rules-and-where-each-is-enforced)
- [Three pieces of arithmetic worth reading twice](#three-pieces-of-arithmetic-worth-reading-twice)
- [Testing](#testing)
- [How to change something](#how-to-change-something)
- [What was left out, and why](#what-was-left-out-and-why)

---

## What it does

A payroll officer opens the page on the latest **locked** run — approved or paid,
never a draft — and reads what that month cost, how it decomposed, which
departments it went to, where the runs are in the pipeline, and what is blocking
the next one. Three slicers (period, department, employment type) re-query one
endpoint, so every visual moves together.

Eleven visuals, one KPI row, one alert list, one filter row.

---

## Why a second endpoint

`GET /payroll/hub-summary` is shipped, tested and consumed by
`app/dashboard/payroll/page.tsx`. Its `PayrollHubSummary` has **no department
breakdown, no component split and no slicers** — the analytics visuals need all
three. Widening it would change a live contract and make every hub request pay
for aggregates the hub never draws.

**They cannot disagree**, because everything they share is imported rather than
rewritten. `payroll-dashboard.service.ts` takes `LOCKED_RUN_STATUSES`, `money`,
`companyToday`, `describePeriod`, `trendWindow`, `NAME_CAP` and `buildAttention`
straight from `payroll-hub.service.ts`. The arithmetic that is this page's alone
lives in `payroll-dashboard.util.ts`, which has no Prisma and no Nest in it.

---

## Files

```
apps/backend/src/payroll/
  payroll-dashboard.controller.ts    GET /payroll/dashboard
  payroll-dashboard.service.ts       the aggregate — one method, one round of reads
  payroll-dashboard.util.ts          pure maths: trend, bridge, mix, funnel, rates
  payroll-dashboard.util.spec.ts     25 unit tests, no database
  dto/dashboard-query.dto.ts         the slicers; an unoffered value is a 400
  payroll.module.ts                  MODIFIED — controller + provider registered

apps/backend/test/
  payroll.e2e-spec.ts                MODIFIED — §10 "dashboard", 9 API tests

apps/frontend/
  app/dashboard/payroll/analytics/page.tsx   the page: filter row, KPIs, alerts, grid
  hooks/usePayrollDashboard.ts               filters ⇄ URL + the single query
  hooks/useChartDirection.ts                 RTL axis props (SVG has no `dir`)
  services/payrollDashboardService.ts        one method, one route
  types/payrollDashboard.ts                  the response contract

  components/charts/                 SHARED, module-agnostic
    ChartFrame.tsx                     panel + skeleton + empty + table toggle + CSV
    ChartFrame.test.tsx                7 tests — the states and the twin
    ChartTable.tsx                     the table every chart carries
    tooltips.tsx                       Recharts `content` → the hub's tooltip card

  components/payroll/dashboard/      ONE FILE PER VISUAL
    DashboardFilters.tsx  dashboardKpis.ts(+test)  AttentionList.tsx
    NetSalaryTrendChart.tsx  CumulativeCostChart.tsx  PipelineFunnel.tsx
    StatusDonut.tsx  DepartmentCostChart.tsx  ComponentMixChart.tsx
    NetBridgeChart.tsx  DepartmentTreemap.tsx  AttendanceMixChart.tsx
    CoverageGauges.tsx(+test)  DepartmentMatrix.tsx  chartFormat.ts(+test)

  theme/chartColors.ts               MODIFIED — series ramps appended
  theme/chartColors.test.ts          10 tests, incl. the filter-stability regression
  components/layout/navConfig.ts     MODIFIED — one child added
  messages/{en,ar}/sidebar.json      MODIFIED — one label each
  test/setup.ts                      MODIFIED — the ResponsiveContainer mock
  e2e/specs/payroll-dashboard.admin-payroll.spec.ts
```

### On `components/charts/` versus the existing kit

The shared kit **is** `components/module-landing/primitives.tsx` — it already
ships `DonutChart`, `BarOverviewChart`, `SplineTrendChart`, `ChartTooltipCard`,
`MeterList` and `SegmentedBar`, and all three hubs use it. `components/charts/`
holds only what that file has no answer for: a frame with a table twin, and the
Recharts tooltip adapter. It defines **no colours** — those went into
`theme/chartColors.ts`, the live palette, so the app has one.

Recharts draws the plot areas; the panel chrome, the KPI cards and the alert
strip are the existing components. That is what makes the page read as part of
this app rather than as a Recharts demo dropped into it.

---

## The endpoint

```
GET /payroll/dashboard
  ?months=6|12                     trend window        (default 12)
  &period=YYYY-MM                  focus period        (default: latest LOCKED run)
  &departmentId=<uuid>|unassigned
  &employmentType=<label>|unassigned
```

`@Roles(ADMIN, HR_MANAGER, PAYROLL_OFFICER)` — the same three as
`hub-summary`, which is what `NavGroup.hubRoles` in `navConfig.ts` already
carries. The analytics child inherits them, so the rail cannot offer a route the
server refuses.

**Every slicer is validated and an unoffered value is a 400.** `months=7`,
`period=2026-13`, a `departmentId` that is neither a uuid nor the literal
`unassigned`, a well-formed uuid naming no department, an employment type that is
not in the library: all refused. A dashboard showing the unfiltered company under
a chip reading "Finance" has lied about what the reader is looking at.

**`period` defaults to the latest locked run, not to today.** Opening on an unrun
month would show a page of em dashes to a reader who has done nothing wrong.

`employmentType` is validated for **length only**, then checked against
`LibraryItem`. `Employee.employmentType` stores an EMPLOYMENT_TYPE library
*label*, and that set is admin-configurable — a hard-coded enum would 400 a
category HR added this morning.

### Three response fields that are easy to miss

| Field | Why it exists |
|---|---|
| `money.otherCurrencies[]` | `PayrollRun.currency` is per run. Totals count **one** currency; trend months in another are excluded and disclosed here, because adding OMR to KWD produces a number that is not money. The *focus period* can never be mixed — `@@unique([periodStart, periodEnd])` means a month has at most one run. |
| `bridge.netFloorResidual` | Each payslip floors its own net at zero (`payroll-calc.util.ts`), and only LOP is capped at gross. So across a run **`Σnet ≥ Σgross − Σdeductions`**, and the difference is drawn as its own step. Zero in the ordinary case. |
| `runs.funnel[].reached` | Cumulative reach read from `calculatedAt` / `approvedAt` / `paidAt`, not from current status. See [below](#the-funnel-is-reach-not-status). |

---

## The visual register

Component paths are relative to `apps/frontend/components/payroll/dashboard/`.

### Filter row

| | |
|---|---|
| Component | `DashboardFilters.tsx` |
| Reads | `filters` — the server echoes back the RESOLVED slicers and the options it offers |
| Rule | **One row, above everything it scopes.** Never a filter inside a chart card: a control on one panel looks like it narrows that panel. Options come from the server, so the row cannot ask for a 400. |

### KPI row — `dashboardKpis.ts` → `module-landing/StatCard.tsx`

| Card | Reads | Note |
|---|---|---|
| Total net salary paid | `money.net`, `money.changePct`, `trend[].net` | Sparkline via `generateSparkPath`. The delta shows the **absolute** change, not the percentage — for money the reader was going to do that subtraction anyway. Dropped entirely when `changePct` is `null`. |
| Payslips generated | `payslips.total` | Counted in the database, never `rows.length`. |
| Average salary | `money.averageNet` | `null` when nobody was paid. An average of nothing is not zero. |
| Approved time off | `timeOff.approvedDays` | **Days, not requests.** `LeaveRequest.totalDays` is working days with the branch calendar and its holidays already removed, and it is stored rather than recomputed so it keeps the number the approver agreed to. |
| Attendance health | `coverage.attendanceRate` | Divides by attendance **events**, never headcount. |

### The eleven visuals

| Visual | Recharts | Component | Reads | The rule that makes it true |
|---|---|---|---|---|
| Monthly net salary | `LineChart` | `NetSalaryTrendChart` | `trend[]` | Crosshair tooltip — on a continuous series the reader is locating a point in time. Every month gets a point whether or not a run was locked; omitting empties would draw a line through a month nobody was paid in. |
| Cumulative payroll cost | `AreaChart` | `CumulativeCostChart` | `trend[].cumulativeNet` | The running sum is **server-owned**. A client `reduce` restarts the total at the window edge, so the same August reads differently at 6M and 12M. |
| Payrun pipeline | stepped `BarChart` | `PipelineFunnel` | `runs.funnel` | Not `FunnelChart`: a funnel scales band *width* by value, which reads as area and makes a 4→3 drop look like a collapse. `CANCELLED` is not a stage — it sits beside the chart as a count. |
| Runs by status | `PieChart` + `innerRadius` | `StatusDonut` | `runs.byStatus` | **`Payslip` has no status column** — a payslip's status is its run's. `Computed` = `CALCULATED`, `Validated` = `APPROVED`. The hole carries the total. |
| Salary cost by department | `BarChart` | `DepartmentCostChart` | `departments[]` | Colour keyed on department id from the **unfiltered** option list. Employees with no department get an explicit **Unassigned** bar. Click drills to the filtered payslips. |
| Basic / allowances / deductions | `BarChart` | `ComponentMixChart` | `components[]` | Grouped on `PayslipLine.code` + `type` — the snapshot — never through the nullable `componentId`. `EMPLOYER_CONTRIBUTION` is not in the stack. |
| Gross to net | `BarChart`, floating bars | `NetBridgeChart` | `bridge` | A stacked bar with a **transparent base**; Recharts has no waterfall. Renders `netFloorResidual` as its own step, or the bars do not reach the final column. |
| Headcount against salary | `Treemap` | `DepartmentTreemap` | `departments[]` | Area = total cost, fill = average pay per head on a **sequential** ramp with a scale legend. Two measures on one mark, so no second axis. Cell labels drawn only where they fit. |
| Attendance composition | `BarChart`, normalised | `AttendanceMixChart` | `attendance[]` | Normalised to 100%, or the reader compares headcount believing they compare attendance. `HOLIDAY`/`WEEKEND` excluded upstream. **Overtime is not a segment** — see below. |
| Coverage | `RadialBarChart` ×2 | `CoverageGauges` | `coverage` | `PolarAngleAxis` pinned to **0–100**, or Recharts scales the arc to its own value and a lone 62% draws as a full ring. `null` → empty track and an em dash. |
| Department breakdown | sortable table + totals | `DepartmentMatrix` | `departments[]` | The matrix visual **and** the table twin for the treemap and the cost bar — same colour chip, so Finance is the same orange in all three. |
| Alerts | badge list | `AttentionList` | `attention[]` | Rendered through `AttentionStrip`: severity is a colour **and** an accent **and** an icon **and** the words. `count` is the total; `names` is a capped sample. |

### Overtime does not stack with attendance

`Present / Late / Absent / Half-day / On leave` are **day counts**. Overtime is
`Decimal(5,2)` **hours** on `OvertimeRequest`, with no link to `PayslipLine`.
Stacking them puts two scales on one axis — the dual-axis mistake wearing a
different hat. `overtime.approvedHours` is on the response and is reported as its
own figure.

---

## Colour

All slots are in `theme/chartColors.ts`, appended below the existing
`chartColors` object, which is **unchanged** for its current callers.

**`chartColors.palette` must not be used for entities.** Its slots 3 and 4 *are*
`statusSuccess` and `statusWarning`, so a page using it paints the third
department green and the fourth amber — and a green department reads as a healthy
one. `SERIES_RAMP` exists for that, and `chartColors.test.ts` asserts it holds
none of the four status hues.

| Scale | Export | Used for |
|---|---|---|
| Categorical, 8 slots | `SERIES_RAMP` + `createSeriesScale()` | Departments |
| Neutral tail | `SERIES_OTHER` | The 9th entity onward, and Unassigned |
| Ordinal, one hue light→dark | `RUN_STATUS_COLORS` | The run lifecycle; `CANCELLED` is neutral |
| Diverging, two hues | `COMPOSITION_COLORS` | Earnings vs deductions |
| Status | `ATTENDANCE_COLORS` | The one place status colour is right for a series — the segments *are* the status |
| Sequential | `sequentialFill(t)` | Treemap fill by average pay |

**Colour follows the entity, not its rank.** `createSeriesScale()` is seeded from
the **unfiltered** `filters.departments` list, which the server returns on every
response for exactly this reason. Assigning by array index is the bug it prevents:
filtering out Finance would shift every later department a slot along, and the
reader who learned Finance is orange watches Engineering change colour because of
a filter that has nothing to do with it. There is a regression test.

Two slots (orange, cyan) sit near 3:1 on the white card. That is why every chart
ships **direct labels and a table twin** — colour is never the only thing carrying
a mark's identity.

---

## The rules, and where each is enforced

| Rule | Enforced in |
|---|---|
| Live data only — every number traces to a Prisma read | `payroll-dashboard.service.ts` |
| Aggregate server-side | one `Promise.all`; `groupBy` and `aggregate`, never `rows.length` |
| Money means APPROVED or PAID | `LOCKED_RUN_STATUSES`, imported from the hub |
| A rate is `null`, never `0` | `rate()` from `attendance-calendar.util.ts`; `formatPercent` prints `—` |
| The server owns every label | `periodLabel`, `describePeriod` |
| A named sample is not a count | `NAME_CAP = 5`, imported from the hub |
| One y-axis per chart, never dual | the treemap and the normalised bar are the two places that would have tempted a second |
| `formatCurrency` / `formatDateOnly` | every money and date call site |
| Logical CSS + RTL-safe SVG | `ps-*`/`me-*`/`text-end` in the chrome, `useChartDirection()` for the axes |
| Skeleton on first load, previous render held on refetch | `ChartFrame`; `placeholderData: (prev) => prev` in the hook |
| "No data for this period" is a written sentence | `ChartFrame`'s `empty` + `emptyLabel`, distinct from `loading` |
| Every chart has a table twin and an export | `ChartFrame` builds both from the **same rows** |
| Drill-through | department bar/cell/row → `payslips?departmentId=…&period=…`; status arc → `runs?status=…` |
| Permissions are UI affordances, not a boundary | `ProtectedRoute` + `@Roles` on the controller |

### RTL is not solved by logical CSS

`ps-*` / `me-*` / `start-*` flip the panel around a chart and do **nothing** to an
SVG — Recharts keeps drawing its categories left-to-right and its value axis on
the left however `dir` is set. `useChartDirection()` reads `dir` off the document
(and watches it with a `MutationObserver`, because the locale switcher flips it
live) and hands every chart `<XAxis reversed>` and `<YAxis orientation="right">`.

---

## Three pieces of arithmetic worth reading twice

### The bridge closes because of a step most people would omit

```
Gross                                      Σ Payslip.grossPay
− Deductions                               Σ Payslip.totalDeductions
+ Net floored at zero  ← netFloorResidual  Σ max(0, deductions_i − gross_i)
= Net                                      Σ Payslip.netPay
```

`netPay = max(0, gross − deductions)` per payslip, and an ordinary deduction is
**not** capped at gross (only LOP is). So anybody whose deductions exceeded their
earnings has their excess charged to nobody, and the run's `Σnet` comes out
**above** `Σgross − Σdeductions`. Without the third step the bars do not reach the
final column. It is drawn only when non-zero — a permanent "adjustment: 0" column
teaches the reader to ignore the one mark that means something went wrong.

`EMPLOYER_CONTRIBUTION` is in none of these figures. It is recorded and never paid
to anybody; it appears only as `money.employerCost` and as its own column in the
matrix.

### The funnel is reach, not status

Counting the status a run is in *right now* is not a funnel: a run in `PAID` is
not also in `DRAFT`, so the bars go up and down. `buildFunnel()` counts runs that
have reached **at least** each stage, read from the **timestamps**:

```
Started    every non-CANCELLED run
Computed   calculatedAt IS NOT NULL
Validated  approvedAt   IS NOT NULL
Paid       paidAt       IS NOT NULL
```

Monotonically decreasing by construction, so each drop is the count stuck at that
gate. Reading it off the current status would un-count a **rejected** run, which
sits back in `DRAFT` having genuinely been calculated once — `calculatedAt` still
says so. `CANCELLED` runs are in no stage at all.

### Attendance health divides by events, not by headcount and not by the calendar

```
health = (present + late + halfDay) / (present + late + halfDay + absent + onLeave)
```

`HALF_DAY` counts as worked — the person was there. `ON_LEAVE` stays in the
denominator, or a team could improve its own rate by taking holiday. `HOLIDAY` and
`WEEKEND` are excluded entirely: they are calendar facts, not things anybody did,
and leaving them in shrinks every rate by however many days the branch was shut.
`null` when there were no events at all.

---

## Testing

| Layer | Where | Count |
|---|---|---|
| Backend unit | `payroll-dashboard.util.spec.ts` | 25 |
| API | `test/payroll.e2e-spec.ts` §10 | 9 |
| Frontend unit | `chartColors.test.ts`, `dashboardKpis.test.ts`, `chartFormat.test.ts` | 29 |
| Component | `ChartFrame.test.tsx`, `CoverageGauges.test.tsx` | 11 |
| E2E | `e2e/specs/payroll-dashboard.admin-payroll.spec.ts` | 9 |

The regressions each layer exists to catch:

- **unit** — the bridge closing including the floor residual; the funnel staying
  monotonic and counting a rejected run; `HOLIDAY`/`WEEKEND` out of the
  denominator; `rate()` returning `null` not `0`; the series scale holding a
  colour still when an entity is filtered out.
- **API** — every slicer refusing an unoffered value; the role matrix; a filter
  narrowing **every array**, not only the KPIs.
- **component** — `null` rendering as an em dash and never `0.0%`; loading, empty
  and data as three distinct trees; the CSV matching the table exactly.
- **E2E** — the filter state surviving a reload; the table twin; the drill-through.

### The `ResponsiveContainer` mock

`test/setup.ts` mocks it to a fixed 400×300 box. It measures its parent, jsdom has
no layout engine, and `ResizeObserver` is already a no-op there — so without the
mock every chart test would assert against an empty SVG and pass for the wrong
reason. Only the container is replaced; the charts render their real marks inside
it. Written with `createElement` rather than JSX so the file stays `.ts`.

---

## How to change something

**A chart's look** — edit its component. Nothing else moves.

**A colour** — `theme/chartColors.ts` only, never a hex in a component. That is
what will let dark mode repaint this page with no edit to it when the tokens land.

**A number on an existing chart** — compute it in `payroll-dashboard.service.ts`
(in the database), add the field to `types/payrollDashboard.ts` with a comment
saying why it is nullable if it is, then read it in the component. Deriving it in
React re-implements the aggregate in a second place, and the two will drift.

**A whole new visual** — add a row to [the register](#the-visual-register) *first*,
so the rule is written before the code; then the aggregate, the type, one
component, mount it in the grid, and a column in `DepartmentMatrix` or its own
table twin.

**A slicer** — `dto/dashboard-query.dto.ts` with validation, because an unoffered
value is a 400; then the service's `where`; then `DashboardFilters.tsx`. Add it to
`filterOptions()` too, so the control can only offer what the endpoint accepts.

---

## What was left out, and why

Recorded as seams in `interconnections-payroll.md`:

- **Bank details.** There is no bank, IBAN or account column anywhere in
  `schema.prisma`, so a "missing bank details" alert is not buildable. The alert
  list carries the pre-flight's real findings instead.
- **Duplicate payslips.** Structurally impossible —
  `Payslip @@unique([payrollRunId, employeeId])` and
  `PayrollRun @@unique([periodStart, periodEnd])`. An alert that can never fire
  trains the reader to ignore the strip.
- **Dark mode.** `theme/types.ts` still says dark tokens are deferred and the four
  presets are light-only. Adding them is a shared-theme change, outside this
  module under `AGENT_INSTRUCTIONS.md` §3. This page is token-only, so it repaints
  for free when they land.
- **Overtime in the attendance bar.** Hours cannot stack into a bar of days.
- **Per-payslip status.** Status lives on `PayrollRun`. If a single held payslip
  inside an approved run ever needs representing, that is a new column and the
  donut becomes its consumer.
- **A `months` value other than 6 or 12.** Matching the hub and the Organisation
  hub, so the two pages under the same stepper never count different windows.
