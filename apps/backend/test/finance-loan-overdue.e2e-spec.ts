import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer, withSetting } from './utils/settings';
import { LoanOverdueService } from '../src/advance-loans/loan-overdue.service';

/**
 * Delinquency, and the borrower's own payment.
 *
 * Two settings that were seeded and read by nothing:
 *
 *   `loan_overdue_after_cycles` — there was no OVERDUE status at all, so a loan
 *     two cycles behind looked exactly like a healthy one everywhere except the
 *     ageing report, which computes buckets at query time and changes nothing.
 *   `loan_employee_self_prepay` — `POST /:id/prepay` was ADMIN/HR only, so a
 *     borrower who paid at the counter could not record it.
 *
 * The sweep is driven directly here rather than through its cron: the schedule
 * fires at company-local 06:00, and a test that waits for a clock tests the
 * clock.
 */
describe('Finance — overdue loans and self-service payment (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;
  let overdue: LoanOverdueService;

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

  /**
   * A live loan whose first `missed` instalments are in the past and unpaid.
   */
  const seedLoan = async (missed: number, over: Record<string, any> = {}) => {
    const loan = await ctx.prisma.advanceLoanRequest.create({
      data: {
        employeeId: fx.earnerId,
        type: 'LOAN',
        amount: 1000,
        installments: 5,
        installmentAmount: 200,
        status: 'ACTIVE',
        scheduleVersion: 1,
        outstandingPrincipal: 1000,
        referenceNo: `OD-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
        ...over,
      },
    });

    const now = new Date();
    await ctx.prisma.loanSchedule.createMany({
      data: Array.from({ length: 5 }, (_, i) => {
        // The first `missed` fall in past months; the rest in future ones.
        const monthsAway = i < missed ? -(missed - i) : i - missed + 1;
        const due = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAway, 15),
        );
        return {
          requestId: loan.id,
          version: 1,
          installmentNo: i + 1,
          dueDate: due,
          dueCycleKey: due.getUTCFullYear() * 12 + due.getUTCMonth() + 1,
          dueMonth: due.getUTCMonth() + 1,
          dueYear: due.getUTCFullYear(),
          openingBalance: 1000 - i * 200,
          principalComponent: 200,
          emiAmount: 200,
          closingBalance: 800 - i * 200,
          status: 'SCHEDULED' as const,
        };
      }),
    });
    return loan;
  };

  const statusOf = async (id: string) =>
    (await ctx.prisma.advanceLoanRequest.findUnique({ where: { id } }))!.status;

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
    await ctx.prisma.advanceLoanDeduction.deleteMany({ where });
    await ctx.prisma.loanSchedule.deleteMany({ where });
    await ctx.prisma.advanceLoanRequest.deleteMany({ where: { id: { in: ids } } });
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
    overdue = ctx.app.get(LoanOverdueService);
  });

  afterEach(clearLoans);

  afterAll(async () => {
    await clearLoans();
    await fx.cleanup();
    await ctx.app.close();
  });

  describe('the sweep', () => {
    it('marks a loan overdue once it is the configured number of cycles behind', async () => {
      await withSetting(ctx, 'loan_overdue_after_cycles', '2', async () => {
        const loan = await seedLoan(2);
        await overdue.sweep();
        expect(await statusOf(loan.id)).toBe('OVERDUE');
      });
    });

    it('leaves a loan alone one cycle short of the threshold', async () => {
      await withSetting(ctx, 'loan_overdue_after_cycles', '2', async () => {
        const loan = await seedLoan(1);
        await overdue.sweep();
        expect(await statusOf(loan.id)).toBe('ACTIVE');
      });
    });

    it('honours a stricter threshold', async () => {
      await withSetting(ctx, 'loan_overdue_after_cycles', '1', async () => {
        const loan = await seedLoan(1);
        await overdue.sweep();
        expect(await statusOf(loan.id)).toBe('OVERDUE');
      });
    });

    it('does nothing at all when the threshold is 0 — that is what "off" means', async () => {
      // The alternative reading, marking every late loan overdue at once, is
      // the opposite of what a company turning it off is asking for.
      await withSetting(ctx, 'loan_overdue_after_cycles', '0', async () => {
        const loan = await seedLoan(5);
        const result = await overdue.sweep();
        expect(result.markedOverdue).toBe(0);
        expect(await statusOf(loan.id)).toBe('ACTIVE');
      });
    });

    it('counts a PARTIAL instalment as missed', async () => {
      // Part of an instalment is not an instalment; treating it as paid is how
      // a slipping loan stays invisible.
      await withSetting(ctx, 'loan_overdue_after_cycles', '2', async () => {
        const loan = await seedLoan(2);
        const rows = await ctx.prisma.loanSchedule.findMany({
          where: { requestId: loan.id },
          orderBy: { installmentNo: 'asc' },
        });
        await ctx.prisma.loanSchedule.update({
          where: { id: rows[0].id },
          data: { status: 'PARTIAL', paidAmount: 50 },
        });

        await overdue.sweep();
        expect(await statusOf(loan.id)).toBe('OVERDUE');
      });
    });

    it('does not count a PAID instalment', async () => {
      await withSetting(ctx, 'loan_overdue_after_cycles', '2', async () => {
        const loan = await seedLoan(2);
        const rows = await ctx.prisma.loanSchedule.findMany({
          where: { requestId: loan.id },
          orderBy: { installmentNo: 'asc' },
        });
        await ctx.prisma.loanSchedule.update({
          where: { id: rows[0].id },
          data: { status: 'PAID', paidAmount: 200 },
        });

        await overdue.sweep();
        expect(await statusOf(loan.id)).toBe('ACTIVE');
      });
    });

    it('brings a loan back to ACTIVE once it catches up', async () => {
      // A status nobody clears is a status nobody trusts.
      await withSetting(ctx, 'loan_overdue_after_cycles', '2', async () => {
        const loan = await seedLoan(2);
        await overdue.sweep();
        expect(await statusOf(loan.id)).toBe('OVERDUE');

        await ctx.prisma.loanSchedule.updateMany({
          where: { requestId: loan.id, status: 'SCHEDULED' },
          data: { status: 'PAID' },
        });
        const result = await overdue.sweep();

        expect(result.recovered).toBe(1);
        expect(await statusOf(loan.id)).toBe('ACTIVE');
      });
    });

    it('leaves a closed or held loan alone', async () => {
      await withSetting(ctx, 'loan_overdue_after_cycles', '1', async () => {
        const held = await seedLoan(3, { status: 'ON_HOLD' });
        const closed = await seedLoan(3, { status: 'CLOSED' });

        await overdue.sweep();

        expect(await statusOf(held.id)).toBe('ON_HOLD');
        expect(await statusOf(closed.id)).toBe('CLOSED');
      });
    });

    it('is idempotent — running it twice changes nothing the second time', async () => {
      await withSetting(ctx, 'loan_overdue_after_cycles', '2', async () => {
        await seedLoan(2);
        const first = await overdue.sweep();
        const second = await overdue.sweep();

        expect(first.markedOverdue).toBe(1);
        expect(second.markedOverdue).toBe(0);
      });
    });

    it('tells the borrower, once a month rather than once a day', async () => {
      await withSetting(ctx, 'loan_overdue_after_cycles', '2', async () => {
        const loan = await seedLoan(2);
        await overdue.sweep();
        // Back to ACTIVE and overdue again inside the same month.
        await ctx.prisma.advanceLoanRequest.update({
          where: { id: loan.id },
          data: { status: 'ACTIVE' },
        });
        await overdue.sweep();

        const logs = await ctx.prisma.advanceLoanNotificationLog.findMany({
          where: { requestId: loan.id, event: 'LOAN_OVERDUE' },
        });
        expect(logs).toHaveLength(1);
      });
    });
  });

  describe('an overdue loan is still a loan', () => {
    it('still counts as debt on the outstanding report', async () => {
      // Excluding it would make the new status quietly forgive the debt it
      // exists to flag.
      await withSetting(ctx, 'loan_overdue_after_cycles', '2', async () => {
        await seedLoan(2);
        await overdue.sweep();

        const res = await ctx
          .http()
          .get('/advance-loans/reports/outstanding')
          .set(bearer(fx.hrGlobal.token));
        expectStatus(res, 200);
        // `totals` is a SIBLING of `data` in the envelope, so it is read off
        // the body rather than through the data unwrapper.
        expect(Number(res.body?.totals?.outstanding ?? 0)).toBeGreaterThan(0);
        expect(
          (res.body?.data ?? []).some((r: any) => Number(r.outstanding) > 0),
        ).toBe(true);
      });
    });
  });

  describe('a borrower recording their own payment', () => {
    const liveLoan = async () => {
      const loan = await seedLoan(0);
      return loan.id;
    };

    it('is refused while the switch is off', async () => {
      await withSetting(ctx, 'loan_employee_self_prepay', 'false', async () => {
        const id = await liveLoan();
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/prepay`)
          .set(bearer(fx.employee.token))
          .send({ amount: 50, mode: 'CASH' });
        expectStatus(res, 403);
        expect(body(res)).toMatch(/switched off/i);
      });
    });

    it('is allowed on their own loan when it is on', async () => {
      await withSetting(ctx, 'loan_employee_self_prepay', 'true', async () => {
        const id = await liveLoan();
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/prepay`)
          .set(bearer(fx.employee.token))
          .send({ amount: 50, mode: 'CASH', reference: 'Counter receipt 12' });
        expectStatus(res, [200, 201]);

        const row = await ctx.prisma.advanceLoanRequest.findUnique({ where: { id } });
        expect(Number(row!.amountRepaid)).toBeGreaterThan(0);
      });
    });

    it('is refused on somebody else’s loan even when it is on', async () => {
      await withSetting(ctx, 'loan_employee_self_prepay', 'true', async () => {
        const id = await liveLoan();
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/prepay`)
          .set(bearer(fx.foreignEmployee.token))
          .send({ amount: 50, mode: 'CASH' });
        expectStatus(res, [403, 404]);
      });
    });

    it('never blocks HR, whatever the switch says', async () => {
      await withSetting(ctx, 'loan_employee_self_prepay', 'false', async () => {
        const id = await liveLoan();
        const res = await ctx
          .http()
          .post(`/advance-loans/${id}/prepay`)
          .set(bearer(fx.hrGlobal.token))
          .send({ amount: 50, mode: 'CASH' });
        expectStatus(res, [200, 201]);
      });
    });
  });
});
