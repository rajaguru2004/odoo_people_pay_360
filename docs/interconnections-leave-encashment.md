# Leave encashment — deferred, with its contract

**Status: not built.** This document is the contract, so whoever builds it — or
whoever builds payroll — has something to build against rather than a blank file.

Companion to [interconnections-leave-overtime.md](interconnections-leave-overtime.md)
and [leave-overtime-walkthrough.md](leave-overtime-walkthrough.md).

---

## 1. What it is, and why it is not here

**Leave encashment** is paying an employee for leave they did not take.
**Year-end carry-forward** is moving what is left into next year. They are the
same money seen twice, which is why they belong in one module and why building
either without the other produces a balance that can be spent twice.

In the source checkout the module is ~1,250 lines and depends on three things
this repository does not have:

| Dependency | What it is | Status here |
| --- | --- | --- |
| `PayrollItem` | A line on a payroll run — what an encashment BECOMES | ✗ no payroll module |
| Per-employee `SalaryComponent` | What one day of leave is WORTH for one person | ✗ `SalaryComponent` here is a company-wide catalogue, not an assignment |
| `PayrollFeaturesService` | Whether the deployment settles encashment through payroll at all | ✗ does not exist |

Building it against a payroll module that does not exist would mean inventing a
settlement path and then rewriting it. So the module is deferred and the four
columns it needs on a table **this** branch owns ship now — see §4.

---

## 2. Models owed

None of these exist. All are new.

### `LeaveEncashmentRequest`

| Column | Type | Note |
| --- | --- | --- |
| `id` | uuid | |
| `employeeId` | uuid | `onDelete: Cascade` |
| `year` | Int | Which entitlement year is being cashed |
| `leaveTypeKey` | VarChar(100) | Matches `LibraryItem.label` — same key rule as everything else |
| `days` | Int | Whole days; the balance columns are integers |
| `dailyRate` | `Decimal(18, 3)` | **Snapshotted at approval** — see §5 rule 1 |
| `amount` | `Decimal(18, 3)` | `days × dailyRate`, stored |
| `status` | `RequestStatus` | The enum already exists |
| `approverId`, `approvedAt`, `rejectedReason` | | Same shape as the other two request models |
| `payrollItemId` | uuid? | Set by `linkToItem`; null until settled |
| `settledAt` | Timestamp? | Set by `settleForPayroll` |

`@@index([employeeId, year])`, `@@index([status])`.

### `LeaveCarryForwardRun`

| Column | Type | Note |
| --- | --- | --- |
| `id` | uuid | The id written into `LeaveTypeBalance.carryForwardRunId` |
| `branchId` | uuid? | Null = company-wide |
| `fromYear`, `toYear` | Int | |
| `runBy` | uuid? | |
| `rowsWritten` | Int | |
| `createdAt` | Timestamp | |

**`@@unique([branchId, fromYear, toYear])`** — see §5 rule 4. This is the one
constraint that stops a re-run doubling every balance in the company.

---

## 3. The payroll seam

Four methods, and the direction of each. **Encashment → payroll is one way.**
Payroll never writes back into a balance; it tells encashment what happened and
encashment moves its own rows.

| Method | Called by | Does |
| --- | --- | --- |
| `loadForPayroll(employeeId, cycle)` | payroll, building a run | Returns APPROVED, unsettled encashments in the window: `{ id, days, dailyRate, amount, leaveTypeKey }`. Read-only. |
| `linkToItem(encashmentId, payrollItemId)` | payroll, after creating the line | Records which line carries it. Does **not** settle it — a draft run can be discarded. |
| `settleForPayroll(encashmentId)` | payroll, when the run is PAID | Sets `settledAt` **and increments `LeaveTypeBalance.used`** by `days`, in one transaction. See §5 rule 3. |
| `reverseForPayroll(encashmentId)` | payroll, when a run is cancelled after settlement | Clears `settledAt` and `payrollItemId`, and decrements `used` by the same `days`. Floored at zero. |

### Why one way

If payroll could write a balance directly, two modules would own `used` and the
question "who spent this day" would have two answers. Encashment owns its own
effect on the balance and exposes only *what happened*.

---

## 4. What this branch already shipped for it

Three columns on `LeaveTypeBalance`, written by nothing today:

```prisma
/// When the carried balance lapses, if the policy sets an expiry.
carriedOverExpiresOn DateTime? @map("carried_over_expires_on") @db.Date
/// Which year the carried days came from, so a reversal knows what to undo.
carriedFromYear      Int?      @map("carried_from_year")
/// The run that wrote them. A reversal touches exactly these rows, no others.
carryForwardRunId    String?   @map("carry_forward_run_id") @db.Uuid
```

They ship unused **on purpose**. A migration on a live balances table is exactly
the change nobody wants to run twice, and the module that lands carry-forward
must not have to alter a table another module owns. The existing `carriedOver`
column is the fourth: it is already read by `remaining = allocated + carriedOver
- used` everywhere, so carry-forward writes to a column every screen already
draws.

---

## 5. The four money rules

Each of these is a bug that has been shipped somewhere. They are the whole reason
this document exists.

### Rule 1 — the rate is snapshotted at approval, not read at settlement

```
dailyRate is written onto the request when it is APPROVED.
Payroll reads THAT column, never the employee's current salary.
```

A salary review between approval and payment must not silently change what an
employee was told they would be paid for their leave. The same rule the overtime
module applies to `overtimePolicyId`, for the same reason.

### Rule 2 — carry-forward subtracts what was encashed

```
carriedOver(next year) = remaining(this year) − days already encashed(this year)
                       , capped by the policy maximum
```

Encashing five days and then carrying the same five is paying twice for one
absence that never happened. The subtraction has to run against APPROVED
encashments, not settled ones: a request approved in December and paid in January
still spends December's balance.

### Rule 3 — settlement increments `used`, it does not decrement `allocated`

```
settleForPayroll → used += days
```

Not `allocated -= days`. The allocation is what the employee was ENTITLED to and
is a year fact; `used` is what became unavailable to them. Reducing `allocated`
makes the year's entitlement disagree with the library default it came from, and
every company-wide total then under-reports what the company granted.

### Rule 4 — `@@unique([branchId, fromYear, toYear])` on the run

A carry-forward is idempotent through the run row and nothing else. Without the
constraint, running it twice on the 1st of January credits every employee twice,
and the second run is indistinguishable from the first in the data. With it, the
second attempt fails at the database.

`LeaveTypeBalance.carryForwardRunId` is what makes a reversal exact: it touches
the rows that run wrote, and no others.

---

## 6. What the encashment module will read from Leave & Overtime

All of it exists today.

| Needs | From |
| --- | --- |
| What is left, per type per year | `LeaveTypeBalance` — `allocated + carriedOver - used` |
| Whether a type may be encashed at all | `LibraryItem.affectsBalance` and `isPaid` on the `LEAVE_TYPE` row |
| How many days were actually taken | `LeaveTypeBalance.used` |
| Whose balance it may touch | `managerDepartmentIds` / `canAccessRequestOf` in `common/utils/manager-scope.util.ts` |
| Spending and refunding days | `LeaveBalancesService.deductDays` / `addDays` — already transaction-aware, both take an optional `tx` |

### One field the library will need

`LibraryItem` has no `encashable` flag. When the module lands, add it as a
nullable boolean on `LEAVE_TYPE` rows — sick leave is almost never encashable and
unpaid leave never is, so a per-type flag is the only honest way to express it. It
is additive and touches nothing that reads the table today.

---

## 7. Tests deferred with it

Two Playwright specs in the source checkout touch encashment and are not ported:
they assert on an encashment screen and on a payslip line, neither of which
exists. They come back with the module.

---

## 8. Summary for whoever picks this up

1. Build payroll first, or at least `PayrollItem`. Encashment without a
   settlement path is a request that can be approved and never paid.
2. Add the two models in §2, with the unique constraint in §5 rule 4.
3. Add `encashable` to `LibraryItem` (§6).
4. Implement the four seam methods in §3, one way.
5. Write carry-forward and encashment **together** — §5 rule 2 is not
   expressible if one of them ships alone.
6. Nothing in the Leave & Overtime module needs to change. The columns are
   already there.
