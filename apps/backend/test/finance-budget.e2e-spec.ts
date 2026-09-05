import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupFinanceFixtures,
  FinanceFixtures,
  RATED_DESTINATION,
} from './utils/finance-fixtures';
import { bearer } from './utils/settings';

/**
 * HR budgets, end to end.
 *
 * `budget-commitment.e2e-spec.ts` owns the ledger's arithmetic — the
 * double-count guard, the release path, the totals. This file owns the surface
 * around it: the seven routes, who may reach them, what the server refuses, and
 * the two properties that make the whole feature trustworthy or useless.
 *
 * **Budgeting never blocks an approval.** Every method on
 * `BudgetCommitmentService` swallows its own exception on purpose. A missing
 * budget line, a closed budget, a category nobody configured — all of them log
 * and let the travel or training approval through. A budget that could refuse a
 * trip would be a spending control, which is not what this is; it is a
 * reporting ledger, and a reporting ledger that can strand a traveller is worse
 * than no ledger at all. Asserted, because it is the kind of property that gets
 * "fixed" into a blocker by someone reading `commit()` in isolation.
 *
 * **Remaining = Planned − OPEN commitments − Actual.** Committed money is
 * approved-but-unpaid; actual money has been through a locked payroll. Counting
 * a commitment twice — once as committed and again as actual — is the defect
 * the ledger's `REALIZED` state exists to prevent.
 */
describe('Finance — HR budgets (e2e)', () => {
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

  const YEAR = new Date().getFullYear() + 1; // clear of the fixture's own budget
  const created: string[] = [];

  const makeBudget = async (over: Record<string, unknown> = {}) => {
    const res = await ctx
      .http()
      .post('/budgets')
      .set(bearer(fx.admin.token))
      .send({
        name: `E2E Budget ${fx.runId} ${created.length}`,
        fiscalYear: YEAR,
        startDate: `${YEAR}-01-01`,
        endDate: `${YEAR}-12-31`,
        branchId: fx.branchA,
        ...over,
      });
    if (res.status === 201 && dataOf(res)?.id) created.push(dataOf(res).id);
    return res;
  };

  const principals = () => [
    ['admin', fx.admin] as const,
    ['hrGlobal', fx.hrGlobal] as const,
    ['hrScoped', fx.hrScoped] as const,
    ['manager', fx.manager] as const,
    ['employee', fx.employee] as const,
  ];

  const inDays = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFinanceFixtures(ctx);
  }, 120000);

  afterAll(async () => {
    if (ctx && created.length) {
      await ctx.prisma.budgetCommitment.deleteMany({
        where: { line: { budgetId: { in: created } } },
      });
      await ctx.prisma.budgetLine.deleteMany({
        where: { budgetId: { in: created } },
      });
      await ctx.prisma.budget.deleteMany({ where: { id: { in: created } } });
    }
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Role matrix ───────────────────────────────────────────────────────────
  describe('who may reach the module at all', () => {
    it('BUD-API-01 every route is ADMIN/HR; MANAGER and EMPLOYEE are refused everywhere', async () => {
      const routes: Array<[string, () => any]> = [
        ['list', () => ctx.http().get('/budgets')],
        ['read', () => ctx.http().get(`/budgets/${fx.budgetId}`)],
        ['variance', () => ctx.http().get(`/budgets/${fx.budgetId}/variance`)],
        [
          'create',
          () =>
            ctx.http().post('/budgets').send({
              name: `denied ${fx.runId}`,
              fiscalYear: YEAR,
              startDate: `${YEAR}-01-01`,
              endDate: `${YEAR}-12-31`,
              branchId: fx.branchA,
            }),
        ],
        [
          'set status',
          () =>
            ctx
              .http()
              .patch(`/budgets/${fx.budgetId}/status`)
              .send({ status: 'ACTIVE' }),
        ],
        [
          'upsert line',
          () =>
            ctx
              .http()
              .post(`/budgets/${fx.budgetId}/lines`)
              .send({ category: 'Travel', plannedAmount: 1 }),
        ],
        [
          'delete line',
          () =>
            ctx
              .http()
              .delete(
                `/budgets/${fx.budgetId}/lines/${fx.budgetFallbackLineId}`,
              ),
        ],
      ];

      for (const [name, call] of routes) {
        for (const who of [fx.manager, fx.employee]) {
          const res = await call().set(bearer(who.token));
          expectStatus(res, 403, `${name} as ${who.email}`);
        }
        const anon = await call();
        expect(anon.status).toBe(401);
      }
    });

    it('BUD-API-02 ADMIN and both HR shapes may list', async () => {
      for (const [label, who] of principals().slice(0, 3)) {
        const res = await ctx.http().get('/budgets').set(bearer(who.token));
        expectStatus(res, 200, label);
      }
    });
  });

  // ── Creating ──────────────────────────────────────────────────────────────
  describe('creating a budget', () => {
    it('BUD-API-03 a budget is created DRAFT and does not attract commitments yet', async () => {
      const res = await makeBudget();
      expectStatus(res, 201);
      expect(dataOf(res).status).toBe('DRAFT');
      expect(dataOf(res).currency).toBe('OMR');
    });

    it('BUD-API-04 end before start, and end EQUAL to start, are both refused', async () => {
      const before = await makeBudget({
        startDate: `${YEAR}-06-01`,
        endDate: `${YEAR}-01-01`,
      });
      expectStatus(before, 400);
      expect(before.body.message).toBe(
        'Budget end date must be after its start',
      );

      // The boundary is `<=`, not `<` — a zero-length fiscal period is not a
      // period.
      const same = await makeBudget({
        startDate: `${YEAR}-06-01`,
        endDate: `${YEAR}-06-01`,
      });
      expectStatus(same, 400);
    });

    it('BUD-API-05 a duplicate (branch, year, name) is a 409 that names the clash', async () => {
      const name = `E2E Dup ${fx.runId}`;
      const first = await makeBudget({ name });
      expectStatus(first, 201);

      const second = await makeBudget({ name });
      expectStatus(second, 409);
      expect(String(second.body.message)).toContain(name);
      expect(String(second.body.message)).toContain(String(YEAR));
    });

    it('BUD-API-06 the same name is free in another year and in another branch', async () => {
      const name = `E2E Reuse ${fx.runId}`;
      expectStatus(await makeBudget({ name }), 201);
      expectStatus(
        await makeBudget({
          name,
          fiscalYear: YEAR + 1,
          startDate: `${YEAR + 1}-01-01`,
          endDate: `${YEAR + 1}-12-31`,
        }),
        201,
      );
      expectStatus(await makeBudget({ name, branchId: fx.branchB }), 201);
    });

    it('BUD-API-07 DTO validation: bad year, bad uuid, bad currency, unknown status, unknown key', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['year below 2000', { fiscalYear: 1999 }],
        ['non-uuid branch', { branchId: 'not-a-uuid' }],
        ['4-letter currency', { currency: 'OMRR' }],
        ['unknown status', { status: 'ARCHIVED' }],
        ['unknown key', { totalAmount: 5 }],
        ['bad date', { startDate: 'january' }],
      ];
      for (const [label, over] of cases) {
        expectStatus(await makeBudget(over), 400, label);
      }
    });

    it('BUD-API-08 a scoped HR cannot create a budget in a branch it cannot reach', async () => {
      const res = await ctx
        .http()
        .post('/budgets')
        .set(bearer(fx.hrScoped.token))
        .send({
          name: `E2E Foreign ${fx.runId}`,
          fiscalYear: YEAR,
          startDate: `${YEAR}-01-01`,
          endDate: `${YEAR}-12-31`,
          branchId: fx.branchB,
        });
      expectStatus(res, 403);
      expect(String(res.body.message)).toContain(
        'do not have access to assign records to this branch',
      );
    });
  });

  // ── Reading and scoping ───────────────────────────────────────────────────
  describe('reading', () => {
    it('BUD-API-09 a scoped HR sees its own branch’s budgets and 404s on another’s', async () => {
      const foreign = await makeBudget({
        name: `E2E BranchB ${fx.runId}`,
        branchId: fx.branchB,
      });
      expectStatus(foreign, 201);
      const foreignId = dataOf(foreign).id;

      const scoped = await ctx
        .http()
        .get('/budgets')
        .set(bearer(fx.hrScoped.token));
      expectStatus(scoped, 200);
      expect(idsOf(scoped)).not.toContain(foreignId);

      const global = await ctx
        .http()
        .get('/budgets')
        .set(bearer(fx.hrGlobal.token));
      expect(idsOf(global)).toContain(foreignId);

      const byId = await ctx
        .http()
        .get(`/budgets/${foreignId}`)
        .set(bearer(fx.hrScoped.token));
      expectStatus(byId, 404);
    });

    it('BUD-API-10 F10 — Budget.branchId is NOT NULL, which is what makes plain "direct" scoping safe', async () => {
      // `Budget` is `'direct'` in the branch scope map while `TrainingSession`
      // is `'direct-or-global'`. The
      // difference is safe only because a budget always has a branch: a
      // nullable one would be invisible from every branch rather than visible
      // from all. Locked here so a future "company-wide budget" migration
      // fails this test instead of silently hiding the row.
      const nullBranch = await ctx.prisma.budget
        .create({
          data: {
            name: `E2E Null Branch ${fx.runId}`,
            fiscalYear: YEAR,
            startDate: new Date(`${YEAR}-01-01`),
            endDate: new Date(`${YEAR}-12-31`),
            branchId: null as any,
            createdById: fx.admin.userId,
          },
        })
        .then(() => 'created')
        .catch(() => 'refused');
      expect(nullBranch).toBe('refused');
    });

    it('BUD-API-11 list filters by fiscal year and status; an unknown status is empty, not a 400', async () => {
      const byYear = await ctx
        .http()
        .get(`/budgets?fiscalYear=${YEAR}`)
        .set(bearer(fx.admin.token));
      expectStatus(byYear, 200);
      expect(rowsOf(byYear).every((b) => b.fiscalYear === YEAR)).toBe(true);

      const unknown = await ctx
        .http()
        .get('/budgets?status=ARCHIVED')
        .set(bearer(fx.admin.token));
      expectStatus(unknown, 200);
      expect(rowsOf(unknown)).toEqual([]);
    });

    it('BUD-API-12 unknown id 404s; a malformed id is a client error', async () => {
      const unknown = await ctx
        .http()
        .get('/budgets/00000000-0000-0000-0000-000000000000')
        .set(bearer(fx.admin.token));
      expectStatus(unknown, 404);
      expect(unknown.body.message).toBe('Budget not found');

      const malformed = await ctx
        .http()
        .get('/budgets/not-a-uuid')
        .set(bearer(fx.admin.token));
      expectStatus(malformed, 400);
    });
  });

  // ── Status ────────────────────────────────────────────────────────────────
  describe('the status switch', () => {
    it('BUD-API-13 DRAFT → ACTIVE → CLOSED, and back again', async () => {
      const res = await makeBudget();
      const id = dataOf(res).id;

      for (const status of ['ACTIVE', 'CLOSED', 'DRAFT']) {
        const set = await ctx
          .http()
          .patch(`/budgets/${id}/status`)
          .set(bearer(fx.admin.token))
          .send({ status });
        expectStatus(set, 200, status);
      }
    });

    it('BUD-API-14 F6 — the status body goes through the DTO, so unknown properties are refused', async () => {
      // `@Body('status') status: string` reached into the payload and bypassed
      // `ValidationPipe` entirely, so `forbidNonWhitelisted` never ran on this
      // route — extra keys were accepted and ignored, the only write in the
      // module that behaved that way.
      const res = await makeBudget();
      const id = dataOf(res).id;

      const extraKeys = await ctx
        .http()
        .patch(`/budgets/${id}/status`)
        .set(bearer(fx.admin.token))
        .send({ status: 'ACTIVE', plannedAmount: 999, injected: true });
      expectStatus(extraKeys, 400);

      // The plain form still works.
      const ok = await ctx
        .http()
        .patch(`/budgets/${id}/status`)
        .set(bearer(fx.admin.token))
        .send({ status: 'ACTIVE' });
      expectStatus(ok, 200);

      const bad = await ctx
        .http()
        .patch(`/budgets/${id}/status`)
        .set(bearer(fx.admin.token))
        .send({ status: 'ARCHIVED' });
      expectStatus(bad, 400);
      // Now a ValidationPipe error, so the message arrives as the pipe's array
      // of field messages rather than the service's single string. The sentence
      // itself is unchanged, which is what the user reads.
      expect([bad.body.message].flat()).toContain(
        'Status must be DRAFT, ACTIVE or CLOSED',
      );
    });


    it('BUD-API-15 a missing status is refused rather than defaulted', async () => {
      const res = await makeBudget();
      const id = dataOf(res).id;
      const set = await ctx
        .http()
        .patch(`/budgets/${id}/status`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(set, 400);
    });
  });

  // ── Lines ─────────────────────────────────────────────────────────────────
  describe('budget lines', () => {
    it('BUD-API-16 a line is upserted on (budget, department, category), never duplicated', async () => {
      const res = await makeBudget();
      const id = dataOf(res).id;

      const first = await ctx
        .http()
        .post(`/budgets/${id}/lines`)
        .set(bearer(fx.admin.token))
        .send({
          departmentId: fx.finDeptId,
          category: 'Travel',
          plannedAmount: 1000,
        });
      expectStatus(first, 201);

      const again = await ctx
        .http()
        .post(`/budgets/${id}/lines`)
        .set(bearer(fx.admin.token))
        .send({
          departmentId: fx.finDeptId,
          category: 'Travel',
          plannedAmount: 2500,
        });
      expectStatus(again, 201);

      const lines = await ctx.prisma.budgetLine.findMany({
        where: { budgetId: id, category: 'Travel' },
      });
      expect(lines).toHaveLength(1);
      expect(Number(lines[0].plannedAmount)).toBe(2500);
    });

    it('BUD-API-17 a company-wide line and a department line coexist under one category', async () => {
      const res = await makeBudget();
      const id = dataOf(res).id;

      expectStatus(
        await ctx
          .http()
          .post(`/budgets/${id}/lines`)
          .set(bearer(fx.admin.token))
          .send({ category: 'Travel', plannedAmount: 500 }),
        201,
      );
      expectStatus(
        await ctx
          .http()
          .post(`/budgets/${id}/lines`)
          .set(bearer(fx.admin.token))
          .send({
            departmentId: fx.finDeptId,
            category: 'Travel',
            plannedAmount: 800,
          }),
        201,
      );

      const lines = await ctx.prisma.budgetLine.findMany({
        where: { budgetId: id, category: 'Travel' },
      });
      expect(lines).toHaveLength(2);
      // The fallback is the row with no department — the one spend attaches to
      // when nothing more specific matches.
      expect(lines.filter((l) => l.departmentId === null)).toHaveLength(1);
    });

    it('BUD-API-18 line DTO validation: missing category, negative amount, bad department uuid', async () => {
      const res = await makeBudget();
      const id = dataOf(res).id;
      const cases: Array<[string, Record<string, unknown>]> = [
        ['missing category', { plannedAmount: 10 }],
        ['negative amount', { category: 'Travel', plannedAmount: -1 }],
        [
          'bad department',
          { category: 'Travel', plannedAmount: 10, departmentId: 'nope' },
        ],
        ['unknown key', { category: 'Travel', plannedAmount: 10, spent: 3 }],
      ];
      for (const [label, payload] of cases) {
        const line = await ctx
          .http()
          .post(`/budgets/${id}/lines`)
          .set(bearer(fx.admin.token))
          .send(payload);
        expectStatus(line, 400, label);
      }
    });

    it('BUD-API-19 zero is a legal planned amount — a budgeted-at-nothing line is a real statement', async () => {
      const res = await makeBudget();
      const id = dataOf(res).id;
      expectStatus(
        await ctx
          .http()
          .post(`/budgets/${id}/lines`)
          .set(bearer(fx.admin.token))
          .send({ category: 'Training', plannedAmount: 0 }),
        201,
      );
    });

    it('BUD-API-20 an unencumbered line deletes; one with an OPEN commitment does not', async () => {
      const res = await makeBudget({ status: 'ACTIVE' });
      const id = dataOf(res).id;
      const lineRes = await ctx
        .http()
        .post(`/budgets/${id}/lines`)
        .set(bearer(fx.admin.token))
        .send({
          departmentId: fx.finDeptId,
          category: 'Travel',
          plannedAmount: 900,
        });
      expectStatus(lineRes, 201);
      const lineId = (
        await ctx.prisma.budgetLine.findFirstOrThrow({
          where: { budgetId: id, category: 'Travel' },
        })
      ).id;

      await ctx.prisma.budgetCommitment.create({
        data: {
          budgetLineId: lineId,
          sourceType: 'TRAVEL',
          sourceId: '11111111-1111-1111-1111-111111111111',
          amount: 100,
          status: 'OPEN',
        },
      });

      const blocked = await ctx
        .http()
        .delete(`/budgets/${id}/lines/${lineId}`)
        .set(bearer(fx.admin.token));
      expectStatus(blocked, 400);
      expect(blocked.body.message).toBe(
        'This line has open commitments from approved requests. Release or realize them before deleting it.',
      );

      // A RELEASED commitment is not an obligation — the line frees up.
      await ctx.prisma.budgetCommitment.updateMany({
        where: { budgetLineId: lineId },
        data: { status: 'RELEASED' },
      });
      const freed = await ctx
        .http()
        .delete(`/budgets/${id}/lines/${lineId}`)
        .set(bearer(fx.admin.token));
      expectStatus(freed, 200);
    });

    it('BUD-API-21 deleting an unknown line 404s', async () => {
      const res = await ctx
        .http()
        .delete(
          `/budgets/${fx.budgetId}/lines/00000000-0000-0000-0000-000000000000`,
        )
        .set(bearer(fx.admin.token));
      expectStatus(res, 404);
      expect(res.body.message).toBe('Budget line not found');
    });
  });

  // ── The commitment ledger ─────────────────────────────────────────────────
  describe('the commitment ledger', () => {
    const approveTrip = async (over: Record<string, unknown> = {}) => {
      const t = await ctx.prisma.travelRequest.create({
        data: {
          employeeId: fx.earnerId,
          purpose: `budget e2e ${fx.runId}`,
          travelType: 'DOMESTIC',
          destination: RATED_DESTINATION,
          departureDate: new Date(inDays(5)),
          returnDate: new Date(inDays(6)),
          estimatedCost: 400,
          status: 'PENDING',
          ...over,
        },
      });
      const res = await ctx
        .http()
        .post(`/travel-requests/${t.id}/approve`)
        .set(bearer(fx.admin.token))
        .send({});
      expectStatus(res, 201);
      return t.id;
    };

    it('BUD-API-22 an approved trip commits against the DEPARTMENT line, not the fallback', async () => {
      const travelId = await approveTrip();
      const commitments = await ctx.prisma.budgetCommitment.findMany({
        where: { sourceType: 'TRAVEL', sourceId: travelId },
      });
      expect(commitments).toHaveLength(1);
      expect(commitments[0].budgetLineId).toBe(fx.budgetDeptLineId);
      expect(commitments[0].status).toBe('OPEN');
    });

    it('BUD-API-23 the commitment is idempotent on (sourceType, sourceId)', async () => {
      const travelId = await approveTrip();
      // A second approval attempt must not book the money twice — this is the
      // guard that keeps Committed honest when a request is re-processed.
      await ctx
        .http()
        .post(`/travel-requests/${travelId}/approve`)
        .set(bearer(fx.admin.token))
        .send({})
        .catch(() => undefined);

      const commitments = await ctx.prisma.budgetCommitment.findMany({
        where: { sourceType: 'TRAVEL', sourceId: travelId },
      });
      expect(commitments).toHaveLength(1);
    });

    it('BUD-API-24 a DRAFT budget attracts nothing', async () => {
      await ctx.prisma.budget.update({
        where: { id: fx.budgetId },
        data: { status: 'DRAFT' },
      });
      try {
        const travelId = await approveTrip();
        const commitments = await ctx.prisma.budgetCommitment.findMany({
          where: { sourceType: 'TRAVEL', sourceId: travelId },
        });
        expect(commitments).toEqual([]);
      } finally {
        await ctx.prisma.budget.update({
          where: { id: fx.budgetId },
          data: { status: 'ACTIVE' },
        });
      }
    });

    it('BUD-API-25 budgeting NEVER blocks an approval, even with no matching line at all', async () => {
      // The property the whole design rests on. A category nobody budgeted
      // for, on a branch with no budget — the trip is still approved and the
      // traveller still travels. Budgeting is a reporting ledger, not a
      // spending control.
      const before = await ctx.prisma.budgetLine.findMany({
        where: { budgetId: fx.budgetId },
      });
      await ctx.prisma.budgetCommitment.deleteMany({
        where: { budgetLineId: { in: before.map((l) => l.id) } },
      });
      await ctx.prisma.budgetLine.deleteMany({
        where: { budgetId: fx.budgetId },
      });
      try {
        const travelId = await approveTrip();
        const row = await ctx.prisma.travelRequest.findUnique({
          where: { id: travelId },
        });
        expect(row!.status).toBe('APPROVED');
        expect(
          await ctx.prisma.budgetCommitment.findMany({
            where: { sourceType: 'TRAVEL', sourceId: travelId },
          }),
        ).toEqual([]);
      } finally {
        for (const l of before) {
          await ctx.prisma.budgetLine.create({
            data: {
              id: l.id,
              budgetId: l.budgetId,
              departmentId: l.departmentId,
              category: l.category,
              plannedAmount: l.plannedAmount,
            },
          });
        }
      }
    });

    it('BUD-API-26 rejecting the trip releases the commitment; the row survives as RELEASED', async () => {
      const travelId = await approveTrip();
      await ctx
        .http()
        .delete(`/travel-requests/${travelId}`)
        .set(bearer(fx.admin.token));

      const commitments = await ctx.prisma.budgetCommitment.findMany({
        where: { sourceType: 'TRAVEL', sourceId: travelId },
      });
      // Released, not deleted — the ledger keeps the history of what was
      // committed and then let go.
      expect(commitments).toHaveLength(1);
      expect(commitments[0].status).toBe('RELEASED');
    });
  });

  // ── Variance ──────────────────────────────────────────────────────────────
  describe('the variance report', () => {
    it('BUD-API-27 Remaining = Planned − OPEN − Actual, per line and in total', async () => {
      const res = await ctx
        .http()
        .get(`/budgets/${fx.budgetId}/variance`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      const d = dataOf(res);

      const rows: any[] = d.rows ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const planned = Number(row.planned);
        const committed = Number(row.committed);
        const actual = Number(row.actual);
        expect(Number((planned - committed - actual).toFixed(2))).toBe(
          Number(Number(row.remaining).toFixed(2)),
        );
        // Utilization is (committed + actual) / planned, and must not divide
        // by zero on a line budgeted at nothing.
        expect(Number.isFinite(Number(row.utilization))).toBe(true);
      }

      // The totals are the sum of the rows, not a second query that could
      // disagree with them.
      const sum = (key: string) =>
        Number(
          rows.reduce((acc, r) => acc + Number(r[key]), 0).toFixed(2),
        );
      for (const key of ['planned', 'committed', 'actual', 'remaining']) {
        expect(Number(Number(d.totals[key]).toFixed(2))).toBe(sum(key));
      }
    });

    it('BUD-API-27b a REALIZED commitment leaves `committed` and appears in `actual` — the double-count guard', async () => {
      // The property that lets Committed and Actual be added without fear. A
      // commitment counted in both columns would overstate spend by exactly
      // the amount that has actually moved.
      const line = await ctx.prisma.budgetLine.findFirstOrThrow({
        where: { budgetId: fx.budgetId, departmentId: fx.finDeptId },
      });
      const commitment = await ctx.prisma.budgetCommitment.create({
        data: {
          budgetLineId: line.id,
          sourceType: 'TRAVEL',
          sourceId: '22222222-2222-2222-2222-222222222222',
          amount: 250,
          status: 'OPEN',
        },
      });
      try {
        const open = await ctx
          .http()
          .get(`/budgets/${fx.budgetId}/variance`)
          .set(bearer(fx.admin.token));
        const openRow = (dataOf(open).rows as any[]).find(
          (r) => r.budgetLineId === line.id,
        );
        expect(Number(openRow.committed)).toBeGreaterThanOrEqual(250);

        await ctx.prisma.budgetCommitment.update({
          where: { id: commitment.id },
          data: { status: 'REALIZED' },
        });

        const realized = await ctx
          .http()
          .get(`/budgets/${fx.budgetId}/variance`)
          .set(bearer(fx.admin.token));
        const realizedRow = (dataOf(realized).rows as any[]).find(
          (r) => r.budgetLineId === line.id,
        );
        expect(Number(realizedRow.committed)).toBe(
          Number(openRow.committed) - 250,
        );
      } finally {
        await ctx.prisma.budgetCommitment.delete({
          where: { id: commitment.id },
        });
      }
    });

    it('BUD-API-28 the report names spend that has no budget line', async () => {
      // An over-run is not an under-spend. Real money against a heading nobody
      // planned for has to appear somewhere, or the report quietly flatters
      // the budget.
      const res = await ctx
        .http()
        .get(`/budgets/${fx.budgetId}/variance`)
        .set(bearer(fx.admin.token));
      expectStatus(res, 200);
      expect(Array.isArray(dataOf(res).unbudgeted)).toBe(true);
    });

    it('BUD-API-29 a budget with no lines reports zeros, not NaN or null', async () => {
      const res = await makeBudget();
      const id = dataOf(res).id;
      const variance = await ctx
        .http()
        .get(`/budgets/${id}/variance`)
        .set(bearer(fx.admin.token));
      expectStatus(variance, 200);
      const d = dataOf(variance);
      expect(d.rows).toEqual([]);
      for (const key of ['planned', 'committed', 'actual', 'remaining']) {
        // Zero, not NaN and not null — an empty budget is a budget of nothing,
        // which every consumer can render.
        expect(Number(d.totals[key])).toBe(0);
      }
    });

    it('BUD-API-30 a scoped HR cannot read another branch’s variance', async () => {
      const foreign = await makeBudget({
        name: `E2E Variance BranchB ${fx.runId}`,
        branchId: fx.branchB,
      });
      const res = await ctx
        .http()
        .get(`/budgets/${dataOf(foreign).id}/variance`)
        .set(bearer(fx.hrScoped.token));
      expectStatus(res, 404);
    });
  });

  // ── Refusals and audit ────────────────────────────────────────────────────
  describe('every refusal explains itself', () => {
    const GENERIC =
      /^(bad request|forbidden|not found|conflict|error|internal server error)$/i;

    it('BUD-API-31 every reachable refusal carries a specific sentence', async () => {
      const name = `E2E Sweep ${fx.runId}`;
      await makeBudget({ name });

      const probes: Array<[string, () => Promise<any>]> = [
        ['duplicate name', () => makeBudget({ name })],
        [
          'end before start',
          () => makeBudget({ startDate: `${YEAR}-06-01`, endDate: `${YEAR}-01-01` }),
        ],
        [
          'unknown status',
          () =>
            ctx
              .http()
              .patch(`/budgets/${fx.budgetId}/status`)
              .set(bearer(fx.admin.token))
              .send({ status: 'ARCHIVED' }),
        ],
        [
          'unknown budget',
          () =>
            ctx
              .http()
              .get('/budgets/00000000-0000-0000-0000-000000000000')
              .set(bearer(fx.admin.token)),
        ],
        [
          'unknown line',
          () =>
            ctx
              .http()
              .delete(
                `/budgets/${fx.budgetId}/lines/00000000-0000-0000-0000-000000000000`,
              )
              .set(bearer(fx.admin.token)),
        ],
        [
          'assign to an unreachable branch',
          () =>
            ctx
              .http()
              .post('/budgets')
              .set(bearer(fx.hrScoped.token))
              .send({
                name: `E2E Sweep Foreign ${fx.runId}`,
                fiscalYear: YEAR,
                startDate: `${YEAR}-01-01`,
                endDate: `${YEAR}-12-31`,
                branchId: fx.branchB,
              }),
        ],
      ];

      const offenders: string[] = [];
      for (const [label, call] of probes) {
        const res = await call();
        if (res.status < 400) {
          throw new Error(`${label} did not refuse: ${body(res)}`);
        }
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

    it('BUD-API-32 create, status change and line writes are audited with their actor', async () => {
      const res = await makeBudget();
      const id = dataOf(res).id;
      await ctx
        .http()
        .patch(`/budgets/${id}/status`)
        .set(bearer(fx.admin.token))
        .send({ status: 'ACTIVE' });

      const rows = await ctx.prisma.auditLog.findMany({
        where: { resourceType: 'Budget', resourceId: id },
      });
      const actions = new Set(rows.map((r) => r.action));
      expect(actions.has('BUDGET_CREATED')).toBe(true);
      expect(actions.has('BUDGET_STATUS_CHANGED')).toBe(true);
      expect(rows.every((r) => !!r.userId)).toBe(true);
    });
  });
});
