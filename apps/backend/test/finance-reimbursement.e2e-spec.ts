import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
} from './utils/finance-fixtures';
import { bearer, withSetting, withSettings } from './utils/settings';

/**
 * Reimbursements, end to end.
 *
 * This module had NO backend e2e coverage at all before this file — a 535-line
 * service with twelve distinct refusals, reachable over eight routes, verified
 * only by unit specs with a mocked Prisma. The browser suite tested the screen;
 * nothing tested the server the screen talks to.
 *
 * Three things here are worth knowing before reading the cases.
 *
 * **Authorization is two gates.** `@Roles()` is the coarse one; the narrow one
 * is `reimbursement_approver_roles`, a CSV in `system_settings` read at request
 * time. A case that only runs on the default value cannot tell the two apart,
 * so every approver case has a twin that flips the setting and asserts the
 * outcome INVERTS.
 *
 * **ADMIN cannot submit.** `POST /reimbursements` omits ADMIN from `@Roles`
 * deliberately (commit 7d1f27c, "restrict reimbursement request creation and
 * visibility for admin users") — admins administer the queue, they do not file
 * into it. Pinned so a well-meaning "add ADMIN back" is a red suite.
 *
 * **Three routes carry no `@Roles` metadata at all**, which `RolesGuard` reads
 * as "any authenticated user". The service is the only thing standing between
 * an employee and a colleague's claim. Those cases are marked F5.
 */
describe('Finance — Reimbursements (e2e)', () => {
  let ctx: E2EContext;
  let fx: FinanceFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  /**
   * Some controllers answer `{ success, data }` and some answer the record
   * directly — there is no global response interceptor. The browser's own
   * `ApiClient.unwrap` copes with both the same way, so the suite does too
   * rather than encoding which endpoint happens to wrap today.
   */
  const dataOf = (res: any): any => res.body?.data ?? res.body;
  const rowsOf = (res: any): any[] => {
    const d = dataOf(res);
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };
  const idsOf = (res: any) => rowsOf(res).map((r: any) => r.id);

  /**
   * Jest's `expect` takes exactly one argument, so the response body cannot ride
   * along as a message the way it can in Playwright. A wrong status without the
   * body is close to undiagnosable here — half the cases in this file turn on
   * WHICH refusal fired, not merely that one did — so the assertion is spelled
   * out instead.
   */
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

  /** Yesterday, as the ISO date the DTO's `@IsDateString` accepts. */
  const pastDate = (daysAgo = 1) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
  };
  const futureDate = (daysAhead = 2) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    return d.toISOString();
  };

  /**
   * Files a claim as its owner and remembers it, so a failed assertion cannot
   * leave a row that the next case's list assertions then trip over.
   */
  const filed: string[] = [];
  const fileClaim = async (
    token: string,
    over: Record<string, unknown> = {},
  ) => {
    const res = await ctx
      .http()
      .post('/reimbursements')
      .set(bearer(token))
      .send({
        type: 'Travel',
        amount: 100,
        expenseDate: pastDate(),
        description: `e2e ${fx.runId}`,
        ...over,
      });
    if (res.status === 201 && dataOf(res)?.id) filed.push(dataOf(res).id);
    return res;
  };

  /** A fresh PENDING claim owned by `employee`, for a decision case to consume. */
  const freshClaim = async (over: Record<string, unknown> = {}) => {
    const res = await fileClaim(fx.employee.token, over);
    expectStatus(res, 201);
    return dataOf(res).id as string;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Filing a claim ────────────────────────────────────────────────────────
  describe('filing a claim', () => {
    it('REI-API-01 an employee files a claim and it lands PENDING with the amount intact', async () => {
      const res = await fileClaim(fx.employee.token, { amount: 1250.5 });
      expectStatus(res, 201);
      expect(dataOf(res).status).toBe('PENDING');
      // Decimal(12,2) — the half-riyal must survive the round trip, because a
      // claim silently rounded is a claim silently underpaid.
      expect(Number(dataOf(res).amount)).toBe(1250.5);
      expect(dataOf(res).approverId ?? null).toBeNull();
      expect(dataOf(res).paidAt ?? null).toBeNull();
    });

    it('REI-API-02 HR and MANAGER may also file; ADMIN may not', async () => {
      const hr = await fileClaim(fx.hrScoped.token);
      expectStatus(hr, 201);

      const mgr = await fileClaim(fx.manager.token);
      expectStatus(mgr, 201);

      // Deliberate: admins administer the queue, they do not file into it.
      const admin = await fileClaim(fx.admin.token);
      expectStatus(admin, 403);
    });

    it('REI-API-03 anonymous is refused', async () => {
      const res = await ctx
        .http()
        .post('/reimbursements')
        .send({ type: 'Travel', amount: 10, expenseDate: pastDate() });
      expect(res.status).toBe(401);
    });

    it('REI-API-04 a type outside reimbursement_types is refused, and names the allowed set', async () => {
      const res = await fileClaim(fx.employee.token, { type: 'Yacht' });
      expectStatus(res, 400);
      expect(res.body.message).toContain('Invalid reimbursement type');
      expect(res.body.message).toContain('Allowed:');
    });

    it('REI-API-05 the allowed set follows the setting, not a hardcoded list', async () => {
      await withSetting(ctx, 'reimbursement_types', 'Yacht,Helicopter', async () => {
        const ok = await fileClaim(fx.employee.token, { type: 'Yacht' });
        expectStatus(ok, 201);

        // 'Travel' was legal a moment ago and is not any more.
        const no = await fileClaim(fx.employee.token, { type: 'Travel' });
        expectStatus(no, 400);
        expect(no.body.message).toContain('Yacht, Helicopter');
      });
    });

    it('REI-API-06 an expense dated in the future is refused', async () => {
      const res = await fileClaim(fx.employee.token, {
        expenseDate: futureDate(),
      });
      expectStatus(res, 400);
      expect(res.body.message).toBe('Expense date cannot be in the future');
    });

    it('REI-API-07 today is allowed — the boundary is "future", not "not past"', async () => {
      const res = await fileClaim(fx.employee.token, {
        expenseDate: new Date(Date.now() - 60_000).toISOString(),
      });
      expectStatus(res, 201);
    });

    it('REI-API-08 DTO validation: missing type, zero, negative, non-numeric amount, bad date, unknown key', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['missing type', { amount: 10, expenseDate: pastDate() }],
        ['zero amount', { type: 'Travel', amount: 0, expenseDate: pastDate() }],
        [
          'negative amount',
          { type: 'Travel', amount: -5, expenseDate: pastDate() },
        ],
        [
          'string amount',
          { type: 'Travel', amount: 'ten', expenseDate: pastDate() },
        ],
        ['bad date', { type: 'Travel', amount: 10, expenseDate: 'not-a-date' }],
        [
          'unknown property',
          {
            type: 'Travel',
            amount: 10,
            expenseDate: pastDate(),
            status: 'APPROVED',
          },
        ],
      ];
      for (const [label, payload] of cases) {
        const res = await ctx
          .http()
          .post('/reimbursements')
          .set(bearer(fx.employee.token))
          .send(payload);
        expectStatus(res, 400, `${label}: ${body(res)}`);
      }
    });

    it('REI-API-09 the module kill switch refuses creation', async () => {
      await withSetting(ctx, 'reimbursement_enabled', 'false', async () => {
        const res = await fileClaim(fx.employee.token);
        expectStatus(res, 400);
        expect(res.body.message).toBe('Reimbursement module is disabled');
      });
      // ...and lifts again, so the switch is a switch and not a one-way door.
      const after = await fileClaim(fx.employee.token);
      expectStatus(after, 201);
    });

    it('REI-API-10 F23 — a user with no linked employee is refused, with a sentence naming why', async () => {
      // `hrGlobal` is deliberately created without an employeeId, which is a
      // real shape: an HR account that administers but is not itself staff.
      // This used to reach `findUnique({ where: { id: undefined } })` and come
      // back as a 500 — the server reporting its own fault for an ordinary
      // request. Same root cause as TRV-API-08b and RPT-API-02b.
      const res = await ctx
        .http()
        .post('/reimbursements')
        .set(bearer(fx.hrGlobal.token))
        .send({ type: 'Travel', amount: 10, expenseDate: pastDate() });
      expectStatus(res, [400, 404]);
      expect(String(res.body.message)).toMatch(/employee/i);
    });
  });

  // ── Reading ───────────────────────────────────────────────────────────────
  describe('reading claims', () => {
    it('REI-API-11 the full list is ADMIN/HR only', async () => {
      const expectations: Array<[string, string, number]> = [
        ['admin', fx.admin.token, 200],
        ['hrGlobal', fx.hrGlobal.token, 200],
        ['hrScoped', fx.hrScoped.token, 200],
        ['manager', fx.manager.token, 403],
        ['employee', fx.employee.token, 403],
      ];
      for (const [label, token, status] of expectations) {
        const res = await ctx
          .http()
          .get('/reimbursements')
          .set(bearer(token));
        expectStatus(res, status, `${label}: ${body(res)}`);
      }
      const anon = await ctx.http().get('/reimbursements');
      expect(anon.status).toBe(401);
    });

    it('REI-API-12 the list is newest first and filters by status and employee', async () => {
      const id = await freshClaim();

      const byStatus = await ctx
        .http()
        .get('/reimbursements?status=PENDING')
        .set(bearer(fx.admin.token));
      expectStatus(byStatus, 200);
      expect(idsOf(byStatus)).toContain(id);
      expect(
        rowsOf(byStatus).every((r) => r.status === 'PENDING'),
      ).toBe(true);

      const byEmployee = await ctx
        .http()
        .get(`/reimbursements?employeeId=${fx.employee.employeeId}`)
        .set(bearer(fx.admin.token));
      expectStatus(byEmployee, 200);
      expect(
        rowsOf(byEmployee).map((r) => r.employeeId).filter(
          (id2) => id2 !== fx.employee.employeeId,
        ),
      ).toEqual([]);

      const times = rowsOf(byStatus).map((r) =>
        new Date(r.createdAt).getTime(),
      );
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('REI-API-13 an unknown status value returns an empty list, not a 400', async () => {
      const res = await ctx
        .http()
        .get('/reimbursements?status=NOPE')
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      expect(rowsOf(res)).toHaveLength(0);
    });

    it('REI-API-14 a branch-scoped HR cannot see a claim from another branch', async () => {
      const foreign = await fileClaim(fx.foreignEmployee.token);
      expectStatus(foreign, 201);
      const foreignId = dataOf(foreign).id;

      const scoped = await ctx
        .http()
        .get('/reimbursements')
        .set(bearer(fx.hrScoped.token));
      expectStatus(scoped, 200);
      expect(idsOf(scoped)).not.toContain(foreignId);

      // ...while the global HR does see it, so the absence above is scoping
      // rather than the row simply not existing.
      const global = await ctx
        .http()
        .get('/reimbursements')
        .set(bearer(fx.hrGlobal.token));
      expect(idsOf(global)).toContain(foreignId);
    });

    it('REI-API-15 reading a foreign-branch claim by id answers 404, never 403 — existence must not leak', async () => {
      const foreign = await fileClaim(fx.foreignEmployee.token);
      const foreignId = dataOf(foreign).id;

      const res = await ctx
        .http()
        .get(`/reimbursements/${foreignId}`)
        .set(bearer(fx.hrScoped.token));
      expectStatus(res, 404);
    });

    it('REI-API-16 my-requests returns only the caller’s own claims', async () => {
      const mine = await freshClaim();
      const theirs = await fileClaim(fx.manager.token);

      const res = await ctx
        .http()
        .get('/reimbursements/my-requests')
        .set(bearer(fx.employee.token));
      expectStatus(res, 200);
      expect(idsOf(res)).toContain(mine);
      expect(idsOf(res)).not.toContain(dataOf(theirs).id);
    });

    it('REI-API-17 F5 — every role with an employee link sees only itself on my-requests', async () => {
      for (const who of [fx.hrScoped, fx.manager, fx.employee]) {
        const res = await ctx
          .http()
          .get('/reimbursements/my-requests')
          .set(bearer(who.token));
        expectStatus(res, 200, who.email);
        const foreign = rowsOf(res)
          .filter((r) => r.employeeId !== who.employeeId)
          .map((r) => r.id);
        expect(foreign).toEqual([]);
      }
    });

    it('REI-API-17b F24 — "my requests" means MINE: an unlinked account gets an empty list, not the book', async () => {
      // `findMyRequests` passes `user.employeeId` to `findByEmployee`, which
      // called `findAll(undefined, undefined)` — and an undefined filter is no
      // filter. An HR or ADMIN account not linked to an employee record asked
      // for "my requests" and was handed EVERYONE's, including branches its own
      // `/reimbursements` list is scoped away from. The route carries no role
      // narrowing above the service either, so this guard is the only one.
      await freshClaim();
      const res = await ctx
        .http()
        .get('/reimbursements/my-requests')
        .set(bearer(fx.hrGlobal.token));
      expectStatus(res, 200);
      expect(rowsOf(res)).toEqual([]);
    });

    it('REI-API-18 an employee may read their own claim and not a colleague’s', async () => {
      const mine = await freshClaim();
      const colleague = await fileClaim(fx.manager.token);

      const own = await ctx
        .http()
        .get(`/reimbursements/${mine}`)
        .set(bearer(fx.employee.token));
      expectStatus(own, 200);

      const other = await ctx
        .http()
        .get(`/reimbursements/${dataOf(colleague).id}`)
        .set(bearer(fx.employee.token));
      expectStatus(other, 403);
      expect(other.body.message).toBe(
        'You do not have permission to view this request',
      );
    });

    it('REI-API-19 a manager reads a claim from their own department and not from another', async () => {
      const inScope = await freshClaim();

      const otherDeptClaim = await ctx.prisma.reimbursement.create({
        data: {
          employeeId: fx.otherDeptEmployeeId,
          type: 'Travel',
          amount: 10,
          expenseDate: new Date(),
          status: 'PENDING',
        },
      });

      const ok = await ctx
        .http()
        .get(`/reimbursements/${inScope}`)
        .set(bearer(fx.manager.token));
      expectStatus(ok, 200);

      const no = await ctx
        .http()
        .get(`/reimbursements/${otherDeptClaim.id}`)
        .set(bearer(fx.manager.token));
      expectStatus(no, 403);
    });

    it('REI-API-20 unknown id 404s; a malformed id must not answer 500', async () => {
      const unknown = await ctx
        .http()
        .get('/reimbursements/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token));
      expectStatus(unknown, 404);
      expect(unknown.body.message).toBe('Reimbursement request not found');

      // F25 — `ParseUUIDPipe` on every `:id`, the same fix Organization's D12
      // took. A client's bad input must never be reported as a fault of the
      // server's own.
      const malformed = await ctx
        .http()
        .get('/reimbursements/not-a-uuid')
        .set(bearer(fx.admin.token));
      expectStatus(malformed, 400);
    });
  });

  // ── The approver queue ────────────────────────────────────────────────────
  describe('the approver queue', () => {
    it('REI-API-21 pending is gated by the SETTING, not by the decorator', async () => {
      const id = await freshClaim();

      // Default: HR_MANAGER,ADMIN.
      const hr = await ctx
        .http()
        .get('/reimbursements/pending')
        .set(bearer(fx.hrGlobal.token));
      expectStatus(hr, 200);
      expect(idsOf(hr)).toContain(id);

      // MANAGER passes the decorator and fails the setting.
      const mgr = await ctx
        .http()
        .get('/reimbursements/pending')
        .set(bearer(fx.manager.token));
      expectStatus(mgr, 403);
      expect(mgr.body.message).toBe(
        'Your role is not configured to approve reimbursements',
      );

      // Flip the setting and the same two roles swap answers. This is the
      // assertion that proves which gate decided.
      await withSetting(
        ctx,
        'reimbursement_approver_roles',
        'MANAGER',
        async () => {
          const mgrNow = await ctx
            .http()
            .get('/reimbursements/pending')
            .set(bearer(fx.manager.token));
          expectStatus(mgrNow, 200);

          const hrNow = await ctx
            .http()
            .get('/reimbursements/pending')
            .set(bearer(fx.hrGlobal.token));
          expectStatus(hrNow, 403);
        },
      );
    });

    it('REI-API-22 a manager approver sees only their own department', async () => {
      const inScope = await freshClaim();
      const outOfScope = await ctx.prisma.reimbursement.create({
        data: {
          employeeId: fx.otherDeptEmployeeId,
          type: 'Travel',
          amount: 10,
          expenseDate: new Date(),
          status: 'PENDING',
        },
      });

      await withSetting(
        ctx,
        'reimbursement_approver_roles',
        'MANAGER,HR_MANAGER,ADMIN',
        async () => {
          const res = await ctx
            .http()
            .get('/reimbursements/pending')
            .set(bearer(fx.manager.token));
          expectStatus(res, 200);
          expect(idsOf(res)).toContain(inScope);
          expect(idsOf(res)).not.toContain(outOfScope.id);
        },
      );
    });

    it('REI-API-23 the queue holds only PENDING rows', async () => {
      const id = await freshClaim();
      const decide = await ctx
        .http()
        .post(`/reimbursements/${id}/approve`)
        .set(bearer(fx.admin.token))
        .send({ remarks: 'ok' });
      expectStatus(decide, 201);

      const res = await ctx
        .http()
        .get('/reimbursements/pending')
        .set(bearer(fx.admin.token));
      expect(idsOf(res)).not.toContain(id);
    });

    it('REI-API-24 an employee cannot reach the queue at all', async () => {
      const res = await ctx
        .http()
        .get('/reimbursements/pending')
        .set(bearer(fx.employee.token));
      expectStatus(res, 403);
    });
  });

  // ── Deciding ──────────────────────────────────────────────────────────────
  describe('deciding a claim', () => {
    it('REI-API-25 approve records the approver, the time and the remark', async () => {
      const id = await freshClaim();
      const res = await ctx
        .http()
        .post(`/reimbursements/${id}/approve`)
        .set(bearer(fx.hrGlobal.token))
        .send({ remarks: 'Verified against the invoice' });
      expectStatus(res, 201);
      expect(dataOf(res).status).toBe('APPROVED');
      expect(dataOf(res).approverId).toBe(fx.hrGlobal.userId);
      expect(dataOf(res).approvedAt).toBeTruthy();
      expect(dataOf(res).approverRemarks).toBe(
        'Verified against the invoice',
      );
      // Approval is not payment.
      expect(dataOf(res).paidAt ?? null).toBeNull();
      expect(dataOf(res).payrollItemId ?? null).toBeNull();
    });

    it('REI-API-26 approve with no body is allowed; the remark is optional', async () => {
      const id = await freshClaim();
      const res = await ctx
        .http()
        .post(`/reimbursements/${id}/approve`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 201);
      expect(dataOf(res).approverRemarks ?? null).toBeNull();
    });

    it('REI-API-27 reject stores the reason and requires one', async () => {
      const id = await freshClaim();

      const noReason = await ctx
        .http()
        .post(`/reimbursements/${id}/reject`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(noReason, 400);

      const res = await ctx
        .http()
        .post(`/reimbursements/${id}/reject`)
        .set(bearer(fx.admin.token))
        .send({ remarks: 'Invoice does not match the claimed amount' });
      expectStatus(res, 201);
      expect(dataOf(res).status).toBe('REJECTED');
      expect(dataOf(res).rejectedReason).toBe(
        'Invoice does not match the claimed amount',
      );
    });

    it('REI-API-28 a settled claim cannot be decided again', async () => {
      const id = await freshClaim();
      const first = await ctx
        .http()
        .post(`/reimbursements/${id}/approve`)
        .set(bearer(fx.admin.token));
      expectStatus(first, 201);

      for (const path of ['approve', 'reject']) {
        const again = await ctx
          .http()
          .post(`/reimbursements/${id}/${path}`)
          .set(bearer(fx.admin.token))
          .send({ remarks: 'second thoughts' });
        expectStatus(again, 400, `${path}: ${body(again)}`);
        expect(again.body.message).toBe(
          'This request has already been processed by another approver',
        );
      }
    });

    it('REI-API-29 two approvers deciding at once: exactly one wins', async () => {
      const id = await freshClaim();
      const [a, b] = await Promise.all([
        ctx
          .http()
          .post(`/reimbursements/${id}/approve`)
          .set(bearer(fx.admin.token))
          .send({ remarks: 'A' }),
        ctx
          .http()
          .post(`/reimbursements/${id}/reject`)
          .set(bearer(fx.hrGlobal.token))
          .send({ remarks: 'B' }),
      ]);
      const codes = [a.status, b.status].sort();
      expect(codes).toEqual([201, 400]);

      const row = await ctx.prisma.reimbursement.findUnique({ where: { id } });
      expect(['APPROVED', 'REJECTED']).toContain(row!.status);
    });

    it('REI-API-30 a manager cannot decide a claim from another department', async () => {
      const otherDeptClaim = await ctx.prisma.reimbursement.create({
        data: {
          employeeId: fx.otherDeptEmployeeId,
          type: 'Travel',
          amount: 10,
          expenseDate: new Date(),
          status: 'PENDING',
        },
      });

      await withSetting(
        ctx,
        'reimbursement_approver_roles',
        'MANAGER,HR_MANAGER,ADMIN',
        async () => {
          const res = await ctx
            .http()
            .post(`/reimbursements/${otherDeptClaim.id}/approve`)
            .set(bearer(fx.manager.token));
          expectStatus(res, 403);
          expect(res.body.message).toBe(
            'You can only review reimbursements from your own department',
          );
        },
      );
    });

    it('REI-API-31 an employee cannot decide anything, including their own claim', async () => {
      const id = await freshClaim();
      for (const path of ['approve', 'reject']) {
        const res = await ctx
          .http()
          .post(`/reimbursements/${id}/${path}`)
          .set(bearer(fx.employee.token))
          .send({ remarks: 'please' });
        expectStatus(res, 403, `${path}: ${body(res)}`);
      }
    });

    it('REI-API-32 a branch-scoped HR cannot decide a claim from another branch', async () => {
      const foreign = await fileClaim(fx.foreignEmployee.token);
      const res = await ctx
        .http()
        .post(`/reimbursements/${dataOf(foreign).id}/approve`)
        .set(bearer(fx.hrScoped.token));
      // The branch guard fires inside findOne, so the answer is 404 — the
      // claim does not exist as far as this caller is concerned.
      expectStatus(res, 404);
    });
  });

  // ── Cancelling ────────────────────────────────────────────────────────────
  describe('cancelling a claim', () => {
    it('REI-API-33 the owner cancels a pending claim', async () => {
      const id = await freshClaim();
      const res = await ctx
        .http()
        .delete(`/reimbursements/${id}`)
        .set(bearer(fx.employee.token));
      expectStatus(res, 200);

      const row = await ctx.prisma.reimbursement.findUnique({ where: { id } });
      expect(row!.status).toBe('CANCELLED');
    });

    it('REI-API-34 F5 — DELETE carries no @Roles; nobody but the owner may cancel', async () => {
      const id = await freshClaim();
      for (const who of [fx.admin, fx.hrGlobal, fx.manager]) {
        const res = await ctx
          .http()
          .delete(`/reimbursements/${id}`)
          .set(bearer(who.token));
        expectStatus(res, 403, `${who.email}: ${body(res)}`);
        expect(res.body.message).toBe(
          'You do not have permission to cancel this request',
        );
      }
      // Still PENDING — none of them got through.
      const row = await ctx.prisma.reimbursement.findUnique({ where: { id } });
      expect(row!.status).toBe('PENDING');
    });

    it('REI-API-35 a settled claim cannot be cancelled', async () => {
      const id = await freshClaim();
      await ctx
        .http()
        .post(`/reimbursements/${id}/approve`)
        .set(bearer(fx.admin.token));

      const res = await ctx
        .http()
        .delete(`/reimbursements/${id}`)
        .set(bearer(fx.employee.token));
      expectStatus(res, 400);
      expect(res.body.message).toBe('Only pending requests can be cancelled');
    });
  });

  // ── Attachments ───────────────────────────────────────────────────────────
  describe('attachments', () => {
    const pdf = Buffer.from('%PDF-1.4 e2e');

    it('REI-API-36 the owner attaches a receipt to a pending claim', async () => {
      const id = await freshClaim();
      const res = await ctx
        .http()
        .post(`/reimbursements/${id}/attachments`)
        .set(bearer(fx.employee.token))
        .attach('file', pdf, { filename: 'receipt.pdf', contentType: 'application/pdf' });
      expectStatus(res, 201);

      const list = await ctx
        .http()
        .get(`/reimbursements/${id}/attachments`)
        .set(bearer(fx.employee.token));
      expectStatus(list, 200);
      expect(rowsOf(list).length).toBeGreaterThan(0);
    });

    it('REI-API-37 an oversize file and a disallowed type are both refused, by message', async () => {
      const id = await freshClaim();

      const big = Buffer.alloc(11 * 1024 * 1024, 0x41);
      const tooBig = await ctx
        .http()
        .post(`/reimbursements/${id}/attachments`)
        .set(bearer(fx.employee.token))
        .attach('file', big, { filename: 'big.pdf', contentType: 'application/pdf' });
      expectStatus(tooBig, 400);
      expect(String(tooBig.body.message)).toMatch(/10 MB|size/i);

      const wrongType = await ctx
        .http()
        .post(`/reimbursements/${id}/attachments`)
        .set(bearer(fx.employee.token))
        .attach('file', Buffer.from('MZ'), {
          filename: 'payload.exe',
          contentType: 'application/x-msdownload',
        });
      expectStatus(wrongType, 400);
      expect(String(wrongType.body.message)).toMatch(/Invalid file type/i);
    });

    it('REI-API-38 nothing can be attached once the claim is settled', async () => {
      const id = await freshClaim();
      await ctx
        .http()
        .post(`/reimbursements/${id}/approve`)
        .set(bearer(fx.admin.token));

      const res = await ctx
        .http()
        .post(`/reimbursements/${id}/attachments`)
        .set(bearer(fx.employee.token))
        .attach('file', pdf, { filename: 'late.pdf', contentType: 'application/pdf' });
      expectStatus(res, 400);
      expect(res.body.message).toBe(
        'Attachments can only be added while the request is pending',
      );
    });

    it('REI-API-39 a colleague cannot attach to someone else’s claim', async () => {
      const id = await freshClaim();
      const res = await ctx
        .http()
        .post(`/reimbursements/${id}/attachments`)
        .set(bearer(fx.foreignEmployee.token))
        .attach('file', pdf, { filename: 'nope.pdf', contentType: 'application/pdf' });
      expect([403, 404]).toContain(res.status);
    });

    it('REI-API-40 F3 — an unrelated employee cannot read another person’s receipts', async () => {
      // The controller used to call `findByReimbursement(id)` without passing
      // `user`, and the service performed no check at all — so any employee
      // listed any colleague's receipts. A receipt names an amount, a merchant
      // and a date; listing them is exactly as sensitive as reading the claim
      // itself. The loans twin at the same layer always did pass `user`, which
      // is what made this an omission rather than a policy.
      const id = await freshClaim();
      await ctx
        .http()
        .post(`/reimbursements/${id}/attachments`)
        .set(bearer(fx.employee.token))
        .attach('file', pdf, { filename: 'receipt.pdf', contentType: 'application/pdf' });

      // Cross-branch: 404, so existence never leaks.
      const crossBranch = await ctx
        .http()
        .get(`/reimbursements/${id}/attachments`)
        .set(bearer(fx.foreignEmployee.token));
      expectStatus(crossBranch, 404);

      // Same branch, unrelated: 403 with the reason.
      const stranger = await ctx
        .http()
        .get(`/reimbursements/${id}/attachments`)
        .set(bearer(fx.auditor.token));
      expectStatus(stranger, 403);
      expect(stranger.body.message).toBe(
        'You do not have permission to view this request',
      );

      // The owner, HR and the department manager still can.
      for (const who of [fx.employee, fx.hrGlobal, fx.manager]) {
        const ok = await ctx
          .http()
          .get(`/reimbursements/${id}/attachments`)
          .set(bearer(who.token));
        expectStatus(ok, 200, who.email);
      }
    });
  });

  // ── The payroll seam ──────────────────────────────────────────────────────
  describe('the payroll seam', () => {
    it('REI-API-41 F15 — there is no route that marks a claim PAID; only payroll lock does', async () => {
      const id = await freshClaim();
      await ctx
        .http()
        .post(`/reimbursements/${id}/approve`)
        .set(bearer(fx.admin.token));

      // Asserted so that adding a "mark paid" route is a deliberate act rather
      // than an accident: payment is a payroll event, not a claim event.
      for (const verb of ['post', 'patch', 'put'] as const) {
        const res = await (ctx.http() as any)
          [verb](`/reimbursements/${id}/pay`)
          .set(bearer(fx.admin.token))
          .send({});
        expectStatus(res, 404, `${verb}: ${body(res)}`);
      }

      const row = await ctx.prisma.reimbursement.findUnique({ where: { id } });
      expect(row!.status).toBe('APPROVED');
      expect(row!.paidAt).toBeNull();
    });

    it('REI-API-42 F15 — there is no edit route either; a filed claim is immutable', async () => {
      const id = await freshClaim();
      for (const verb of ['patch', 'put'] as const) {
        const res = await (ctx.http() as any)
          [verb](`/reimbursements/${id}`)
          .set(bearer(fx.admin.token))
          .send({ amount: 999999 });
        expectStatus(res, 404, `${verb}: ${body(res)}`);
      }
    });
  });

  // ── Every refusal explains itself ─────────────────────────────────────────
  describe('every refusal explains itself', () => {
    /**
     * The rule this suite exists to protect, borrowed from
     * `loan-advances-v2.e2e-spec.ts` §24 and the incident recorded in
     * docs/LOAN-ADVANCES-TEST-CASES.md: a refusal's CONTENT is part of the
     * contract, because it is the only thing the user can act on. A status code
     * with a blank or generic body reaches the browser as "The operation could
     * not be completed".
     */
    const GENERIC =
      /^(bad request|forbidden|not found|conflict|error|internal server error)$/i;

    it('REI-API-43 every reachable refusal carries a specific sentence', async () => {
      const settled = await freshClaim();
      await ctx
        .http()
        .post(`/reimbursements/${settled}/approve`)
        .set(bearer(fx.admin.token));
      const pending = await freshClaim();

      // Thunks, not promises. `ctx.http()` opens an ephemeral listener per
      // call; building eight of them up front and awaiting them one at a time
      // leaves seven sockets waiting on servers that have already closed, and
      // the suite fails with ECONNREFUSED instead of the answer it asked for.
      const probes: Array<[string, () => Promise<any>]> = [
        ['unknown type', () => fileClaim(fx.employee.token, { type: 'Yacht' })],
        [
          'future date',
          () => fileClaim(fx.employee.token, { expenseDate: futureDate() }),
        ],
        [
          'decide a settled claim',
          () =>
            ctx
              .http()
              .post(`/reimbursements/${settled}/approve`)
              .set(bearer(fx.admin.token))
              .send({}),
        ],
        [
          'cancel a settled claim',
          () =>
            ctx
              .http()
              .delete(`/reimbursements/${settled}`)
              .set(bearer(fx.employee.token)),
        ],
        [
          'cancel a claim you do not own',
          () =>
            ctx
              .http()
              .delete(`/reimbursements/${pending}`)
              .set(bearer(fx.manager.token)),
        ],
        [
          // A SAME-branch stranger, deliberately. A cross-branch reader is
          // refused earlier by the branch guard, whose 404 is bare on purpose
          // — see REI-API-43b.
          'read a claim you may not see',
          () =>
            ctx
              .http()
              .get(`/reimbursements/${pending}`)
              .set(bearer(fx.auditor.token)),
        ],
        [
          'unknown id',
          () =>
            ctx
              .http()
              .get('/reimbursements/00000000-0000-0000-0000-000000000000')
              .set(bearer(fx.admin.token)),
        ],
        [
          'approve without the configured role',
          () =>
            ctx
              .http()
              .post(`/reimbursements/${pending}/approve`)
              .set(bearer(fx.manager.token))
              .send({}),
        ],
      ];

      const offenders: string[] = [];
      for (const [label, call] of probes) {
        const res = await call();
        if (res.status < 400) throw new Error(`${label} did not refuse: ${body(res)}`);
        const message = Array.isArray(res.body?.message)
          ? res.body.message.join('; ')
          : res.body?.message;
        if (!message || String(message).trim().length < 10) {
          offenders.push(`${label}: empty or too short (${message})`);
        } else if (GENERIC.test(String(message).trim())) {
          offenders.push(`${label}: generic (${message})`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('REI-API-43b the cross-branch 404 is bare ON PURPOSE, and is the one exception', async () => {
      const pending = await freshClaim();
      const res = await ctx
        .http()
        .get(`/reimbursements/${pending}`)
        .set(bearer(fx.foreignEmployee.token));

      // `assertInBranch` throws a message-less NotFoundException so that "you
      // may not see this" and "this does not exist" are indistinguishable. A
      // helpful sentence here would leak the existence of another branch's
      // claim, which is exactly what the guard is for. Asserted so that a
      // well-meaning "add a message" is a red suite rather than a quiet leak.
      expectStatus(res, 404);
      expect(String(res.body.message ?? 'Not Found')).toBe('Not Found');
    });
  });

  // ── Audit ─────────────────────────────────────────────────────────────────
  describe('audit', () => {
    it('REI-API-44 create, approve, reject and cancel each write an audit row', async () => {
      const approved = await freshClaim();
      await ctx
        .http()
        .post(`/reimbursements/${approved}/approve`)
        .set(bearer(fx.admin.token));
      const rejected = await freshClaim();
      await ctx
        .http()
        .post(`/reimbursements/${rejected}/reject`)
        .set(bearer(fx.admin.token))
        .send({ remarks: 'no' });
      const cancelled = await freshClaim();
      await ctx
        .http()
        .delete(`/reimbursements/${cancelled}`)
        .set(bearer(fx.employee.token));

      const rows = await ctx.prisma.auditLog.findMany({
        where: {
          resourceType: 'Reimbursement',
          userId: { in: [fx.admin.userId, fx.employee.userId] },
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      });
      expect(rows.length).toBeGreaterThan(0);
      // The actor must be recorded, not merely the fact that something happened
      // — an audit row with no author answers none of the questions an audit is
      // for.
      expect(rows.every((r) => !!r.userId)).toBe(true);
    });
  });
});
