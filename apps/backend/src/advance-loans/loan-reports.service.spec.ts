import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LoanReportsService } from './loan-reports.service';
import { LOAN_DEBT_STATUSES, LOAN_STATUSES } from './loan.types';
import { LoanRecoveryService } from './loan-recovery.service';

/**
 * What each loan report COUNTS.
 *
 * None of this needs a database. The status predicates are ordinary Prisma
 * `where` objects, and the two raw queries are `Prisma.Sql` values whose text
 * and bound parameters can be read back verbatim — so a fake `$queryRaw` that
 * records what it was handed is a complete test of "which statuses does this
 * report treat as debt", "is the total the page or the book", and "what does an
 * omitted asOf bind".
 *
 * The rule under test throughout is the one LOAN_DEBT_STATUSES states in
 * loan.types.ts: a PENDING request and a CLOSED loan both have a principal
 * figure and neither of them is debt.
 */

type CapturedSql = { text: string; values: unknown[] };

const NON_DEBT = LOAN_STATUSES.filter(
  (s) => !LOAN_DEBT_STATUSES.includes(s),
);

/**
 * A Prisma double. `$queryRaw` is a tagged template, so it is re-composed with
 * `Prisma.sql` to recover exactly the SQL and parameters Postgres would see.
 */
function fakePrisma(over: Record<string, any> = {}) {
  const captured: CapturedSql[] = [];
  const prisma: any = {
    captured,
    payroll: { findMany: jest.fn().mockResolvedValue([]) },
    advanceLoanRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    loanSchedule: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      captured.push({ text: sql.text, values: sql.values });
      // The book-totals query is the one wrapping the grouped fragment in a
      // derived table; everything else is a row list.
      if (/FROM \(\s*\n?\s*SELECT/.test(sql.text) || sql.text.includes('GREATEST')) {
        return Promise.resolve([
          {
            count: 3,
            principal: '900.00',
            outstanding: '700.00',
            in_flight: '25.00',
          },
        ]);
      }
      return Promise.resolve([]);
    }),
    ...over,
  };
  return prisma;
}

/** The file's comments explain the OLD predicates, so assertions read the
 *  executable SQL only. */
const executable = (sql: CapturedSql) => sql.text.replace(/--[^\n]*/g, '');

const bookQuery = (p: any): CapturedSql =>
  p.captured.find((c: CapturedSql) => c.text.includes('GREATEST'))!;
const pageQuery = (p: any): CapturedSql =>
  p.captured.find((c: CapturedSql) => c.text.includes('LIMIT'))!;

describe('LoanReportsService', () => {
  // ── 6a: which statuses are debt ──────────────────────────────────────────
  describe('outstanding() counts only statuses where a balance can exist', () => {
    it('selects LOAN_DEBT_STATUSES positively instead of excluding two statuses', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).outstanding({});

      const page = pageQuery(prisma);
      // The old predicate, and the reason it was wrong: it let everything
      // through except two statuses.
      expect(executable(page)).not.toMatch(/NOT IN/);
      expect(executable(page)).toMatch(/r\.status IN \(/);
      for (const status of LOAN_DEBT_STATUSES) {
        expect(page.values).toContain(status);
      }
    });

    it('binds no non-debt status at all — a PENDING request is not owed money', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).outstanding({});

      for (const status of NON_DEBT) {
        expect(pageQuery(prisma).values).not.toContain(status);
      }
      // Specifically the two the bug report proved: an unapproved request and
      // a finished loan.
      expect(NON_DEBT).toEqual(
        expect.arrayContaining([
          'DRAFT',
          'PENDING',
          'CLOSED',
          'WRITTEN_OFF',
          'SETTLED',
        ]),
      );
    });

    it('still recomputes repaid from PAID ledger rows and still scopes by branch', async () => {
      // Both are load-bearing for reasons unrelated to this fix: the first is
      // what makes asOf a historical answer, the second is a data-leak guard.
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).outstanding({});
      const page = pageQuery(prisma);
      expect(page.text).toContain('advance_loan_deductions');
      expect(page.text).toMatch(/x\.status = 'PAID'/);
      expect(page.text).toMatch(/x\.status = 'PENDING'/); // inFlight, kept separate
      expect(page.text).toMatch(/FROM advance_loan_requests r/);
    });
  });

  // ── 6b: page totals vs book totals ───────────────────────────────────────
  describe('outstanding() totals cover the book, not the page', () => {
    it('runs a second, unpaginated aggregate and reports it as `totals`', async () => {
      const prisma = fakePrisma();
      const out = await new LoanReportsService(prisma).outstanding({ limit: 1 });

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      const book = bookQuery(prisma);
      expect(book).toBeDefined();
      expect(book.text).not.toMatch(/LIMIT/);
      expect(book.text).not.toMatch(/OFFSET/);

      // The page returned nothing; the book still totals the whole filtered
      // set. That divergence is the entire point of the fix.
      expect(out.data).toEqual([]);
      expect(out.totals).toEqual({
        count: 3,
        principal: 900,
        outstanding: 700,
        inFlight: 25,
      });
      expect(out.pageTotals).toEqual({
        count: 0,
        principal: 0,
        outstanding: 0,
        inFlight: 0,
      });
    });

    it('applies the same filters and branch scope to the totals as to the page', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).outstanding({
        departmentId: '11111111-1111-4111-8111-111111111111',
        type: 'LOAN',
        limit: 5,
      });
      const book = bookQuery(prisma);
      expect(book.text).toMatch(/AND e\.department_id = \$\d+::uuid/);
      expect(book.values).toContain('11111111-1111-4111-8111-111111111111');
      expect(book.values).toContain('LOAN');
      // A total built from a differently-filtered set would be worse than a
      // page-scoped one, so assert the debt predicate travels with it.
      for (const status of LOAN_DEBT_STATUSES) {
        expect(book.values).toContain(status);
      }
    });

    it('clamps each employee at zero the same way in SQL as the row mapper does in TS', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).outstanding({});
      expect(bookQuery(prisma).text).toMatch(/GREATEST\(/);
    });
  });

  // ── 6d: an omitted asOf means today ──────────────────────────────────────
  describe('outstanding() dates itself honestly', () => {
    const todayKey = () => {
      const now = new Date();
      return LoanRecoveryService.cycleKey(
        now.getUTCMonth() + 1,
        now.getUTCFullYear(),
      );
    };

    it('binds today cycle key when asOf is omitted, instead of dropping the filter', async () => {
      const prisma = fakePrisma();
      const out = await new LoanReportsService(prisma).outstanding({});

      const page = pageQuery(prisma);
      expect(page.text).toMatch(/x\.year \* 12 \+ x\.month\) <=/);
      expect(page.values).toContain(todayKey());
      // meta.asOf claimed today before the fix too — now the query agrees.
      expect(new Date(out.meta.asOf).getUTCMonth()).toBe(new Date().getUTCMonth());
    });

    it('gives the undated report exactly the same predicate as asOf=today', async () => {
      const a = fakePrisma();
      const b = fakePrisma();
      const now = new Date();
      const iso = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

      await new LoanReportsService(a).outstanding({});
      await new LoanReportsService(b).outstanding({ asOf: iso });

      expect(pageQuery(a).text).toBe(pageQuery(b).text);
      expect(pageQuery(a).values).toEqual(pageQuery(b).values);
    });

    it('keeps cycle-key granularity — a day-of-month never appears in the predicate', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).outstanding({ asOf: '2026-03-17' });
      expect(pageQuery(prisma).values).toContain(
        LoanRecoveryService.cycleKey(3, 2026),
      );
      expect(pageQuery(prisma).text).not.toMatch(/x\.due_date|::date/);
    });

    it('still refuses a future asOf and a malformed one', async () => {
      const svc = new LoanReportsService(fakePrisma());
      await expect(svc.outstanding({ asOf: '2999-01-01' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(svc.outstanding({ asOf: 'not-a-date' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  // ── 6e: a filter that cannot match says so ───────────────────────────────
  describe('outstanding() loanTypeId filter is honest about being unmatchable', () => {
    it('warns in meta when no loan in the book carries a loan type', async () => {
      const prisma = fakePrisma(); // findFirst -> null: nothing is tagged
      const out = await new LoanReportsService(prisma).outstanding({
        loanTypeId: '22222222-2222-4222-8222-222222222222',
      });

      expect(out.meta.warnings?.length).toBe(1);
      expect(out.meta.warnings![0]).toMatch(/empty by construction/);
      expect(out.meta.warnings![0]).toMatch(/GAP-REPORT/);
      // The filter itself is untouched — wiring the catalogue is the fix.
      expect(pageQuery(prisma).text).toContain('r.loan_type_id');
      expect(pageQuery(prisma).values).toContain(
        '22222222-2222-4222-8222-222222222222',
      );
    });

    it('says nothing once loan types are actually being recorded', async () => {
      const prisma = fakePrisma();
      prisma.advanceLoanRequest.findFirst.mockResolvedValue({ id: 'x' });
      const out = await new LoanReportsService(prisma).outstanding({
        loanTypeId: '22222222-2222-4222-8222-222222222222',
      });
      expect(out.meta.warnings).toBeUndefined();
    });

    it('does not probe, or warn, when the filter was not supplied', async () => {
      const prisma = fakePrisma();
      const out = await new LoanReportsService(prisma).outstanding({});
      expect(prisma.advanceLoanRequest.findFirst).not.toHaveBeenCalled();
      expect(out.meta.warnings).toBeUndefined();
    });
  });

  // ── 6f: ids validated before the ::uuid cast ─────────────────────────────
  describe('outstanding() guards the raw-SQL id parameters', () => {
    it('rejects a malformed departmentId with a 400 naming the field', async () => {
      const prisma = fakePrisma();
      const svc = new LoanReportsService(prisma);
      await expect(svc.outstanding({ departmentId: 'not-a-uuid' })).rejects.toThrow(
        /departmentId must be a valid UUID/,
      );
      // Nothing reached Postgres, so no driver error can surface as a 5xx.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('rejects a malformed loanTypeId too', async () => {
      const svc = new LoanReportsService(fakePrisma());
      await expect(svc.outstanding({ loanTypeId: '123' })).rejects.toThrow(
        /loanTypeId must be a valid UUID/,
      );
    });

    it('accepts a well-formed uuid in either case, and treats empty as no filter', async () => {
      const prisma = fakePrisma();
      await expect(
        new LoanReportsService(prisma).outstanding({
          departmentId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
        }),
      ).resolves.toBeDefined();

      // An empty string is "no filter", exactly as before the guard existed:
      // the LEFT JOIN still mentions the column, but no predicate is spliced.
      const bare = fakePrisma();
      await new LoanReportsService(bare).outstanding({ departmentId: '' });
      expect(pageQuery(bare).text).not.toMatch(/AND e\.department_id =/);
      expect(pageQuery(bare).text).toMatch(/AND e\.department_id =|LEFT JOIN departments/);
    });
  });

  // ── 6c: includeHeld widens the HOLD condition only ───────────────────────
  describe('emiDue() includeHeld', () => {
    const statusesUsed = (prisma: any) =>
      prisma.loanSchedule.findMany.mock.calls[0][0].where.request.status.in;

    it('excludes ON_HOLD by default and never admits a terminal or unapproved loan', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).emiDue({});
      const used = statusesUsed(prisma);
      expect(used).not.toContain('ON_HOLD');
      expect([...used].sort()).toEqual(
        LOAN_DEBT_STATUSES.filter((s) => s !== 'ON_HOLD').sort(),
      );
    });

    it('adds ON_HOLD and nothing else — the predicate is widened, not removed', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).emiDue({ includeHeld: true });
      const used = statusesUsed(prisma);
      expect(used).toContain('ON_HOLD');
      expect([...used].sort()).toEqual([...LOAN_DEBT_STATUSES].sort());
      for (const status of NON_DEBT) {
        expect(used).not.toContain(status);
      }
    });

    it('differs from the default by exactly one status', async () => {
      const off = fakePrisma();
      const on = fakePrisma();
      await new LoanReportsService(off).emiDue({ includeHeld: false });
      await new LoanReportsService(on).emiDue({ includeHeld: true });
      const added = statusesUsed(on).filter(
        (s: string) => !statusesUsed(off).includes(s),
      );
      expect(added).toEqual(['ON_HOLD']);
    });

    it('leaves the cycle and schedule-row predicates alone under either flag', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).emiDue({
        month: 3,
        year: 2026,
        includeHeld: true,
      });
      const where = prisma.loanSchedule.findMany.mock.calls[0][0].where;
      expect(where.dueCycleKey).toBe(LoanRecoveryService.cycleKey(3, 2026));
      expect(where.status.in).toEqual(['SCHEDULED', 'PARTIAL', 'DEFERRED']);
    });
  });

  // ── 6a, again: overdue ───────────────────────────────────────────────────
  describe('overdue() ages only real debt', () => {
    it('selects LOAN_DEBT_STATUSES rather than excluding the terminal ones', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).overdue({});
      const status = prisma.loanSchedule.findMany.mock.calls[0][0].where.request
        .status;
      expect(status.notIn).toBeUndefined();
      expect([...status.in].sort()).toEqual([...LOAN_DEBT_STATUSES].sort());
      // A request nobody approved can no longer age into the 90+ bucket.
      expect(status.in).not.toContain('PENDING');
      expect(status.in).not.toContain('DRAFT');
      // A hold pauses collection; it does not stop the debt ageing.
      expect(status.in).toContain('ON_HOLD');
    });
  });

  // ── 6a, again: portfolio keeps every status but calls only debt "debt" ───
  describe('portfolio() shows the whole book and owes only on debt statuses', () => {
    const group = (status: string, over: Record<string, any> = {}) => ({
      status,
      type: 'LOAN',
      _count: { _all: 1 },
      _sum: {
        amount: 1000,
        amountRepaid: 0,
        writtenOffAmount: 0,
        waivedAmount: 0,
        ...over,
      },
    });

    it('keeps terminal and unapproved rows visible — this report is composition', async () => {
      const prisma = fakePrisma();
      prisma.advanceLoanRequest.groupBy.mockResolvedValue(
        LOAN_STATUSES.map((s) => group(s)),
      );
      const out = await new LoanReportsService(prisma).portfolio();
      expect(out.data.map((r) => r.status).sort()).toEqual([...LOAN_STATUSES].sort());
      // No status predicate is passed at all.
      expect(prisma.advanceLoanRequest.groupBy.mock.calls[0][0].where).toBeUndefined();
    });

    it('reports zero outstanding for every non-debt status, principal intact', async () => {
      const prisma = fakePrisma();
      prisma.advanceLoanRequest.groupBy.mockResolvedValue(
        LOAN_STATUSES.map((s) => group(s)),
      );
      const out = await new LoanReportsService(prisma).portfolio();
      for (const row of out.data) {
        if (LOAN_DEBT_STATUSES.includes(row.status as any)) {
          expect(row.isDebt).toBe(true);
          expect(row.outstanding).toBe(1000);
        } else {
          expect(row.isDebt).toBe(false);
          expect(row.outstanding).toBe(0);
          expect(row.principal).toBe(1000); // still on the report, just not owed
        }
      }
      expect(out.totals.principal).toBe(1000 * LOAN_STATUSES.length);
      expect(out.totals.outstanding).toBe(1000 * LOAN_DEBT_STATUSES.length);
    });

    it('subtracts write-offs and waivers, which it previously ignored', async () => {
      const prisma = fakePrisma();
      prisma.advanceLoanRequest.groupBy.mockResolvedValue([
        group('ACTIVE', {
          amountRepaid: 100,
          writtenOffAmount: 200,
          waivedAmount: 50,
        }),
      ]);
      const out = await new LoanReportsService(prisma).portfolio();
      expect(out.data[0]).toMatchObject({
        principal: 1000,
        repaid: 100,
        writtenOff: 200,
        waived: 50,
        outstanding: 650,
      });
    });

    it('never reports a negative balance', async () => {
      const prisma = fakePrisma();
      prisma.advanceLoanRequest.groupBy.mockResolvedValue([
        group('ACTIVE', { amountRepaid: 5000 }),
      ]);
      const out = await new LoanReportsService(prisma).portfolio();
      expect(out.data[0].outstanding).toBe(0);
    });
  });

  // ── 6a, again: the borrower's own statement ──────────────────────────────
  describe('statement() lists every loan but owes only on debt statuses', () => {
    const loan = (status: string) => ({
      id: `loan-${status}`,
      status,
      amount: 1000,
      amountRepaid: 0,
      writtenOffAmount: 0,
      waivedAmount: 0,
      scheduleVersion: 1,
      schedules: [],
      transactions: [],
    });

    it('shows a rejected or settled loan with zero owed, without hiding it', async () => {
      const prisma = fakePrisma();
      prisma.advanceLoanRequest.findMany.mockResolvedValue(
        LOAN_STATUSES.map(loan),
      );
      const out = await new LoanReportsService(prisma).statement('emp-1');

      expect(out.data.length).toBe(LOAN_STATUSES.length); // history is intact
      for (const row of out.data as any[]) {
        expect(row.outstanding).toBe(
          LOAN_DEBT_STATUSES.includes(row.status) ? 1000 : 0,
        );
        expect(row.amount).toBe(1000); // the principal is still shown
      }
    });

    it('still refuses an account with no employee record', async () => {
      await expect(
        new LoanReportsService(fakePrisma()).statement(undefined as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── interestEarned: NOT a defect, pinned so it stays that way ────────────
  describe('interestEarned() is money that moved, not money that is owed', () => {
    it('filters on PAID ledger rows only, with no request-status predicate', async () => {
      const prisma = fakePrisma();
      await new LoanReportsService(prisma).interestEarned({});
      const sql = prisma.captured[0];
      expect(sql.text).toMatch(/x\.status = 'PAID'/);
      // Deliberate: filtering by today's loan status would restate already
      // reported income the day a loan closes.
      expect(sql.text).not.toMatch(/r\.status/);
    });
  });

  // ── the design the specs assert, preserved across all of the above ───────
  describe('the meta contract survives every change', () => {
    it('carries basis LOCKED and openPayrolls on every report', async () => {
      const prisma = fakePrisma();
      prisma.payroll.findMany.mockResolvedValue([
        { id: 'p1', month: 8, year: 2026, status: 'DRAFT' },
      ]);
      const svc = new LoanReportsService(prisma);
      for (const envelope of [
        await svc.outstanding({}),
        await svc.portfolio(),
        await svc.emiDue({}),
        await svc.overdue({}),
        await svc.interestEarned({}),
        await svc.statement('emp-1'),
      ]) {
        expect(envelope.meta.basis).toBe('LOCKED');
        expect(envelope.meta.openPayrolls).toHaveLength(1);
        expect(envelope.meta.note).toMatch(/still open/);
      }
    });

    it('keeps in-flight PENDING deductions out of outstanding entirely', async () => {
      const prisma = fakePrisma();
      const out = await new LoanReportsService(prisma).outstanding({});
      // Two separate columns, summed by two separate SQL expressions.
      expect(out.totals.inFlight).toBe(25);
      expect(out.totals.outstanding).toBe(700);
      expect(pageQuery(prisma).text).toMatch(/AS in_flight/);
    });
  });
});
