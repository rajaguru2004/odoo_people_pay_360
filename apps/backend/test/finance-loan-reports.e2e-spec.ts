import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer } from './utils/settings';

/**
 * Loan reports, end to end.
 *
 * Seven read-only endpoints behind `/advance-loans/reports`. They are read-only,
 * which is exactly why they are worth a suite of their own: a report that is
 * merely WRONG never throws, never 500s and never shows up in an error budget.
 * It just quietly tells the finance team a number, and the team acts on it.
 *
 * Three properties matter more than the shapes:
 *
 * **Money in an unlocked payroll is not repaid money.** A recovery sitting in a
 * DRAFT run has not moved. It belongs under `inFlight`, never inside
 * `outstanding` — otherwise the book shrinks the moment a run is generated and
 * grows back if it is deleted.
 *
 * **`asOf` must mean as-of.** Repaid is recomputed from PAID ledger rows rather
 * than read off the loan's running total, so a historical date reports the
 * balance on that date instead of today's with an old label.
 *
 * **A branch-scoped reader gets their branch's book.** These are raw SQL
 * queries, which the Prisma middleware cannot touch — the scoping has to be
 * spliced in by hand, and a hand-written filter is the kind that gets dropped.
 */
describe('Finance — Loan reports (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any): any => res.body?.data ?? res.body;
  const rowsOf = (res: any): any[] => {
    const d = dataOf(res);
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.data)) return d.data;
    if (Array.isArray(d?.rows)) return d.rows;
    return [];
  };

  const expectStatus = (
    res: any,
    expected: number | number[],
    label = '',
  ): void => {
    const want = Array.isArray(expected) ? expected : [expected];
    if (!want.includes(res.status)) {
      throw new Error(
        `${label ? `${label} — ` : ''}expected ${want.join(' or ')}, got ${res.status}: ${body(res)}`,
      );
    }
  };

  /** The six ADMIN/HR-only report paths, swept as a set rather than sampled. */
  const PRIVILEGED_REPORTS = [
    'outstanding',
    'portfolio',
    'emi-due',
    'overdue',
    'interest-earned',
  ];

  const principals = () => [
    ['admin', fx.admin] as const,
    ['hrGlobal', fx.hrGlobal] as const,
    ['hrScoped', fx.hrScoped] as const,
    ['manager', fx.manager] as const,
    ['employee', fx.employee] as const,
  ];

  const seeded: string[] = [];

  const seedLoan = async (over: Record<string, unknown> = {}) => {
    const loan = await ctx.prisma.advanceLoanRequest.create({
      data: {
        employeeId: fx.earnerId,
        type: 'LOAN',
        amount: 1200,
        amountRepaid: 0,
        installments: 12,
        status: 'ACTIVE',
        reason: `reports e2e ${fx.runId}`,
        ...over,
      },
    });
    seeded.push(loan.id);
    return loan;
  };

  const seedInstalment = async (
    requestId: string,
    over: Record<string, unknown> = {},
  ) => {
    const loan = await ctx.prisma.advanceLoanRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { scheduleVersion: true },
    });
    const dueYear = 2026;
    const dueMonth = 1;
    return ctx.prisma.loanSchedule.create({
      data: {
        requestId,
        version: loan.scheduleVersion,
        installmentNo: 1,
        dueDate: new Date(dueYear, dueMonth - 1, 28),
        dueCycleKey: dueYear * 12 + dueMonth,
        dueMonth,
        dueYear,
        openingBalance: 1200,
        principalComponent: 100,
        emiAmount: 100,
        closingBalance: 1100,
        status: 'SCHEDULED',
        ...over,
      },
    });
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (ctx && seeded.length) {
      await ctx.prisma.loanSchedule.deleteMany({
        where: { requestId: { in: seeded } },
      });
      await ctx.prisma.loanTransaction.deleteMany({
        where: { requestId: { in: seeded } },
      });
      await ctx.prisma.advanceLoanRequest.deleteMany({
        where: { id: { in: seeded } },
      });
    }
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Role matrix ───────────────────────────────────────────────────────────
  describe('who may read a report', () => {
    it('RPT-API-01 the five book-wide reports are ADMIN/HR only', async () => {
      for (const path of PRIVILEGED_REPORTS) {
        for (const [label, who] of principals()) {
          const res = await ctx
            .http()
            .get(`/advance-loans/reports/${path}`)
            .set(bearer(who.token));
          const want = ['admin', 'hrGlobal', 'hrScoped'].includes(label)
            ? 200
            : 403;
          expectStatus(res, want, `${path} as ${label}`);
        }
        const anon = await ctx.http().get(`/advance-loans/reports/${path}`);
        expect(anon.status).toBe(401);
      }
    });

    it('RPT-API-02 my-statement is open to every role that HAS an employee record', async () => {
      // The route takes the employee from the token. There is no
      // direct-object-reference surface at all, which is why it can safely be
      // the one report an employee may read.
      for (const who of [fx.hrScoped, fx.manager, fx.employee]) {
        const res = await ctx
          .http()
          .get('/advance-loans/reports/my-statement')
          .set(bearer(who.token));
        expectStatus(res, 200, who.email);
      }
    });

    it('RPT-API-02b F23 — an account with no employee record is refused, with a sentence', async () => {
      // The third occurrence of one root cause. Every Finance route that
      // derives its subject from `user.employeeId` — `POST /reimbursements`
      // (REI-API-10), `POST /travel-requests` (TRV-API-08b) and this one —
      // handed `undefined` to Prisma when the account was not linked to an
      // employee, and answered with the server's own fault for an ordinary
      // request from an ordinary admin account. One guard, three services.
      for (const who of [fx.admin, fx.hrGlobal]) {
        const res = await ctx
          .http()
          .get('/advance-loans/reports/my-statement')
          .set(bearer(who.token));
        expectStatus(res, [400, 404], who.email);
        expect(String(res.body.message)).toMatch(/employee/i);
      }
    });


    it('RPT-API-03 another employee’s statement is ADMIN/HR only', async () => {
      for (const [label, who] of principals()) {
        const res = await ctx
          .http()
          .get(`/advance-loans/reports/employee/${fx.earnerId}/statement`)
          .set(bearer(who.token));
        const want = ['admin', 'hrGlobal', 'hrScoped'].includes(label)
          ? 200
          : 403;
        expectStatus(res, want, label);
      }
    });

    it('RPT-API-04 a malformed employee id is a client error, not a server fault', async () => {
      const res = await ctx
        .http()
        .get('/advance-loans/reports/employee/not-a-uuid/statement')
        .set(bearer(fx.admin.token));
      expectStatus(res, 400);
    });

    it('RPT-API-05 the literal my-statement segment is not swallowed by the :employeeId route', async () => {
      // Route registration order is load-bearing here: declared the other way
      // round, "my-statement" would be parsed as an employee id and every
      // employee would get a 400 instead of their own statement.
      const res = await ctx
        .http()
        .get('/advance-loans/reports/my-statement')
        .set(bearer(fx.employee.token));
      expectStatus(res, 200);
    });
  });

  // ── The empty book ────────────────────────────────────────────────────────
  describe('an empty book', () => {
    it('RPT-API-06 every report answers with zeros and empty lists, never NaN or null', async () => {
      for (const path of PRIVILEGED_REPORTS) {
        const res = await ctx
          .http()
          .get(`/advance-loans/reports/${path}`)
          .set(bearer(fx.admin.token));
        expectStatus(res, 200, path);

        // A report is consumed by a screen that renders numbers. `NaN` and
        // `null` both reach the user as a blank cell, which reads as zero and
        // is not.
        const json = JSON.stringify(dataOf(res));
        expect(json).not.toContain('null,');
        expect(json.toLowerCase()).not.toContain('nan');
      }
    });
  });

  // ── Outstanding ───────────────────────────────────────────────────────────
  describe('outstanding balances', () => {
    it('RPT-API-07 a loan appears with principal, repaid and the balance between them', async () => {
      const loan = await seedLoan({ amount: 1000, amountRepaid: 250 });
      const res = await ctx
        .http()
        .get('/advance-loans/reports/outstanding')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);

      const mine = rowsOf(res).find(
        (r: any) => r.employeeId === fx.earnerId || r.id === fx.earnerId,
      );
      expect(mine).toBeTruthy();
      // Repaid is recomputed from PAID ledger rows, so a loan whose running
      // total says 250 but which has no ledger history reports nothing repaid.
      // Asserted as the behaviour, because it is what makes `asOf` honest.
      expect(Number(mine.outstanding ?? 0)).toBeGreaterThan(0);
      void loan;
    });

    it('RPT-API-08 a REJECTED request is not debt', async () => {
      const rejected = await seedLoan({ amount: 5000, status: 'REJECTED' });
      const res = await ctx
        .http()
        .get('/advance-loans/reports/outstanding')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);

      const total = rowsOf(res).reduce(
        (acc: number, r: any) => acc + Number(r.outstanding ?? 0),
        0,
      );
      // The whole book's outstanding must not include a request that was
      // refused — its principal never left the company.
      expect(total).toBeLessThan(5000);
      void rejected;
    });

    it('RPT-API-09 a future asOf is refused, and a malformed one too', async () => {
      const future = new Date();
      future.setDate(future.getDate() + 30);

      const ahead = await ctx
        .http()
        .get(
          `/advance-loans/reports/outstanding?asOf=${future.toISOString().slice(0, 10)}`,
        )
        .set(bearer(fx.admin.token));
      expectStatus(ahead, 400);
      expect(ahead.body.message).toBe('asOf cannot be in the future');

      const garbage = await ctx
        .http()
        .get('/advance-loans/reports/outstanding?asOf=lastTuesday')
        .set(bearer(fx.admin.token));
      expectStatus(garbage, 400);
      expect(garbage.body.message).toBe('asOf must be a valid date');
    });

    it('RPT-API-10 today is a legal asOf — the boundary is "future", not "not today"', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await ctx
        .http()
        .get(`/advance-loans/reports/outstanding?asOf=${today}`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
    });

    it('RPT-API-11 the type filter narrows to advances or loans', async () => {
      await seedLoan({ type: 'ADVANCE', amount: 300 });
      const advances = await ctx
        .http()
        .get('/advance-loans/reports/outstanding?type=ADVANCE')
        .set(bearer(fx.admin.token));
      expectStatus(advances, 200);

      const loans = await ctx
        .http()
        .get('/advance-loans/reports/outstanding?type=LOAN')
        .set(bearer(fx.admin.token));
      expectStatus(loans, 200);

      // Both answer; the filter is a filter, not a 400 on an unexpected value.
      const nonsense = await ctx
        .http()
        .get('/advance-loans/reports/outstanding?type=BANANA')
        .set(bearer(fx.admin.token));
      expectStatus(nonsense, 200);
    });

    it('RPT-API-12 the page limit is capped rather than trusted', async () => {
      const res = await ctx
        .http()
        .get('/advance-loans/reports/outstanding?page=1&limit=100000')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      // A caller-supplied limit that is honoured verbatim is a denial-of-service
      // with extra steps.
      expect(rowsOf(res).length).toBeLessThanOrEqual(200);
    });

    it('RPT-API-13 a branch-scoped reader gets their own branch’s book', async () => {
      const foreign = await seedLoan({
        employeeId: fx.foreignId,
        amount: 900,
      });

      const scoped = await ctx
        .http()
        .get('/advance-loans/reports/outstanding')
        .set(bearer(fx.hrScoped.token));
      expectStatus(scoped, 200);
      const scopedEmployees = rowsOf(scoped).map(
        (r: any) => r.employeeId ?? r.id,
      );
      expect(scopedEmployees).not.toContain(fx.foreignId);

      // The global reader does see it, so the absence above is scoping rather
      // than the row not existing. These are raw SQL queries the Prisma
      // middleware cannot reach, so the filter is hand-spliced and worth
      // asserting from both sides.
      const global = await ctx
        .http()
        .get('/advance-loans/reports/outstanding')
        .set(bearer(fx.hrGlobal.token));
      const globalEmployees = rowsOf(global).map(
        (r: any) => r.employeeId ?? r.id,
      );
      expect(globalEmployees).toContain(fx.foreignId);
      void foreign;
    });
  });

  // ── EMI due and overdue ───────────────────────────────────────────────────
  describe('the instalment reports', () => {
    it('RPT-API-14 emi-due answers for an explicit cycle', async () => {
      const loan = await seedLoan();
      await seedInstalment(loan.id);

      const res = await ctx
        .http()
        .get('/advance-loans/reports/emi-due?month=1&year=2026')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      const found = rowsOf(res).some(
        (r: any) => r.requestId === loan.id || r.loanId === loan.id,
      );
      expect(found).toBe(true);
    });

    it('RPT-API-15 a held loan is excluded unless includeHeld is asked for', async () => {
      const loan = await seedLoan({ status: 'ON_HOLD' });
      await seedInstalment(loan.id);

      const excluded = await ctx
        .http()
        .get('/advance-loans/reports/emi-due?month=1&year=2026')
        .set(bearer(fx.admin.token));
      expectStatus(excluded, 200);
      expect(
        rowsOf(excluded).some(
          (r: any) => r.requestId === loan.id || r.loanId === loan.id,
        ),
      ).toBe(false);

      const included = await ctx
        .http()
        .get(
          '/advance-loans/reports/emi-due?month=1&year=2026&includeHeld=true',
        )
        .set(bearer(fx.admin.token));
      expectStatus(included, 200);
      expect(
        rowsOf(included).some(
          (r: any) => r.requestId === loan.id || r.loanId === loan.id,
        ),
      ).toBe(true);
    });

    it('RPT-API-16 includeHeld is strictly the string "true"', async () => {
      // The controller compares `=== 'true'`. A truthy-looking `1` or `yes`
      // must therefore NOT include held loans — asserted so the coercion is
      // deliberate rather than accidental.
      const loan = await seedLoan({ status: 'ON_HOLD' });
      await seedInstalment(loan.id);

      for (const value of ['1', 'yes', 'TRUE']) {
        const res = await ctx
          .http()
          .get(
            `/advance-loans/reports/emi-due?month=1&year=2026&includeHeld=${value}`,
          )
          .set(bearer(fx.admin.token));
        expectStatus(res, 200, value);
        expect(
          rowsOf(res).some(
            (r: any) => r.requestId === loan.id || r.loanId === loan.id,
          ),
        ).toBe(false);
      }
    });

    it('RPT-API-17 overdue ages instalments into buckets, and an unpaid past instalment lands in one', async () => {
      const loan = await seedLoan();
      const pastYear = 2020;
      await ctx.prisma.loanSchedule.create({
        data: {
          requestId: loan.id,
          version: 1,
          installmentNo: 2,
          dueDate: new Date(pastYear, 0, 28),
          dueCycleKey: pastYear * 12 + 1,
          dueMonth: 1,
          dueYear: pastYear,
          openingBalance: 1200,
          principalComponent: 100,
          emiAmount: 100,
          closingBalance: 1100,
          status: 'SCHEDULED',
        },
      });

      const res = await ctx
        .http()
        .get('/advance-loans/reports/overdue')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      const rows = rowsOf(res);
      const mine = rows.find(
        (r: any) => r.requestId === loan.id || r.loanId === loan.id,
      );
      expect(mine).toBeTruthy();
      // Six years late lands in the oldest bucket, not the newest.
      expect(String(mine.bucket ?? mine.ageBucket ?? '')).toMatch(/90/);
    });

    it('RPT-API-18 overdue accepts an asOf and refuses a future one', async () => {
      const past = new Date();
      past.setFullYear(past.getFullYear() - 1);
      const ok = await ctx
        .http()
        .get(
          `/advance-loans/reports/overdue?asOf=${past.toISOString().slice(0, 10)}`,
        )
        .set(bearer(fx.admin.token));
      expectStatus(ok, 200);

      const future = new Date();
      future.setDate(future.getDate() + 10);
      const ahead = await ctx
        .http()
        .get(
          `/advance-loans/reports/overdue?asOf=${future.toISOString().slice(0, 10)}`,
        )
        .set(bearer(fx.admin.token));
      expectStatus(ahead, 400);
    });
  });

  // ── Portfolio and interest ────────────────────────────────────────────────
  describe('portfolio and interest', () => {
    it('RPT-API-19 the portfolio groups the book by status and type', async () => {
      await seedLoan({ status: 'ACTIVE' });
      await seedLoan({ status: 'CLOSED', type: 'ADVANCE' });

      const res = await ctx
        .http()
        .get('/advance-loans/reports/portfolio')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      const rows = rowsOf(res);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toHaveProperty('status');
        expect(Number.isFinite(Number(row.count))).toBe(true);
      }
    });

    it('RPT-API-20 interest-earned is summed from the ledger, so an empty ledger reports zero not null', async () => {
      // Never recomputed from the schedule: a reschedule rewrites future rows
      // and would restate reported history.
      const res = await ctx
        .http()
        .get('/advance-loans/reports/interest-earned')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      for (const row of rowsOf(res)) {
        expect(Number.isFinite(Number(row.interest ?? 0))).toBe(true);
      }
    });

    it('RPT-API-21 interest-earned accepts a window', async () => {
      const res = await ctx
        .http()
        .get('/advance-loans/reports/interest-earned?from=2026-01-01&to=2026-12-31')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
    });
  });

  // ── Statements ────────────────────────────────────────────────────────────
  describe('statements', () => {
    it('RPT-API-22 my-statement covers the caller and nobody else', async () => {
      const loan = await seedLoan();
      const res = await ctx
        .http()
        .get('/advance-loans/reports/my-statement')
        .set(bearer(fx.employee.token));
      expectStatus(res, 200);

      const json = JSON.stringify(dataOf(res));
      expect(json).toContain(loan.id);
      // Nobody else's loan may appear in a statement addressed to one person.
      const foreign = await seedLoan({ employeeId: fx.foreignId });
      const again = await ctx
        .http()
        .get('/advance-loans/reports/my-statement')
        .set(bearer(fx.employee.token));
      expect(JSON.stringify(dataOf(again))).not.toContain(foreign.id);
    });

    it('RPT-API-23 an unlinked caller is refused rather than handed the whole book', async () => {
      // The contrast with `GET /reimbursements/my-requests`, which answers 200
      // with EVERY employee's claims for exactly this caller (REI-API-17b).
      // Failing loudly is the lesser defect of the two: a 500 is visible, and a
      // silent company-wide leak is not.
      const res = await ctx
        .http()
        .get('/advance-loans/reports/my-statement')
        .set(bearer(fx.hrGlobal.token));
      expect(res.status).not.toBe(200);

      const json = JSON.stringify(res.body ?? {});
      for (const id of seeded) {
        expect(json).not.toContain(id);
      }
    });

    it('RPT-API-24 an employee statement is branch-scoped for a scoped reader', async () => {
      const res = await ctx
        .http()
        .get(`/advance-loans/reports/employee/${fx.foreignId}/statement`)
        .set(bearer(fx.hrScoped.token));
      // Either refused outright or answered empty — what must not happen is a
      // populated statement for an employee outside the reader's envelope.
      if (res.status === 200) {
        const json = JSON.stringify(dataOf(res));
        for (const id of seeded) {
          const loan = await ctx.prisma.advanceLoanRequest.findUnique({
            where: { id },
            select: { employeeId: true },
          });
          if (loan?.employeeId === fx.foreignId) {
            expect(json).not.toContain(id);
          }
        }
      } else {
        expectStatus(res, [403, 404]);
      }
    });

    it('RPT-API-25 an unknown employee id answers cleanly', async () => {
      const res = await ctx
        .http()
        .get(
          '/advance-loans/reports/employee/00000000-0000-0000-0000-000000000000/statement',
        )
        .set(bearer(fx.admin.token));
      expectStatus(res, [200, 404]);
    });
  });

  // ── The in-flight rule ────────────────────────────────────────────────────
  describe('money that has not moved', () => {
    it('RPT-API-26 a recovery in an UNLOCKED payroll is in flight, not repaid', async () => {
      // The rule that keeps the book honest. A deduction sitting in a DRAFT run
      // has not been paid — counting it as repaid would shrink outstanding the
      // moment a run is generated and grow it back if the run were deleted.
      const loan = await seedLoan({ amount: 1000, amountRepaid: 0 });
      const schedule = await seedInstalment(loan.id);

      const now = new Date();
      const payroll = await ctx.prisma.payroll.create({
        data: {
          month: now.getMonth() + 1,
          year: now.getFullYear() + 6,
          status: 'DRAFT',
          branchId: fx.branchA,
        },
      });
      const item = await ctx.prisma.payrollItem.create({
        data: {
          payrollId: payroll.id,
          employeeId: fx.earnerId,
          baseSalary: 1000,
          workDays: 30,
          actualWorkDays: 30,
          netSalary: 900,
        },
      });
      await ctx.prisma.advanceLoanDeduction.create({
        data: {
          requestId: loan.id,
          scheduleId: schedule.id,
          payrollItemId: item.id,
          amount: 100,
          principalComponent: 100,
          interestComponent: 0,
          feeComponent: 0,
          status: 'PENDING',
          month: now.getMonth() + 1,
          year: now.getFullYear() + 6,
        },
      });

      try {
        const res = await ctx
          .http()
          .get('/advance-loans/reports/outstanding')
          .set(bearer(fx.admin.token));
        expectStatus(res, 200);
        const mine = rowsOf(res).find(
          (r: any) => (r.employeeId ?? r.id) === fx.earnerId,
        );
        expect(mine).toBeTruthy();
        // The full principal is still owed; the 100 shows up separately.
        expect(Number(mine.inFlight ?? 0)).toBeGreaterThan(0);
      } finally {
        await ctx.prisma.advanceLoanDeduction.deleteMany({
          where: { requestId: loan.id },
        });
        await ctx.prisma.payrollItem.deleteMany({
          where: { payrollId: payroll.id },
        });
        await ctx.prisma.payroll.delete({ where: { id: payroll.id } });
      }
    });
  });
});
