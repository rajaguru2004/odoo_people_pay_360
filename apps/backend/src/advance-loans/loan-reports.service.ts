import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { rawBranchFilter } from '../common/branch/branch-scope.util';
import { roundMoney } from '../common/utils/money.util';
import { LOAN_DEBT_STATUSES } from './loan.types';
import { LoanRecoveryService } from './loan-recovery.service';

/**
 * Reporting over the loan book.
 *
 * Three rules hold across every report here, because without them a report run
 * during payroll disagrees with the payslip and nobody can tell which is wrong:
 *
 *  1. Money-moved figures read PAID rows ONLY. A recovery sitting in an
 *     unlocked payroll has not happened yet.
 *  2. Those in-flight amounts are reported in a SEPARATE `inFlight` column,
 *     never folded into `outstanding`. The delta is then explicit rather than
 *     mysterious.
 *  3. Every response carries `meta.openPayrolls`, so a reader can see exactly
 *     which draft runs would move the numbers.
 *  4. DEBT is LOAN_DEBT_STATUSES and nothing else. A DRAFT or PENDING request
 *     has a principal figure and no debt — nobody approved it and no money
 *     left the company — and a CLOSED / WRITTEN_OFF / SETTLED loan's unrepaid
 *     principal is not owed either. Every report that answers "how much is
 *     owed" therefore SELECTS that set positively rather than excluding a
 *     couple of statuses it happens to remember. The two deliberate
 *     exceptions, each argued at its own method: `portfolio` (composition, so
 *     it must show terminal statuses, but reports 0 owed on them) and
 *     `interestEarned` (money that MOVED, which no later status change can
 *     unmake).
 *
 * Any `$queryRaw` here MUST splice `rawBranchFilter('e')` after its WHERE
 * predicates: the Prisma middleware cannot see raw SQL, so omitting it is a
 * silent cross-branch data leak.
 */
@Injectable()
export class LoanReportsService {
  constructor(private prisma: PrismaService) {}

  /** Draft/approved runs whose recoveries have NOT moved yet. */
  private async openPayrolls() {
    return this.prisma.payroll.findMany({
      where: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
      select: { id: true, month: true, year: true, status: true },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 20,
    });
  }

  /**
   * `warnings` states out loud that a filter CANNOT match, so an empty report
   * is never mistaken for "nobody owes anything". See `outstanding`'s
   * `loanTypeId` handling for the only current producer.
   */
  private async meta(asOf?: string, warnings?: string[]) {
    const open = await this.openPayrolls();
    return {
      asOf: asOf ? new Date(asOf) : new Date(),
      basis: 'LOCKED' as const,
      openPayrolls: open,
      note:
        open.length > 0
          ? `${open.length} payroll run(s) are still open; their recoveries appear under inFlight, not outstanding.`
          : undefined,
      // Omitted rather than empty: a `warnings: []` on every response trains
      // readers to stop looking at the field.
      ...(warnings && warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** Postgres UUID text form. Anything else must not reach a `::uuid` cast. */
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Guard the raw-SQL path's id parameters.
   *
   * `departmentId` / `loanTypeId` are spliced into `$queryRaw` as
   * `${id}::uuid`. Prisma parameterises the VALUE, so this was never an
   * injection hole — but an unparseable id reached Postgres, which raised
   * `invalid input syntax for type uuid`, and the driver's error surfaced to
   * the client as a database fault rather than a clean 400 naming the field.
   * There is no DTO and no `ParseUUIDPipe` in front of this query, so the
   * validation lives here, at the edge of the raw path itself. An empty string
   * (`?departmentId=`) is "no filter", exactly as before.
   */
  private assertUuid(value: string | undefined, field: string) {
    if (!value) return;
    if (!LoanReportsService.UUID_RE.test(value)) {
      throw new BadRequestException(`${field} must be a valid UUID`);
    }
  }

  private assertNotFuture(asOf?: string) {
    if (!asOf) return;
    const d = new Date(asOf);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('asOf must be a valid date');
    }
    if (d.getTime() > Date.now()) {
      throw new BadRequestException('asOf cannot be in the future');
    }
  }

  /**
   * Outstanding balance per employee.
   *
   * `asOf` is honoured from LEDGER EVENTS, never from the denormalised
   * `amountRepaid` — that column is a "now" value and would silently report
   * today's balance for a historical date.
   *
   * `totals` is the BOOK: the whole filtered set, independent of `page`/
   * `limit`. `pageTotals` is the page. The screen labels the headline figure
   * as the loan book's total, so the headline has to be the book.
   */
  async outstanding(query: {
    asOf?: string;
    departmentId?: string;
    loanTypeId?: string;
    type?: string;
    page?: number;
    limit?: number;
  }) {
    this.assertNotFuture(query.asOf);
    // Before anything reaches the `${id}::uuid` casts spliced in below.
    this.assertUuid(query.departmentId, 'departmentId');
    this.assertUuid(query.loanTypeId, 'loanTypeId');

    const take = Math.min(Math.max(1, query.limit ?? 50), 200);
    const skip = (Math.max(1, query.page ?? 1) - 1) * take;

    // An omitted `asOf` USED TO DROP the cycle filter altogether: the default
    // report counted repayments booked in cycles that have not happened yet,
    // while `meta.asOf` cheerfully reported today. "No date" now means exactly
    // "today", which is what `meta.asOf` has always claimed it meant, so the
    // undated report and `?asOf=<today>` are the same report.
    //
    // Granularity is deliberately the CYCLE key (`year * 12 + month`), not a
    // timestamp: a deduction belongs to a payroll cycle, not to an instant.
    // A mid-month `asOf` therefore includes this month's locked recoveries —
    // unchanged behaviour, now simply applied to the default too.
    const asOfDate = query.asOf ? new Date(query.asOf) : new Date();
    const asOfKey = LoanRecoveryService.cycleKey(
      asOfDate.getUTCMonth() + 1,
      asOfDate.getUTCFullYear(),
    );

    // `loan_type_id` is never written by ANY code path — the LoanType
    // catalogue is unwired end to end: no CRUD, no route, no create path sets
    // it, and `seedDefaultTypes()` is never called
    // (docs/LOAN-ADVANCES-GAP-REPORT.md §2). The filter STAYS, because wiring
    // the catalogue is the fix and deleting the filter would only have to be
    // undone. What changes is that it stops lying: "no loan carries a type at
    // all" and "no employee in that category owes anything" are different
    // facts and they used to look identical — an empty `data` array. The
    // probe is a single indexed-lookup findFirst, run only when the filter is
    // actually supplied, and it is branch-scoped like every other read.
    const warnings: string[] = [];
    if (query.loanTypeId) {
      const anyTagged = await this.prisma.advanceLoanRequest.findFirst({
        where: { loanTypeId: { not: null } },
        select: { id: true },
      });
      if (!anyTagged) {
        warnings.push(
          'loanTypeId was applied, but no loan in the book carries a loan type: ' +
            'this report is empty by construction, not because no balance ' +
            'exists. The LoanType catalogue is not wired to any create path ' +
            '(docs/LOAN-ADVANCES-GAP-REPORT.md §2).',
        );
      }
    }

    // The whole filtered book, grouped per employee. Held as ONE fragment so
    // the page query and the book-totals query cannot drift apart — they were
    // previously the same statement, which is precisely why the totals were
    // page-scoped.
    const grouped = Prisma.sql`
      SELECT e.id                        AS employee_id,
             e.employee_code             AS employee_code,
             e.full_name                 AS full_name,
             d.name                      AS department,
             COUNT(r.id)::int            AS loans,
             COALESCE(SUM(r.amount), 0)  AS principal,
             -- Repaid is recomputed from PAID ledger rows so asOf works.
             COALESCE(SUM((
               SELECT COALESCE(SUM(x.principal_component), 0)
                 FROM advance_loan_deductions x
                WHERE x.request_id = r.id
                  AND x.status = 'PAID'
                  AND (x.year * 12 + x.month) <= ${asOfKey}
             )), 0) AS repaid,
             COALESCE(SUM(r.written_off_amount), 0) AS written_off,
             COALESCE(SUM(r.waived_amount), 0)      AS waived,
             -- Sitting in an unlocked payroll: reported separately, never
             -- folded into outstanding.
             COALESCE(SUM((
               SELECT COALESCE(SUM(x.amount), 0)
                 FROM advance_loan_deductions x
                WHERE x.request_id = r.id AND x.status = 'PENDING'
             )), 0) AS in_flight
        FROM advance_loan_requests r
        JOIN employees e   ON e.id = r.employee_id
        LEFT JOIN departments d ON d.id = e.department_id
        -- This predicate was NOT IN (REJECTED, CANCELLED), which is the exact
        -- fault LOAN_DEBT_STATUSES own comment in loan.types.ts describes. It
        -- reported a DRAFT/PENDING request — nobody approved it, no money was
        -- disbursed — as outstanding debt, and it left a CLOSED /
        -- WRITTEN_OFF / SETTLED loan's unrepaid principal on the book forever.
        -- Selecting the positive set also fails safe: a status added to
        -- LOAN_STATUSES later is excluded until somebody decides it is debt,
        -- instead of being counted as debt by default.
       WHERE r.status IN (${Prisma.join(LOAN_DEBT_STATUSES)})
         ${query.departmentId ? Prisma.sql`AND e.department_id = ${query.departmentId}::uuid` : Prisma.empty}
         ${query.loanTypeId ? Prisma.sql`AND r.loan_type_id = ${query.loanTypeId}::uuid` : Prisma.empty}
         ${query.type ? Prisma.sql`AND r.type = ${query.type}` : Prisma.empty}
         ${rawBranchFilter('e')}
       GROUP BY e.id, e.employee_code, e.full_name, d.name
      HAVING COALESCE(SUM(r.amount), 0) > 0
    `;

    const rows = await this.prisma.$queryRaw<
      Array<{
        employee_id: string;
        employee_code: string;
        full_name: string;
        department: string | null;
        loans: number;
        principal: string;
        repaid: string;
        written_off: string;
        waived: string;
        in_flight: string;
      }>
    >`
      ${grouped}
       ORDER BY e.full_name
       LIMIT ${take} OFFSET ${skip}
    `;

    // The BOOK's totals: the same fragment with no LIMIT/OFFSET. The screen
    // labels this figure as the loan book's total, and past `limit` borrowers
    // it used to be page 1 and nothing else. `GREATEST(..., 0)` mirrors the
    // per-row `Math.max(0, ...)` clamp below, so the total is the sum of the
    // numbers a reader can actually see rather than a separately-derived one.
    const [book] = await this.prisma.$queryRaw<
      Array<{
        count: number;
        principal: string;
        outstanding: string;
        in_flight: string;
      }>
    >`
      SELECT COUNT(*)::int                 AS count,
             COALESCE(SUM(t.principal), 0) AS principal,
             COALESCE(SUM(GREATEST(
               t.principal - t.repaid - t.written_off - t.waived, 0
             )), 0)                        AS outstanding,
             COALESCE(SUM(t.in_flight), 0) AS in_flight
        FROM (${grouped}) t
    `;

    const data = rows.map((r) => {
      const outstanding = roundMoney(
        Number(r.principal) -
          Number(r.repaid) -
          Number(r.written_off) -
          Number(r.waived),
      );
      return {
        employeeId: r.employee_id,
        employeeCode: r.employee_code,
        employeeName: r.full_name,
        department: r.department,
        loans: r.loans,
        principal: roundMoney(Number(r.principal)),
        repaid: roundMoney(Number(r.repaid)),
        writtenOff: roundMoney(Number(r.written_off)),
        waived: roundMoney(Number(r.waived)),
        outstanding: Math.max(0, outstanding),
        inFlight: roundMoney(Number(r.in_flight)),
      };
    });

    return {
      success: true,
      data,
      // Book-wide and pagination-independent. THE headline figure. Same three
      // money keys as before plus `count` (borrowers in the whole filtered
      // book) — `count` rather than `employees` because the reports screen
      // currency-formats every numeric total EXCEPT a key called `count`, and
      // `emi-due`/`overdue` already use that name for the same idea.
      totals: {
        count: Number(book?.count ?? 0),
        principal: roundMoney(Number(book?.principal ?? 0)),
        outstanding: roundMoney(Number(book?.outstanding ?? 0)),
        inFlight: roundMoney(Number(book?.in_flight ?? 0)),
      },
      // The page's own subtotal, kept because a one-page CSV whose footer does
      // not foot to its own rows reads as an arithmetic error. Never the
      // headline: `totals` is.
      pageTotals: {
        count: data.length,
        principal: roundMoney(data.reduce((a, r) => a + r.principal, 0)),
        outstanding: roundMoney(data.reduce((a, r) => a + r.outstanding, 0)),
        inFlight: roundMoney(data.reduce((a, r) => a + r.inFlight, 0)),
      },
      meta: await this.meta(query.asOf, warnings),
    };
  }

  /**
   * Book composition by status and type. Middleware-scoped, so no raw SQL.
   *
   * This is the ONE report that deliberately does NOT narrow to
   * LOAN_DEBT_STATUSES. Its whole job is composition — how much of the book
   * sits in each status, terminal ones included — so hiding REJECTED, CLOSED
   * or WRITTEN_OFF rows would destroy the only view of what has LEFT the book.
   * It groups BY status, so a terminal row is labelled as terminal and cannot
   * be misread as debt.
   *
   * What IS corrected is the `outstanding` column. It was
   * `amount - amountRepaid` for every status, so a CLOSED or REJECTED group
   * published an owed balance, and a written-off or waived balance was
   * reported as still owed. A status outside LOAN_DEBT_STATUSES has no debt by
   * definition, so its `outstanding` is 0 — the money is still fully visible
   * in `principal`/`repaid`/`writtenOff`/`waived`, it just is not called debt.
   * `isDebt` is exposed so a caller can total the book without re-deriving the
   * status set client-side.
   */
  async portfolio() {
    const grouped = await this.prisma.advanceLoanRequest.groupBy({
      by: ['status', 'type'],
      _count: { _all: true },
      _sum: {
        amount: true,
        amountRepaid: true,
        writtenOffAmount: true,
        waivedAmount: true,
      },
    });

    const isDebtStatus = new Set<string>(LOAN_DEBT_STATUSES);

    const data = grouped.map((g) => {
      const principal = Number(g._sum.amount ?? 0);
      const repaid = Number(g._sum.amountRepaid ?? 0);
      const writtenOff = Number(g._sum.writtenOffAmount ?? 0);
      const waived = Number(g._sum.waivedAmount ?? 0);
      const isDebt = isDebtStatus.has(g.status);
      return {
        status: g.status,
        type: g.type,
        count: g._count._all,
        principal: roundMoney(principal),
        repaid: roundMoney(repaid),
        writtenOff: roundMoney(writtenOff),
        waived: roundMoney(waived),
        isDebt,
        outstanding: isDebt
          ? Math.max(0, roundMoney(principal - repaid - writtenOff - waived))
          : 0,
      };
    });

    return {
      success: true,
      data,
      // `principal` is the whole book across every status; `outstanding` is
      // only the debt-bearing part of it. They are different questions and
      // showing them side by side is what stops the first being read as the
      // second.
      totals: {
        count: data.reduce((a, r) => a + r.count, 0),
        principal: roundMoney(data.reduce((a, r) => a + r.principal, 0)),
        outstanding: roundMoney(data.reduce((a, r) => a + r.outstanding, 0)),
      },
      meta: await this.meta(),
    };
  }

  /**
   * What is scheduled to be recovered in a given cycle.
   *
   * `includeHeld` used to replace the entire request-status predicate with
   * `{}` — it did not widen the set from "not held" to "held as well", it
   * REMOVED the filter. A CLOSED / WRITTEN_OFF / SETTLED loan still carrying
   * an unpaid schedule row was then listed as due for recovery, and so was a
   * DRAFT or PENDING request nobody had approved. "Include the paused ones"
   * and "include the finished ones" are different questions and only the
   * first has a parameter.
   *
   * The flag now moves exactly ONE status — ON_HOLD — in and out of the set.
   * Everything else is LOAN_DEBT_STATUSES either way, so a terminal loan is
   * never due and an unapproved request is never due, whatever the flag says.
   */
  async emiDue(query: { month?: number; year?: number; includeHeld?: boolean }) {
    const now = new Date();
    const month = query.month ?? now.getUTCMonth() + 1;
    const year = query.year ?? now.getUTCFullYear();
    const cycleKey = LoanRecoveryService.cycleKey(month, year);

    // The ONLY thing includeHeld changes.
    const requestStatuses = query.includeHeld
      ? LOAN_DEBT_STATUSES
      : LOAN_DEBT_STATUSES.filter((st) => st !== 'ON_HOLD');

    const rows = await this.prisma.loanSchedule.findMany({
      where: {
        dueCycleKey: cycleKey,
        status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
        request: { status: { in: requestStatuses as any } },
      },
      select: {
        id: true,
        installmentNo: true,
        dueDate: true,
        emiAmount: true,
        principalComponent: true,
        interestComponent: true,
        paidAmount: true,
        status: true,
        request: {
          select: {
            id: true,
            type: true,
            referenceNo: true,
            status: true,
            employee: {
              select: { id: true, employeeCode: true, fullName: true },
            },
          },
        },
      },
      orderBy: { dueDate: 'asc' },
      take: 500,
    });

    return {
      success: true,
      data: rows.map((r) => ({
        scheduleId: r.id,
        loanId: r.request.id,
        referenceNo: r.request.referenceNo,
        type: r.request.type,
        employeeId: r.request.employee.id,
        employeeCode: r.request.employee.employeeCode,
        employeeName: r.request.employee.fullName,
        installmentNo: r.installmentNo,
        dueDate: r.dueDate,
        emiAmount: roundMoney(Number(r.emiAmount)),
        principal: roundMoney(Number(r.principalComponent)),
        interest: roundMoney(Number(r.interestComponent)),
        alreadyPaid: roundMoney(Number(r.paidAmount)),
        status: r.status,
      })),
      totals: {
        count: rows.length,
        due: roundMoney(
          rows.reduce(
            (a, r) => a + Number(r.emiAmount) - Number(r.paidAmount),
            0,
          ),
        ),
      },
      meta: { ...(await this.meta()), month, year },
    };
  }

  /** Instalments past their due date, bucketed by age. */
  async overdue(query: { asOf?: string }) {
    this.assertNotFuture(query.asOf);
    const asOf = query.asOf ? new Date(query.asOf) : new Date();

    const rows = await this.prisma.loanSchedule.findMany({
      where: {
        dueDate: { lt: asOf },
        status: { in: ['SCHEDULED', 'PARTIAL', 'DEFERRED'] },
        // Was `notIn LOAN_TERMINAL_STATUSES`, which admitted DRAFT and
        // PENDING: a request nobody approved could be aged into the 90+
        // arrears bucket. Positive selection on LOAN_DEBT_STATUSES instead.
        // ON_HOLD stays IN deliberately — a hold pauses COLLECTION, it does
        // not forgive the debt or stop the instalment ageing, and arrears is
        // exactly where that ageing has to remain visible. (`emi-due` is the
        // report about what payroll will take, and that one excludes holds
        // unless asked.)
        request: { status: { in: LOAN_DEBT_STATUSES as any } },
      },
      select: {
        id: true,
        installmentNo: true,
        dueDate: true,
        emiAmount: true,
        paidAmount: true,
        request: {
          select: {
            id: true,
            referenceNo: true,
            type: true,
            employee: { select: { id: true, employeeCode: true, fullName: true } },
          },
        },
      },
      orderBy: { dueDate: 'asc' },
      take: 500,
    });

    const bucketOf = (days: number) =>
      days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';

    const data = rows.map((r) => {
      const days = Math.floor(
        (asOf.getTime() - new Date(r.dueDate).getTime()) / 86400000,
      );
      return {
        scheduleId: r.id,
        loanId: r.request.id,
        referenceNo: r.request.referenceNo,
        employeeCode: r.request.employee.employeeCode,
        employeeName: r.request.employee.fullName,
        installmentNo: r.installmentNo,
        dueDate: r.dueDate,
        overdueDays: days,
        bucket: bucketOf(days),
        amountDue: roundMoney(Number(r.emiAmount) - Number(r.paidAmount)),
      };
    });

    const buckets: Record<string, { count: number; amount: number }> = {
      '1-30': { count: 0, amount: 0 },
      '31-60': { count: 0, amount: 0 },
      '61-90': { count: 0, amount: 0 },
      '90+': { count: 0, amount: 0 },
    };
    for (const d of data) {
      buckets[d.bucket].count += 1;
      buckets[d.bucket].amount = roundMoney(
        buckets[d.bucket].amount + d.amountDue,
      );
    }

    return {
      success: true,
      data,
      buckets,
      totals: {
        count: data.length,
        amount: roundMoney(data.reduce((a, d) => a + d.amountDue, 0)),
      },
      meta: await this.meta(query.asOf),
    };
  }

  /**
   * Interest actually collected in a period.
   *
   * Summed from PAID ledger rows, never recomputed from the schedule — a
   * reschedule rewrites future rows, and recomputing would silently restate
   * history that has already been reported.
   *
   * NO request-status predicate here, and that is correct rather than an
   * oversight of the same class as `outstanding`'s. This report is about money
   * that MOVED, not about money that is owed: interest collected in March was
   * collected in March whether the loan later closed, settled or was written
   * off. Filtering by today's status would restate reported income every time
   * a loan reached the end of its life. `x.status = 'PAID'` is the only
   * predicate that belongs, and a REJECTED or CANCELLED request cannot have
   * PAID ledger rows in the first place.
   */
  async interestEarned(query: { from?: string; to?: string }) {
    const from = query.from ? new Date(query.from) : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
    const to = query.to ? new Date(query.to) : new Date();
    const fromKey = LoanRecoveryService.cycleKey(
      from.getUTCMonth() + 1,
      from.getUTCFullYear(),
    );
    const toKey = LoanRecoveryService.cycleKey(
      to.getUTCMonth() + 1,
      to.getUTCFullYear(),
    );

    const rows = await this.prisma.$queryRaw<
      Array<{ year: number; month: number; interest: string; principal: string; fee: string }>
    >`
      SELECT x.year, x.month,
             COALESCE(SUM(x.interest_component), 0)  AS interest,
             COALESCE(SUM(x.principal_component), 0) AS principal,
             COALESCE(SUM(x.fee_component), 0)       AS fee
        FROM advance_loan_deductions x
        JOIN advance_loan_requests r ON r.id = x.request_id
        JOIN employees e             ON e.id = r.employee_id
       WHERE x.status = 'PAID'
         AND (x.year * 12 + x.month) BETWEEN ${fromKey} AND ${toKey}
         ${rawBranchFilter('e')}
       GROUP BY x.year, x.month
       ORDER BY x.year, x.month
    `;

    const data = rows.map((r) => ({
      year: r.year,
      month: r.month,
      interest: roundMoney(Number(r.interest)),
      principal: roundMoney(Number(r.principal)),
      fee: roundMoney(Number(r.fee)),
    }));

    return {
      success: true,
      data,
      totals: {
        interest: roundMoney(data.reduce((a, r) => a + r.interest, 0)),
        principal: roundMoney(data.reduce((a, r) => a + r.principal, 0)),
        fee: roundMoney(data.reduce((a, r) => a + r.fee, 0)),
      },
      meta: await this.meta(),
    };
  }

  /** Per-employee statement: every loan, its schedule and its money events. */
  async statement(employeeId: string) {
    // An account with no employee record is an ordinary shape — an HR or ADMIN
    // login that administers but is not itself staff. Without this guard
    // `employeeId` is `undefined`, Prisma throws, and "my statement" answers
    // with the server's own fault. Same root cause as the reimbursement and
    // travel create paths.
    if (!employeeId) {
      throw new BadRequestException(
        'Your account is not linked to an employee record, so it has no loan statement',
      );
    }

    const loans = await this.prisma.advanceLoanRequest.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        type: true,
        referenceNo: true,
        status: true,
        amount: true,
        amountRepaid: true,
        interestPaid: true,
        writtenOffAmount: true,
        waivedAmount: true,
        outstandingInterest: true,
        installments: true,
        installmentAmount: true,
        interestMethod: true,
        interestRate: true,
        createdAt: true,
        approvedAt: true,
        closedAt: true,
        closureType: true,
        scheduleVersion: true,
        schedules: {
          orderBy: { installmentNo: 'asc' },
          select: {
            version: true,
            installmentNo: true,
            dueDate: true,
            emiAmount: true,
            principalComponent: true,
            interestComponent: true,
            paidAmount: true,
            status: true,
            settledAt: true,
          },
        },
        transactions: {
          orderBy: { transactionDate: 'asc' },
          select: {
            type: true,
            transactionDate: true,
            amount: true,
            principalComponent: true,
            interestComponent: true,
            narration: true,
            status: true,
          },
        },
      },
    });

    const isDebtStatus = new Set<string>(LOAN_DEBT_STATUSES);

    return {
      success: true,
      data: loans.map((l) => ({
        ...l,
        amount: roundMoney(Number(l.amount)),
        amountRepaid: roundMoney(Number(l.amountRepaid)),
        // Every loan the employee has ever had stays LISTED: a statement is a
        // history document and hiding the rejected request or the closed loan
        // would make it unreconcilable against the borrower's own records.
        // But only a loan in LOAN_DEBT_STATUSES can carry a balance, so a
        // REJECTED / CANCELLED / CLOSED / WRITTEN_OFF / SETTLED / COMPLETED
        // loan reports 0 owed instead of "principal minus whatever happened to
        // be repaid" — which is what made a settled loan read as still owed on
        // the borrower's own statement.
        outstanding: isDebtStatus.has(l.status)
          ? Math.max(
              0,
              roundMoney(
                Number(l.amount) -
                  Number(l.amountRepaid) -
                  Number(l.writtenOffAmount) -
                  Number(l.waivedAmount),
              ),
            )
          : 0,
        // Only the LIVE schedule version; superseded rows are the regeneration
        // audit trail, not part of the statement.
        schedules: l.schedules.filter((s) => s.version === l.scheduleVersion),
      })),
      meta: await this.meta(),
    };
  }
}
