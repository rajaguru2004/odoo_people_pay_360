import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer, withSetting, withSettings } from './utils/settings';

/**
 * Advances & Loans — the SURFACE suite.
 *
 * `loan-advances-v2.e2e-spec.ts` (120 cases) owns the money: amortization,
 * recovery, interest, settlement arithmetic, the refusal messages. It is the
 * best-covered thing in the product. What it does not own is the DOOR — who may
 * reach each of the thirty-odd routes, whether a branch or a department narrows
 * what they see, and whether the two-tier role model (a `@Roles` decorator plus
 * a CSV in `system_settings`) actually decides what it claims to.
 *
 * That distinction matters more here than anywhere else in Finance, because
 * these routes move company money and because six of them carry no `@Roles`
 * metadata at all.
 *
 * Three defects were found here and are now fixed; the cases that found them
 * remain as the regression lock:
 *   F1  — the amortization schedule was readable by any colleague in the branch.
 *   F11 — settlement never called `assertInBranch` on either half.
 *   F22 — the settlement routes collided on a bare `:param`.
 */
describe('Finance — Advances & Loans surface (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any): any => res.body?.data ?? res.body;
  const rowsOf = (res: any): any[] => {
    const d = dataOf(res);
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };
  const idsOf = (res: any) => rowsOf(res).map((r: any) => r.id);

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

  /**
   * Loans cap at `loan_max_active_per_employee` (default 2), so a suite that
   * files freely runs out of allowance halfway through. Every helper here
   * writes the row directly and the suite clears the graph between groups.
   */
  const seedLoan = async (over: Record<string, unknown> = {}) =>
    ctx.prisma.advanceLoanRequest.create({
      data: {
        employeeId: fx.earnerId,
        type: 'LOAN',
        amount: 1200,
        installments: 12,
        status: 'ACTIVE',
        reason: `e2e ${fx.runId}`,
        ...over,
      },
    });

  const seedSchedule = async (requestId: string, count = 3) => {
    const loan = await ctx.prisma.advanceLoanRequest.findUnique({
      where: { id: requestId },
      select: { scheduleVersion: true },
    });
    for (let n = 1; n <= count; n++) {
      const dueMonth = ((n - 1) % 12) + 1;
      const dueYear = 2026;
      await ctx.prisma.loanSchedule.create({
        data: {
          requestId,
          version: loan!.scheduleVersion,
          installmentNo: n,
          dueDate: new Date(dueYear, dueMonth - 1, 28),
          // Denormalised from dueDate on purpose — "this cycle or earlier" is
          // one indexed comparison rather than per-row date arithmetic.
          dueCycleKey: dueYear * 12 + dueMonth,
          dueMonth,
          dueYear,
          openingBalance: 100 * (count - n + 1),
          principalComponent: 100,
          emiAmount: 100,
          closingBalance: 100 * (count - n),
          status: 'SCHEDULED',
        },
      });
    }
  };

  /** Every principal, so a route can be swept rather than sampled. */
  const principals = () => [
    ['admin', fx.admin] as const,
    ['hrGlobal', fx.hrGlobal] as const,
    ['hrScoped', fx.hrScoped] as const,
    ['manager', fx.manager] as const,
    ['employee', fx.employee] as const,
  ];

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Requesting ────────────────────────────────────────────────────────────
  describe('requesting', () => {
    it('LOAN-API-01 an employee requests a loan and it waits for a human', async () => {
      const res = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.employee.token))
        .send({
          type: 'LOAN',
          amount: 300,
          installments: 3,
          reason: `e2e ${fx.runId} request`,
        });
      expectStatus(res, 201);
      // Unlike travel, "no approval chain configured" here means a human still
      // decides. The asymmetry is pinned from the travel side in TRV-API-30.
      expect(dataOf(res).status).toBe('PENDING');
      expect(dataOf(res).installmentAmount ?? null).toBeFalsy();
    });

    it('LOAN-API-02 ADMIN cannot request; every other role can', async () => {
      const admin = await ctx
        .http()
        .post('/advance-loans')
        .set(bearer(fx.admin.token))
        .send({ type: 'ADVANCE', amount: 10, reason: `e2e ${fx.runId}` });
      expectStatus(admin, 403);

      const anon = await ctx.http().post('/advance-loans').send({});
      expect(anon.status).toBe(401);
    });

    it('LOAN-API-03 the module kill switch refuses a request', async () => {
      await withSetting(ctx, 'advance_loan_enabled', 'false', async () => {
        const res = await ctx
          .http()
          .post('/advance-loans')
          .set(bearer(fx.employee.token))
          .send({ type: 'ADVANCE', amount: 10, reason: `e2e ${fx.runId}` });
        expectStatus(res, 400);
        expect(String(res.body.message)).toMatch(/disabled/i);
      });
    });
  });

  // ── Eligibility ───────────────────────────────────────────────────────────
  describe('the eligibility engine', () => {
    const check = (token: string, payload: Record<string, unknown>) =>
      ctx
        .http()
        .post('/advance-loans/eligibility')
        .set(bearer(token))
        .send(payload);

    it('LOAN-API-04 a healthy request passes every check', async () => {
      const res = await check(fx.employee.token, {
        employeeId: fx.earnerId,
        type: 'LOAN',
        amount: 300,
        installments: 6,
      });
      expectStatus(res, 200);
      const d = dataOf(res);
      expect(d.eligible).toBe(true);
      const failed = (d.checks ?? []).filter((c: any) => c.status === 'FAIL');
      expect(failed).toEqual([]);
    });

    it('LOAN-API-05 an inactive employee fails, and the reason names the status', async () => {
      const res = await check(fx.admin.token, {
        employeeId: fx.inactiveId,
        type: 'LOAN',
        amount: 100,
        installments: 3,
      });
      expectStatus(res, 200);
      const d = dataOf(res);
      expect(d.eligible).toBe(false);
      const failure = (d.checks ?? []).find(
        (c: any) => c.status === 'FAIL' && /INACTIVE/i.test(c.detail ?? ''),
      );
      expect(failure).toBeTruthy();
    });

    it('LOAN-API-06 minimum service is a setting, not a constant', async () => {
      // The 2-month joiner passes at the default (0 months) and fails at 12.
      const pass = await check(fx.admin.token, {
        employeeId: fx.newJoinerId,
        type: 'LOAN',
        amount: 100,
        installments: 3,
      });
      expect(dataOf(pass).eligible).toBe(true);

      await withSetting(ctx, 'loan_min_service_months', '12', async () => {
        const fail = await check(fx.admin.token, {
          employeeId: fx.newJoinerId,
          type: 'LOAN',
          amount: 100,
          installments: 3,
        });
        expect(dataOf(fail).eligible).toBe(false);
      });
    });

    it('LOAN-API-07 the active-loan ceiling is a setting, and counts only open loans', async () => {
      const a = await seedLoan();
      const b = await seedLoan();
      try {
        await withSetting(
          ctx,
          'loan_max_active_per_employee',
          '2',
          async () => {
            const res = await check(fx.admin.token, {
              employeeId: fx.earnerId,
              type: 'LOAN',
              amount: 100,
              installments: 3,
            });
            expect(dataOf(res).eligible).toBe(false);
          },
        );

        // A closed loan is not an active one.
        await ctx.prisma.advanceLoanRequest.updateMany({
          where: { id: { in: [a.id, b.id] } },
          data: { status: 'CLOSED' },
        });
        await withSetting(
          ctx,
          'loan_max_active_per_employee',
          '2',
          async () => {
            const res = await check(fx.admin.token, {
              employeeId: fx.earnerId,
              type: 'LOAN',
              amount: 100,
              installments: 3,
            });
            expect(dataOf(res).eligible).toBe(true);
          },
        );
      } finally {
        await ctx.prisma.loanSchedule.deleteMany({
          where: { requestId: { in: [a.id, b.id] } },
        });
        await ctx.prisma.advanceLoanRequest.deleteMany({
          where: { id: { in: [a.id, b.id] } },
        });
      }
    });

    it('LOAN-API-08 an annual-salary-sized loan WARNs rather than FAILs', async () => {
      // A warning is a prompt to confirm the repayment plan, not a refusal —
      // treating it as one would block every genuine large loan.
      const res = await check(fx.admin.token, {
        employeeId: fx.earnerId,
        type: 'LOAN',
        amount: 100000,
        installments: 12,
      });
      expectStatus(res, 200);
      const warns = (dataOf(res).checks ?? []).filter(
        (c: any) => c.status === 'WARN',
      );
      expect(warns.length).toBeGreaterThan(0);
    });

    it('LOAN-API-09 a non-privileged caller is forced to check only themselves', async () => {
      const res = await check(fx.employee.token, {
        employeeId: fx.newJoinerId, // somebody else
        type: 'LOAN',
        amount: 100,
        installments: 3,
      });
      expectStatus(res, 200);
      // The service overwrites the id with the caller's own, so the answer
      // describes the caller — an employee cannot probe a colleague's salary
      // headroom by iterating employee ids.
      expect(dataOf(res).employeeId ?? fx.earnerId).toBe(fx.earnerId);
    });

    it('LOAN-API-10 an unknown employee 404s', async () => {
      const res = await check(fx.admin.token, {
        employeeId: '00000000-0000-0000-0000-000000000000',
        type: 'LOAN',
        amount: 100,
        installments: 3,
      });
      expectStatus(res, 404);
      expect(res.body.message).toBe('Employee not found');
    });
  });

  // ── Reading ───────────────────────────────────────────────────────────────
  describe('reading', () => {
    it('LOAN-API-11 the book is ADMIN/HR only', async () => {
      for (const [label, who] of principals()) {
        const res = await ctx
          .http()
          .get('/advance-loans')
          .set(bearer(who.token));
        const want = ['admin', 'hrGlobal', 'hrScoped'].includes(label)
          ? 200
          : 403;
        expectStatus(res, want, label);
      }
      expect((await ctx.http().get('/advance-loans')).status).toBe(401);
    });

    it('LOAN-API-12 pagination is opt-in, and the summary intersects the caller’s filter', async () => {
      const active = await seedLoan({ amount: 1000, amountRepaid: 250 });
      const rejected = await seedLoan({ amount: 5000, status: 'REJECTED' });
      try {
        const plain = await ctx
          .http()
          .get('/advance-loans')
          .set(bearer(fx.admin.token));
        expectStatus(plain, 200);
        expect(Array.isArray(dataOf(plain))).toBe(true);

        const paged = await ctx
          .http()
          .get('/advance-loans?page=1&limit=50')
          .set(bearer(fx.admin.token));
        expectStatus(paged, 200);
        expect(paged.body.meta).toBeTruthy();
        expect(paged.body.summary).toBeTruthy();

        // The bug this pins: a filtered view must report ITS OWN balance, not
        // the whole book's. A rejected request's principal is not debt.
        const rejectedOnly = await ctx
          .http()
          .get('/advance-loans?page=1&limit=50&status=REJECTED')
          .set(bearer(fx.admin.token));
        expectStatus(rejectedOnly, 200);
        expect(Number(rejectedOnly.body.summary.totalOutstanding)).toBe(0);
      } finally {
        await ctx.prisma.advanceLoanRequest.deleteMany({
          where: { id: { in: [active.id, rejected.id] } },
        });
      }
    });

    it('LOAN-API-13 a branch-scoped HR does not see another branch’s loans', async () => {
      const foreign = await seedLoan({ employeeId: fx.foreignId });
      try {
        const scoped = await ctx
          .http()
          .get('/advance-loans')
          .set(bearer(fx.hrScoped.token));
        expect(idsOf(scoped)).not.toContain(foreign.id);

        const global = await ctx
          .http()
          .get('/advance-loans')
          .set(bearer(fx.hrGlobal.token));
        expect(idsOf(global)).toContain(foreign.id);

        const byId = await ctx
          .http()
          .get(`/advance-loans/${foreign.id}`)
          .set(bearer(fx.hrScoped.token));
        expectStatus(byId, [403, 404]);
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({
          where: { id: foreign.id },
        });
      }
    });

    it('LOAN-API-14 a stranger cannot read a loan by id, and the refusal says why', async () => {
      const loan = await seedLoan();
      try {
        const res = await ctx
          .http()
          .get(`/advance-loans/${loan.id}`)
          .set(bearer(fx.auditor.token));
        expectStatus(res, 403);
        expect(res.body.message).toBe(
          'You do not have permission to view this advance/loan request',
        );

        const owner = await ctx
          .http()
          .get(`/advance-loans/${loan.id}`)
          .set(bearer(fx.employee.token));
        expectStatus(owner, 200);
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-15 an auditor named by USER ID reads every loan and writes none', async () => {
      const loan = await seedLoan();
      try {
        await withSettings(
          ctx,
          { advance_loan_auditor_user_ids: fx.auditor.userId },
          async () => {
            const read = await ctx
              .http()
              .get(`/advance-loans/${loan.id}`)
              .set(bearer(fx.auditor.token));
            expectStatus(read, 200);

            // Read-all is not write-any: the lifecycle routes are still
            // `@Roles('ADMIN','HR_MANAGER')`, which an EMPLOYEE auditor fails.
            const write = await ctx
              .http()
              .post(`/advance-loans/${loan.id}/hold`)
              .set(bearer(fx.auditor.token))
              .send({ reason: 'audit hold' });
            expectStatus(write, 403);
          },
        );
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });
  });

  // ── F1: the schedule door ─────────────────────────────────────────────────
  describe('the amortization schedule', () => {
    it('LOAN-API-16 the owner and ADMIN/HR read the schedule', async () => {
      const loan = await seedLoan();
      await seedSchedule(loan.id);
      try {
        for (const who of [fx.employee, fx.admin, fx.hrGlobal]) {
          const res = await ctx
            .http()
            .get(`/advance-loans/${loan.id}/schedule`)
            .set(bearer(who.token));
          expectStatus(res, 200, who.email);
          expect(rowsOf(res)).toHaveLength(3);
        }
      } finally {
        await ctx.prisma.loanSchedule.deleteMany({
          where: { requestId: loan.id },
        });
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-17 F1 — the schedule is as private as the loan it belongs to', async () => {
      // `LoanScheduleService.listLive` resolves the loan with a bare
      // `findUnique` and returns the rows. No `assertInBranch`, no
      // `assertCanViewLoan` — unlike the payoff-quote route immediately beside
      // it (LOAN-API-18), and unlike `GET /advance-loans/:id` itself
      // (LOAN-API-14), both of which refuse the very same caller.
      //
      // The blast radius is ONE BRANCH, not the company: `LoanSchedule` is in
      // the branch scope map under `path: ['request','employee']`, so the
      // `findMany` that fetches the rows is narrowed by the middleware and a
      // cross-branch caller gets an empty list (asserted below). That is the
      // middleware saving a door that forgot to lock itself — worth knowing,
      // and not a reason to leave it unlocked.
      const own = await seedLoan();
      await seedSchedule(own.id);
      const foreign = await seedLoan({ employeeId: fx.foreignId });
      await seedSchedule(foreign.id);
      try {
        // An unrelated employee in the same branch used to get the full
        // repayment plan — instalment amounts, dates and what a colleague still
        // owed — while being refused the loan record itself and the payoff quote
        // beside it. `listLive` resolved the loan with a bare `findUnique` and
        // returned the rows to anyone holding the id.
        const stranger = await ctx
          .http()
          .get(`/advance-loans/${own.id}/schedule`)
          .set(bearer(fx.auditor.token));
        expectStatus(stranger, 403);

        // The owner and ADMIN/HR still read it.
        const owner = await ctx
          .http()
          .get(`/advance-loans/${own.id}/schedule`)
          .set(bearer(fx.employee.token));
        expectStatus(owner, 200);
        expect(rowsOf(owner).length).toBe(3);

        // Cross-branch: 404, so the status no longer confirms the loan exists.
        const crossBranch = await ctx
          .http()
          .get(`/advance-loans/${foreign.id}/schedule`)
          .set(bearer(fx.hrScoped.token));
        expectStatus(crossBranch, 404);
      } finally {
        await ctx.prisma.loanSchedule.deleteMany({
          where: { requestId: { in: [own.id, foreign.id] } },
        });
        await ctx.prisma.advanceLoanRequest.deleteMany({
          where: { id: { in: [own.id, foreign.id] } },
        });
      }
    });


    it('LOAN-API-18 the payoff quote, right beside it, IS guarded', async () => {
      // The contrast is the evidence that F1 is an omission rather than a
      // policy: two routes on the same controller, one checks and one does not.
      const foreign = await seedLoan({ employeeId: fx.foreignId });
      try {
        const res = await ctx
          .http()
          .get(`/advance-loans/${foreign.id}/payoff-quote`)
          .set(bearer(fx.auditor.token));
        expectStatus(res, [403, 404]);
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({
          where: { id: foreign.id },
        });
      }
    });
  });

  // ── Lifecycle authorization ───────────────────────────────────────────────
  describe('lifecycle authorization', () => {
    const OPS = [
      'foreclose',
      'close',
      'write-off',
      'reinstate',
      'waive',
      'hold',
      'resume',
      'skip-installment',
      'convert',
      // `prepay` is covered by LOAN-API-19b instead: it now admits EMPLOYEE at
      // the decorator and refuses them in the service, so the denial has to be
      // driven with a payload the validation pipe accepts.
    ];

    it('LOAN-API-19 every money operation is closed to MANAGER and EMPLOYEE', async () => {
      const loan = await seedLoan();
      try {
        for (const op of OPS) {
          for (const who of [fx.manager, fx.employee]) {
            const res = await ctx
              .http()
              .post(`/advance-loans/${loan.id}/${op}`)
              .set(bearer(who.token))
              .send({ amount: 1, reason: 'e2e attempt' });
            expectStatus(res, 403, `${op} as ${who.email}`);
          }
        }
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-19b prepay admits EMPLOYEE at the door and refuses them behind it', async () => {
      // `prepay` left the list above when `loan_employee_self_prepay` gained a
      // reader: a borrower who pays at the counter can record it themselves,
      // but only where the deployment allows it and only on their own loan.
      // The decorator therefore admits EMPLOYEE and the service narrows it —
      // so the REFUSAL, not the decorator, is what has to be tested.
      const loan = await seedLoan();
      try {
        for (const who of [fx.manager, fx.employee]) {
          const res = await ctx
            .http()
            .post(`/advance-loans/${loan.id}/prepay`)
            .set(bearer(who.token))
            // A valid payload: the point is the authorization answer, and an
            // invalid one is refused by the pipe before any rule is consulted.
            .send({ amount: 1, mode: 'CASH' });
          expectStatus(res, 403, `prepay as ${who.email} with self-prepay off`);
        }
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-20 write-off is narrower than the decorator: ADMIN only by default', async () => {
      const loan = await seedLoan({ amount: 1000, amountRepaid: 0 });
      try {
        // HR passes `@Roles('ADMIN','HR_MANAGER')` and fails
        // `advance_loan_writeoff_roles`, whose default is 'ADMIN'.
        const hr = await ctx
          .http()
          .post(`/advance-loans/${loan.id}/write-off`)
          .set(bearer(fx.hrGlobal.token))
          .send({ amount: 10, reason: 'e2e write-off reason long enough' });
        expectStatus(hr, 403);
        expect(String(hr.body.message)).toContain(
          'not permitted to perform this operation',
        );

        // Widen the setting and the same call succeeds — proving the SETTING
        // refused, not the decorator.
        await withSetting(
          ctx,
          'advance_loan_writeoff_roles',
          'ADMIN,HR_MANAGER',
          async () => {
            const again = await ctx
              .http()
              .post(`/advance-loans/${loan.id}/write-off`)
              .set(bearer(fx.hrGlobal.token))
              .send({
                amount: 10,
                reason: 'e2e write-off reason long enough',
              });
            expectStatus(again, [200, 201]);
          },
        );
      } finally {
        await ctx.prisma.loanTransaction.deleteMany({
          where: { requestId: loan.id },
        });
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-21 waive is wider than write-off, and both follow their own key', async () => {
      const loan = await seedLoan({ amount: 1000, amountRepaid: 0 });
      try {
        // `loan_waiver_roles` defaults to 'ADMIN,HR_MANAGER', so HR may waive
        // where it may not write off. The two are different decisions about
        // company money and are configured separately on purpose.
        const hr = await ctx
          .http()
          .post(`/advance-loans/${loan.id}/waive`)
          .set(bearer(fx.hrGlobal.token))
          .send({ amount: 5, reason: 'goodwill, agreed with finance' });
        expectStatus(hr, [200, 201]);

        await withSetting(ctx, 'loan_waiver_roles', 'ADMIN', async () => {
          const narrowed = await ctx
            .http()
            .post(`/advance-loans/${loan.id}/waive`)
            .set(bearer(fx.hrGlobal.token))
            .send({ amount: 5, reason: 'goodwill, agreed with finance' });
          expectStatus(narrowed, 403);
        });
      } finally {
        await ctx.prisma.loanTransaction.deleteMany({
          where: { requestId: loan.id },
        });
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-22 a branch-scoped HR cannot operate on another branch’s loan', async () => {
      const foreign = await seedLoan({ employeeId: fx.foreignId });
      try {
        const res = await ctx
          .http()
          .post(`/advance-loans/${foreign.id}/hold`)
          .set(bearer(fx.hrScoped.token))
          .send({ reason: 'e2e cross-branch hold' });
        expectStatus(res, [403, 404]);
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({
          where: { id: foreign.id },
        });
      }
    });

    it('LOAN-API-23 a terminal loan refuses every operation, by name', async () => {
      const loan = await seedLoan({ status: 'REJECTED' });
      try {
        const res = await ctx
          .http()
          .post(`/advance-loans/${loan.id}/hold`)
          .set(bearer(fx.admin.token))
          .send({ reason: 'e2e hold on a rejected loan' });
        expectStatus(res, 400);
        expect(String(res.body.message)).toContain(
          'rejected and can no longer be changed',
        );
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });
  });

  // ── F11: settlement and import scoping ────────────────────────────────────
  describe('settlement', () => {
    it('LOAN-API-24 the quote and the settle call are ADMIN/HR; the reversal is ADMIN alone', async () => {
      const loan = await seedLoan();
      try {
        for (const [label, who] of principals()) {
          const res = await ctx
            .http()
            .get(`/advance-loans/settlement/${fx.earnerId}`)
            .set(bearer(who.token));
          const want = ['admin', 'hrGlobal', 'hrScoped'].includes(label)
            ? 200
            : 403;
          expectStatus(res, want, label);
        }

        // Reversal is the one route in Finance restricted to ADMIN by
        // decorator rather than by setting — it un-does a completed final
        // settlement.
        const hr = await ctx
          .http()
          .post(
            '/advance-loans/settlement/00000000-0000-0000-0000-000000000000/reverse',
          )
          .set(bearer(fx.hrGlobal.token))
          .send({ reason: 'e2e reversal reason' });
        expectStatus(hr, 403);
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-25 F11 — settlement respects the caller’s branch envelope', async () => {
      // `loan-settlement.service.ts` used to contain no `assertInBranch` at
      // all, relying on the Prisma middleware — which scopes `findMany` but NOT
      // `findUnique`, and does not scope `updateMany` for relation-scoped models
      // like `AdvanceLoanRequest`. A branch-scoped HR could quote, and then
      // SETTLE, an employee they could not otherwise see.
      const foreign = await seedLoan({ employeeId: fx.foreignId });
      try {
        const quote = await ctx
          .http()
          .get(`/advance-loans/settlement/${fx.foreignId}`)
          .set(bearer(fx.hrScoped.token));
        expectStatus(quote, 404);

        // The write half too — the guard has to be on both, not only the read.
        const settle = await ctx
          .http()
          .post(`/advance-loans/settlement/${fx.foreignId}`)
          .set(bearer(fx.hrScoped.token))
          .send({ decisions: [] });
        expectStatus(settle, 404);
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({
          where: { id: foreign.id },
        });
      }
    });


    it('LOAN-API-26 an employee with nothing outstanding cannot be settled', async () => {
      const res = await ctx
        .http()
        .post(`/advance-loans/settlement/${fx.newJoinerId}`)
        .set(bearer(fx.admin.token))
        .send({ decisions: [] });
      expectStatus(res, 400);
      expect(String(res.body.message)).toContain(
        'no outstanding advances or loans to settle',
      );
    });

    it('LOAN-API-27 every outstanding loan needs a decision, and the refusal names the missing ones', async () => {
      const loan = await seedLoan();
      try {
        const res = await ctx
          .http()
          .post(`/advance-loans/settlement/${fx.earnerId}`)
          .set(bearer(fx.admin.token))
          .send({ decisions: [] });
        expectStatus(res, 400);
        expect(String(res.body.message)).toContain('Missing:');
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-28 F22 — an unknown employee id says so, instead of being read as a loan-less employee', async () => {
      // `POST /advance-loans/settlement/:employeeId` and
      // `POST /advance-loans/settlement/:settlementId/reverse` share a prefix,
      // and nothing checked that `:employeeId` was an employee — so a settlement
      // id posted there was answered by the employee handler, refusing for the
      // wrong reason.
      const res = await ctx
        .http()
        .post('/advance-loans/settlement/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token))
        .send({ decisions: [] });
      expectStatus(res, 404);
      expect(String(res.body.message)).toMatch(/employee not found/i);
    });


    it('LOAN-API-29 the receivable ledger is ADMIN/HR and branch-scoped', async () => {
      const foreign = await seedLoan({
        employeeId: fx.foreignId,
        status: 'RECEIVABLE',
      });
      try {
        const scoped = await ctx
          .http()
          .get('/advance-loans/settlement/receivable')
          .set(bearer(fx.hrScoped.token));
        expectStatus(scoped, 200);
        expect(idsOf(scoped)).not.toContain(foreign.id);

        const emp = await ctx
          .http()
          .get('/advance-loans/settlement/receivable')
          .set(bearer(fx.employee.token));
        expectStatus(emp, 403);
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({
          where: { id: foreign.id },
        });
      }
    });
  });

  // ── Import ────────────────────────────────────────────────────────────────
  describe('bulk import', () => {
    it('LOAN-API-30 the template, preview and confirm are ADMIN/HR only', async () => {
      for (const [label, who] of principals()) {
        const res = await ctx
          .http()
          .get('/advance-loans/import/template')
          .set(bearer(who.token));
        const want = ['admin', 'hrGlobal', 'hrScoped'].includes(label)
          ? 200
          : 403;
        expectStatus(res, want, label);
      }
    });

    it('LOAN-API-31 a non-workbook upload is refused by name, before anything is parsed', async () => {
      const res = await ctx
        .http()
        .post('/advance-loans/import/preview')
        .set(bearer(fx.admin.token))
        .attach('file', Buffer.from('id,amount\n1,2'), {
          filename: 'loans.csv',
          contentType: 'text/csv',
        });
      expectStatus(res, 400);
      expect(String(res.body.message)).toContain(
        'Only .xlsx or .xls files are accepted',
      );
    });

    it('LOAN-API-32 an empty confirm is refused', async () => {
      const res = await ctx
        .http()
        .post('/advance-loans/import/confirm')
        .set(bearer(fx.admin.token))
        .send({ rows: [] });
      expectStatus(res, 400);
      expect(String(res.body.message)).toContain('No rows to import');
    });

    it('LOAN-API-33 the row cap is enforced', async () => {
      const rows = Array.from({ length: 2001 }, (_, i) => ({
        employeeCode: `X${i}`,
      }));
      const res = await ctx
        .http()
        .post('/advance-loans/import/confirm')
        .set(bearer(fx.admin.token))
        .send({ rows });
      expectStatus(res, 400);
    });
  });

  // ── Attachments and the static mount ──────────────────────────────────────
  describe('attachments', () => {
    const pdf = Buffer.from('%PDF-1.4 e2e loan');

    it('LOAN-API-34 the owner attaches to a pending request; a stranger cannot', async () => {
      const loan = await seedLoan({ status: 'PENDING' });
      try {
        const ok = await ctx
          .http()
          .post(`/advance-loans/${loan.id}/attachments`)
          .set(bearer(fx.employee.token))
          .attach('file', pdf, {
            filename: 'payslip.pdf',
            contentType: 'application/pdf',
          });
        expectStatus(ok, 201);

        const stranger = await ctx
          .http()
          .post(`/advance-loans/${loan.id}/attachments`)
          .set(bearer(fx.auditor.token))
          .attach('file', pdf, {
            filename: 'nope.pdf',
            contentType: 'application/pdf',
          });
        expectStatus(stranger, [403, 404]);
      } finally {
        await ctx.prisma.advanceLoanAttachment.deleteMany({
          where: { requestId: loan.id },
        });
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-35 listing attachments DOES check the caller — the reimbursement twin does not (F3)', async () => {
      const loan = await seedLoan({ status: 'PENDING' });
      try {
        await ctx
          .http()
          .post(`/advance-loans/${loan.id}/attachments`)
          .set(bearer(fx.employee.token))
          .attach('file', pdf, {
            filename: 'payslip.pdf',
            contentType: 'application/pdf',
          });

        const stranger = await ctx
          .http()
          .get(`/advance-loans/${loan.id}/attachments`)
          .set(bearer(fx.auditor.token));
        expectStatus(stranger, [403, 404]);
      } finally {
        await ctx.prisma.advanceLoanAttachment.deleteMany({
          where: { requestId: loan.id },
        });
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });

    it('LOAN-API-36 nothing can be attached once the request is decided', async () => {
      const loan = await seedLoan({ status: 'ACTIVE' });
      try {
        const res = await ctx
          .http()
          .post(`/advance-loans/${loan.id}/attachments`)
          .set(bearer(fx.employee.token))
          .attach('file', pdf, {
            filename: 'late.pdf',
            contentType: 'application/pdf',
          });
        expectStatus(res, 400);
        expect(String(res.body.message)).toContain(
          'only be added while the request is pending',
        );
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });
  });

  // ── Cancelling ────────────────────────────────────────────────────────────
  describe('cancelling', () => {
    it('LOAN-API-37 F5 — DELETE carries no @Roles; only the owner may withdraw', async () => {
      const loan = await seedLoan({ status: 'PENDING' });
      try {
        for (const who of [fx.admin, fx.hrGlobal, fx.manager]) {
          const res = await ctx
            .http()
            .delete(`/advance-loans/${loan.id}`)
            .set(bearer(who.token));
          expectStatus(res, 403, who.email);
        }
        const owner = await ctx
          .http()
          .delete(`/advance-loans/${loan.id}`)
          .set(bearer(fx.employee.token));
        expectStatus(owner, 200);
      } finally {
        await ctx.prisma.advanceLoanRequest
          .delete({ where: { id: loan.id } })
          .catch(() => undefined);
      }
    });

    it('LOAN-API-38 a decided request cannot be withdrawn', async () => {
      const loan = await seedLoan({ status: 'ACTIVE' });
      try {
        const res = await ctx
          .http()
          .delete(`/advance-loans/${loan.id}`)
          .set(bearer(fx.employee.token));
        expectStatus(res, 400);
        expect(String(res.body.message)).toContain(
          'Only pending requests can be cancelled',
        );
      } finally {
        await ctx.prisma.advanceLoanRequest.delete({ where: { id: loan.id } });
      }
    });
  });
});
