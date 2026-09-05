import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer, withSetting, withSettings } from './utils/settings';

/**
 * Repricing a loan, and replacing one.
 *
 * Two whole features that existed as schema and enum members with no code:
 *
 *   §6  `LoanRateChange` — a complete model with ZERO references anywhere, and
 *       `regenerate()` accepting `newInterestRate`/`newInterestMethod` that
 *       nothing ever passed. No floating rate, no mid-loan repricing, no way to
 *       correct a mistyped rate.
 *   §8  Top-up — `LoanTransactionType.TOPUP_SETTLEMENT`,
 *       `LoanClosureType.TOPPED_UP`, `approvalSource = 'TOPUP'` and both
 *       `loan_topup_*` settings, all unreachable. A borrower who needed more
 *       ran two loans out of one salary.
 */
describe('Finance — rate changes and top-ups (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any): any => res.body?.data ?? res.body;

  const expectStatus = (res: any, expected: number | number[], label = '') => {
    const want = Array.isArray(expected) ? expected : [expected];
    if (!want.includes(res.status)) {
      throw new Error(
        `${label ? `${label} — ` : ''}expected ${want.join(' or ')}, got ${res.status}: ${body(res)}`,
      );
    }
  };

  /** A live, interest-bearing loan with a real schedule. */
  const seedLoan = async (over: Record<string, any> = {}) => {
    const loan = await ctx.prisma.advanceLoanRequest.create({
      data: {
        employeeId: fx.earnerId,
        type: 'LOAN',
        amount: 1200,
        installments: 6,
        installmentAmount: 200,
        status: 'ACTIVE',
        interestMethod: 'FLAT',
        interestRate: 6,
        scheduleVersion: 1,
        outstandingPrincipal: 1200,
        referenceNo: `RT-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
        ...over,
      },
    });
    const now = new Date();
    await ctx.prisma.loanSchedule.createMany({
      data: Array.from({ length: 6 }, (_, i) => {
        const due = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 28),
        );
        return {
          requestId: loan.id,
          version: 1,
          installmentNo: i + 1,
          dueDate: due,
          dueCycleKey: due.getUTCFullYear() * 12 + due.getUTCMonth() + 1,
          dueMonth: due.getUTCMonth() + 1,
          dueYear: due.getUTCFullYear(),
          openingBalance: 1200 - i * 200,
          principalComponent: 200,
          interestComponent: 6,
          emiAmount: 206,
          closingBalance: 1000 - i * 200,
          status: 'SCHEDULED' as const,
        };
      }),
    });
    return loan;
  };

  const clearLoans = async () => {
    const ids = (
      await ctx.prisma.advanceLoanRequest.findMany({
        where: { employeeId: fx.earnerId },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (!ids.length) return;
    const where = { requestId: { in: ids } };
    await ctx.prisma.advanceLoanNotificationLog.deleteMany({ where });
    await ctx.prisma.loanTransaction.deleteMany({ where });
    await ctx.prisma.loanRateChange.deleteMany({ where });
    await ctx.prisma.advanceLoanDeduction.deleteMany({ where });
    await ctx.prisma.loanSchedule.deleteMany({ where });
    await ctx.prisma.advanceLoanRequest.updateMany({
      where: { id: { in: ids } },
      data: { topupOfId: null, convertedFromId: null },
    });
    await ctx.prisma.advanceLoanRequest.deleteMany({ where: { id: { in: ids } } });
  };

  const INTEREST_ON = { loan_interest_enabled: 'true' };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  });

  afterEach(clearLoans);

  afterAll(async () => {
    await clearLoans();
    await fx.cleanup();
    await ctx.app.close();
  });

  // ── Rate change ───────────────────────────────────────────────────────────

  describe('changing the rate on a running loan', () => {
    const change = (id: string, payload: Record<string, unknown>, token = fx.hrGlobal.token) =>
      ctx.http().post(`/advance-loans/${id}/rate-change`).set(bearer(token)).send(payload);

    it('records the change with both rates and both schedule versions', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        const res = await change(loan.id, { newRate: 9.5, reason: 'Repriced at renewal' });
        expectStatus(res, [200, 201]);

        const rows = await ctx.prisma.loanRateChange.findMany({
          where: { requestId: loan.id },
        });
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].oldRate)).toBe(6);
        expect(Number(rows[0].newRate)).toBe(9.5);
        expect(rows[0].scheduleVersionAfter).toBeGreaterThan(
          rows[0].scheduleVersionBefore,
        );
      });
    });

    it('puts the new rate on the loan', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        await change(loan.id, { newRate: 9.5 });

        const row = await ctx.prisma.advanceLoanRequest.findUnique({
          where: { id: loan.id },
        });
        expect(Number(row!.interestRate)).toBe(9.5);
      });
    });

    it('re-plans the loan, and the new plan charges the new rate', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        const before = await ctx.prisma.loanSchedule.aggregate({
          where: { requestId: loan.id, version: 1 },
          _sum: { interestComponent: true },
        });

        await change(loan.id, { newRate: 24 });

        const after = await ctx.prisma.advanceLoanRequest.findUnique({
          where: { id: loan.id },
        });
        const newPlan = await ctx.prisma.loanSchedule.aggregate({
          where: { requestId: loan.id, version: after!.scheduleVersion },
          _sum: { interestComponent: true },
        });
        expect(Number(newPlan._sum.interestComponent ?? 0)).toBeGreaterThan(
          Number(before._sum.interestComponent ?? 0),
        );
      });
    });

    it('can switch the method as well as the rate', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        await change(loan.id, { newMethod: 'REDUCING_BALANCE', newRate: 10 });

        const row = await ctx.prisma.advanceLoanRequest.findUnique({
          where: { id: loan.id },
        });
        expect(row!.interestMethod).toBe('REDUCING_BALANCE');
      });
    });

    it('can make a loan interest-free', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        const res = await change(loan.id, { newMethod: 'NONE', newRate: 0 });
        expectStatus(res, [200, 201]);

        const row = await ctx.prisma.advanceLoanRequest.findUnique({
          where: { id: loan.id },
        });
        expect(row!.interestMethod).toBe('NONE');
        expect(Number(row!.interestRate)).toBe(0);
      });
    });

    it('KEEP_EMI holds the instalment and moves the term', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        await change(loan.id, { newRate: 24, mode: 'KEEP_EMI' });

        const row = await ctx.prisma.advanceLoanRequest.findUnique({
          where: { id: loan.id },
        });
        const rows = await ctx.prisma.loanSchedule.findMany({
          where: { requestId: loan.id, version: row!.scheduleVersion },
        });
        // More interest at the same instalment can only mean more instalments.
        expect(rows.length).toBeGreaterThanOrEqual(6);
      });
    });

    it('never re-prices an instalment money has already touched', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        const first = await ctx.prisma.loanSchedule.findFirst({
          where: { requestId: loan.id, installmentNo: 1 },
        });
        await ctx.prisma.loanSchedule.update({
          where: { id: first!.id },
          data: { status: 'PAID', paidAmount: 206, paidPrincipal: 200, paidInterest: 6 },
        });

        await change(loan.id, { newRate: 24 });

        const settled = await ctx.prisma.loanSchedule.findUnique({
          where: { id: first!.id },
        });
        expect(Number(settled!.interestComponent)).toBe(6);
        expect(settled!.status).toBe('PAID');
      });
    });

    it('refuses a change that changes nothing', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        const res = await change(loan.id, { newRate: 6 });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/already on 6%/i);
      });
    });

    it('refuses a rate while interest is switched off system-wide', async () => {
      await withSetting(ctx, 'loan_interest_enabled', 'false', async () => {
        const loan = await seedLoan();
        const res = await change(loan.id, { newRate: 9 });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/loan_interest_enabled/);
      });
    });

    it('refuses a method with no rate, and a rate with no method', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        expectStatus(await change(loan.id, { newMethod: 'FLAT', newRate: 0 }), 400);
        expectStatus(await change(loan.id, { newMethod: 'NONE', newRate: 5 }), 400);
      });
    });

    it.each([
      ['manager', () => fx.manager.token],
      ['employee', () => fx.employee.token],
    ])('refuses %s — repricing is an approver’s act', async (_who, token) => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        const res = await change(loan.id, { newRate: 9 }, token());
        expectStatus(res, 403);
      });
    });

    it('lists the history', async () => {
      await withSettings(ctx, INTEREST_ON, async () => {
        const loan = await seedLoan();
        await change(loan.id, { newRate: 9 });
        await change(loan.id, { newRate: 12 });

        const res = await ctx
          .http()
          .get(`/advance-loans/${loan.id}/rate-history`)
          .set(bearer(fx.hrGlobal.token));
        expectStatus(res, 200);
        expect(dataOf(res)).toHaveLength(2);
      });
    });
  });

  // ── Early-settlement interest ─────────────────────────────────────────────

  describe('loan_flat_prepayment_interest decides what settling early costs', () => {
    it('PRORATA charges only the interest that has accrued', async () => {
      await withSettings(
        ctx,
        { ...INTEREST_ON, loan_flat_prepayment_interest: 'PRORATA' },
        async () => {
          const loan = await seedLoan();
          const res = await ctx
            .http()
            .get(`/advance-loans/${loan.id}/payoff-quote`)
            .set(bearer(fx.hrGlobal.token));
          expectStatus(res, 200);
          // Nothing is due yet, so nothing has been earned.
          expect(Number(dataOf(res).unearnedInterest)).toBe(0);
          expect(Number(dataOf(res).payoffAmount)).toBe(1200);
        },
      );
    });

    it('FULL charges the whole agreed interest — an early-settlement premium', async () => {
      // The one value the accrual model does not already satisfy, and the
      // reason the setting was worth reading at all.
      await withSettings(
        ctx,
        { ...INTEREST_ON, loan_flat_prepayment_interest: 'FULL' },
        async () => {
          const loan = await seedLoan();
          const res = await ctx
            .http()
            .get(`/advance-loans/${loan.id}/payoff-quote`)
            .set(bearer(fx.hrGlobal.token));
          expectStatus(res, 200);
          expect(Number(dataOf(res).unearnedInterest)).toBeGreaterThan(0);
          expect(Number(dataOf(res).payoffAmount)).toBeGreaterThan(1200);
        },
      );
    });

    it('leaves a reducing-balance loan alone whatever the setting says', async () => {
      // Reducing-balance interest is unearned until the balance is carried, so
      // "charge it anyway" has no meaning there.
      await withSettings(
        ctx,
        { ...INTEREST_ON, loan_flat_prepayment_interest: 'FULL' },
        async () => {
          const loan = await seedLoan({ interestMethod: 'REDUCING_BALANCE' });
          const res = await ctx
            .http()
            .get(`/advance-loans/${loan.id}/payoff-quote`)
            .set(bearer(fx.hrGlobal.token));
          expectStatus(res, 200);
          expect(Number(dataOf(res).unearnedInterest)).toBe(0);
        },
      );
    });
  });

  // ── Top-up ────────────────────────────────────────────────────────────────

  describe('topping up a loan', () => {
    const topup = (id: string, payload: Record<string, unknown>, token = fx.hrGlobal.token) =>
      ctx.http().post(`/advance-loans/${id}/topup`).set(bearer(token)).send(payload);

    const TOPUP_ON = { ...INTEREST_ON, loan_topup_enabled: 'true' };

    it('is refused while the switch is off', async () => {
      await withSettings(ctx, { ...INTEREST_ON, loan_topup_enabled: 'false' }, async () => {
        const loan = await seedLoan();
        const res = await topup(loan.id, { amount: 3000, installments: 12 });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/switched off/i);
      });
    });

    it('closes the old loan as TOPPED_UP and opens the new one', async () => {
      await withSettings(ctx, TOPUP_ON, async () => {
        const loan = await seedLoan();
        const res = await topup(loan.id, { amount: 3000, installments: 12 });
        expectStatus(res, [200, 201]);

        const old = await ctx.prisma.advanceLoanRequest.findUnique({
          where: { id: loan.id },
        });
        expect(old!.status).toBe('CLOSED');
        expect(old!.closureType).toBe('TOPPED_UP');

        const created = await ctx.prisma.advanceLoanRequest.findUnique({
          where: { id: dataOf(res).newLoanId },
        });
        expect(created!.topupOfId).toBe(loan.id);
        expect(created!.approvalSource).toBe('TOPUP');
        expect(Number(created!.amount)).toBe(3000);
      });
    });

    it('hands over only the difference, not the whole new principal', async () => {
      // The point of a top-up being one movement: 3000 replacing a 1200
      // balance is 1800 of new money, not 3000.
      await withSettings(ctx, TOPUP_ON, async () => {
        const loan = await seedLoan();
        const res = await topup(loan.id, { amount: 3000, installments: 12 });
        expectStatus(res, [200, 201]);

        expect(Number(dataOf(res).settledAmount)).toBe(1200);
        expect(Number(dataOf(res).cashToEmployee)).toBe(1800);
      });
    });

    it('writes the TOPUP_SETTLEMENT ledger row — an enum member with no producer until now', async () => {
      await withSettings(ctx, TOPUP_ON, async () => {
        const loan = await seedLoan();
        await topup(loan.id, { amount: 3000, installments: 12 });

        const rows = await ctx.prisma.loanTransaction.findMany({
          where: { requestId: loan.id, type: 'TOPUP_SETTLEMENT' },
        });
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].amount)).toBe(1200);
      });
    });

    it('cancels what was still scheduled on the old plan', async () => {
      // Those instalments belong to an agreement that no longer exists; leaving
      // them SCHEDULED would have payroll collect on both loans.
      await withSettings(ctx, TOPUP_ON, async () => {
        const loan = await seedLoan();
        await topup(loan.id, { amount: 3000, installments: 12 });

        const live = await ctx.prisma.loanSchedule.count({
          where: { requestId: loan.id, status: { in: ['SCHEDULED', 'PARTIAL'] } },
        });
        expect(live).toBe(0);
      });
    });

    it('gives the new loan its own schedule', async () => {
      await withSettings(ctx, TOPUP_ON, async () => {
        const loan = await seedLoan();
        const res = await topup(loan.id, { amount: 3000, installments: 12 });

        const rows = await ctx.prisma.loanSchedule.findMany({
          where: { requestId: dataOf(res).newLoanId },
        });
        expect(rows.length).toBe(12);
      });
    });

    it('carries the old terms forward — a top-up is not a renegotiation', async () => {
      await withSettings(ctx, TOPUP_ON, async () => {
        const loan = await seedLoan();
        const res = await topup(loan.id, { amount: 3000, installments: 12 });

        const created = await ctx.prisma.advanceLoanRequest.findUnique({
          where: { id: dataOf(res).newLoanId },
        });
        expect(created!.interestMethod).toBe('FLAT');
        expect(Number(created!.interestRate)).toBe(6);
      });
    });

    it('refuses a top-up that is not larger than what is owed', async () => {
      await withSettings(ctx, TOPUP_ON, async () => {
        const loan = await seedLoan();
        const res = await topup(loan.id, { amount: 1000, installments: 12 });
        expectStatus(res, 400);
        expect(body(res)).toMatch(/part-payment/i);
      });
    });

    it.each([
      ['manager', () => fx.manager.token],
      ['employee', () => fx.employee.token],
    ])('refuses %s', async (_who, token) => {
      await withSettings(ctx, TOPUP_ON, async () => {
        const loan = await seedLoan();
        const res = await topup(loan.id, { amount: 3000, installments: 12 }, token());
        expectStatus(res, 403);
      });
    });

    it('refuses to top up a loan that is already closed', async () => {
      await withSettings(ctx, TOPUP_ON, async () => {
        const loan = await seedLoan({ status: 'CLOSED' });
        const res = await topup(loan.id, { amount: 3000, installments: 12 });
        expectStatus(res, 400);
      });
    });
  });
});
