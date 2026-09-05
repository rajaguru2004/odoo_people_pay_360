import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupPeopleFixtures, PeopleFixtures } from './utils/people-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * Termination requests — the approval-gated offboarding path.
 *
 * `asset-clearance.e2e-spec.ts` already covers the clearance GUARD across all
 * three offboarding doors. What nothing covered is the request's own lifecycle:
 * the five categories, the one-pending rule, what approval does to the contract
 * AND the person, and what a second decision on a settled request answers.
 *
 * The approval is the most consequential write in the module — it terminates a
 * contract and deactivates a human being in one transaction — so every decision
 * case asserts all three rows, not the response body.
 */
describe('People — Termination requests (e2e)', () => {
  let ctx: E2EContext;
  let fx: PeopleFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  let seq = 0;
  let createdEmployees: string[] = [];

  const daysFromNow = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  /** An employee with one ACTIVE contract — the only state a request accepts. */
  const seedContracted = async (over: Record<string, unknown> = {}) => {
    const n = seq++;
    const employee = await ctx.prisma.employee.create({
      data: {
        employeeCode: `TRM-${fx.runId}-${n}`,
        fullName: `Termination Subject ${n}`,
        dateOfBirth: new Date('1990-01-01'),
        idCard: `TRMID-${fx.runId}-${n}`,
        email: `trm${n}-${fx.runId}@test.local`,
        departmentId: fx.mainDeptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: new Date('2020-01-01'),
        baseSalary: 40000,
        status: 'ACTIVE',
        ...over,
      } as any,
    });
    createdEmployees.push(employee.id);
    const contract = await ctx.prisma.contract.create({
      data: {
        employeeId: employee.id,
        contractType: 'INDEFINITE',
        startDate: new Date('2020-01-01'),
        salary: 40000,
        status: 'ACTIVE',
      },
    });
    return { employee, contract };
  };

  const newRequest = (contractId: string, over: Record<string, unknown> = {}) => ({
    contractId,
    requestedBy: fx.hr.userId,
    terminationCategory: 'RESIGNATION',
    noticeDate: daysFromNow(0),
    terminationDate: daysFromNow(30),
    reason: 'Moving on to another role',
    ...over,
  });

  const request = (payload: Record<string, unknown>, token = fx.hr.token) =>
    ctx
      .http()
      .post('/contracts/termination-requests')
      .set(bearer(token))
      .send(payload);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPeopleFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    await ctx.prisma.terminationRequest.deleteMany({
      where: { contract: { employeeId: { in: createdEmployees } } },
    });
    await ctx.prisma.contract.deleteMany({
      where: { employeeId: { in: createdEmployees } },
    });
    await ctx.prisma.employee.deleteMany({
      where: { id: { in: createdEmployees } },
    });
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Raising a request
  // ───────────────────────────────────────────────────────────────────────────

  it('TERM-API-01: a request against an ACTIVE contract starts PENDING_APPROVAL', async () => {
    const { contract } = await seedContracted();
    const res = await request(newRequest(contract.id));
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING_APPROVAL');
    expect(res.body.data.requestedBy).toBe(fx.hr.userId);
  });

  it('TERM-API-02: all five categories are accepted', async () => {
    for (const terminationCategory of [
      'RESIGNATION',
      'MUTUAL_AGREEMENT',
      'COMPANY_TERMINATION',
      'CONTRACT_EXPIRATION',
      'DISCIPLINARY',
    ]) {
      const { contract } = await seedContracted();
      const res = await request(newRequest(contract.id, { terminationCategory }));
      expect(res.status).toBe(201);
      expect(res.body.data.terminationCategory).toBe(terminationCategory);
    }
  });

  it('TERM-API-03: a sixth, invented category is refused', async () => {
    const { contract } = await seedContracted();
    const res = await request(
      newRequest(contract.id, { terminationCategory: 'ABDUCTED_BY_ALIENS' }),
    );
    expect(res.status).toBe(400);
    expect(body(res)).toContain('Invalid termination type');
  });

  it('TERM-API-04: notice date, termination date and reason are all required', async () => {
    const { contract } = await seedContracted();
    for (const missing of ['noticeDate', 'terminationDate', 'reason']) {
      const payload: Record<string, unknown> = newRequest(contract.id);
      delete payload[missing];
      const res = await request(payload);
      expect(res.status).toBe(400);
    }
  });

  it('TERM-API-05: a termination date BEFORE the notice date is accepted — pinned', async () => {
    // Nothing enforces the order. A request that terminates someone before
    // they were notified is nonsense, and the server takes it — recorded here
    // so the absence is a decision rather than a discovery.
    const { contract } = await seedContracted();
    const res = await request(
      newRequest(contract.id, {
        noticeDate: daysFromNow(30),
        terminationDate: daysFromNow(1),
      }),
    );
    expect(res.status).toBe(201);
  });

  it('TERM-API-06: the contract must be ACTIVE', async () => {
    const { employee, contract } = await seedContracted();
    await ctx.prisma.contract.update({
      where: { id: contract.id },
      data: { status: 'EXPIRED' },
    });
    const res = await request(newRequest(contract.id));
    expect(res.status).toBe(400);
    expect(body(res)).toContain('Contract is not active');
    expect(employee.id).toBeTruthy();
  });

  it('TERM-API-07: only one request may be pending against a contract', async () => {
    const { contract } = await seedContracted();
    expect((await request(newRequest(contract.id))).status).toBe(201);

    const second = await request(newRequest(contract.id));
    expect(second.status).toBe(400);
    expect(body(second)).toContain('already pending approval');
  });

  it('TERM-API-08: MANAGER, EMPLOYEE and anon cannot raise one', async () => {
    const { contract } = await seedContracted();
    expect((await request(newRequest(contract.id), fx.manager.token)).status).toBe(403);
    expect((await request(newRequest(contract.id), fx.employee.token)).status).toBe(403);
    expect(
      (
        await ctx
          .http()
          .post('/contracts/termination-requests')
          .send(newRequest(contract.id))
      ).status,
    ).toBe(401);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Deciding
  // ───────────────────────────────────────────────────────────────────────────

  it('TERM-API-09: a request moves from pending to history when it is decided', async () => {
    const { contract } = await seedContracted();
    const created = await request(newRequest(contract.id));
    const id = created.body.data.id;

    const pendingBefore = await ctx
      .http()
      .get('/contracts/termination-requests/pending')
      .set(bearer(fx.hr.token));
    expect(rowsOf(pendingBefore).map((r) => r.id)).toContain(id);

    await ctx
      .http()
      .post(`/contracts/termination-requests/${id}/reject`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId, reason: 'Retained after counter-offer' });

    const pendingAfter = await ctx
      .http()
      .get('/contracts/termination-requests/pending')
      .set(bearer(fx.hr.token));
    expect(rowsOf(pendingAfter).map((r) => r.id)).not.toContain(id);

    const history = await ctx
      .http()
      .get('/contracts/termination-requests/history')
      .set(bearer(fx.hr.token));
    expect(rowsOf(history).map((r) => r.id)).toContain(id);
  });

  it('TERM-API-11: approval terminates the contract AND deactivates the person', async () => {
    const { employee, contract } = await seedContracted();
    const created = await request(newRequest(contract.id));

    const res = await ctx
      .http()
      .post(`/contracts/termination-requests/${created.body.data.id}/approve`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId, comments: 'Approved' });
    expect(res.status).toBe(201);

    // All three rows. An approval that moves only some of them leaves the
    // organisation disagreeing with itself about whether this person works here.
    const reqRow = await ctx.prisma.terminationRequest.findUnique({
      where: { id: created.body.data.id },
    });
    expect(reqRow!.status).toBe('APPROVED');

    const contractRow = await ctx.prisma.contract.findUnique({
      where: { id: contract.id },
    });
    expect(contractRow!.status).toBe('TERMINATED');

    const personRow = await ctx.prisma.employee.findUnique({
      where: { id: employee.id },
    });
    expect(personRow!.status).toBe('INACTIVE');
  });

  it('TERM-API-12: rejection leaves the contract and the person untouched', async () => {
    const { employee, contract } = await seedContracted();
    const created = await request(newRequest(contract.id));

    const res = await ctx
      .http()
      .post(`/contracts/termination-requests/${created.body.data.id}/reject`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId, reason: 'Business need' });
    expect(res.status).toBe(201);

    expect(
      (await ctx.prisma.terminationRequest.findUnique({
        where: { id: created.body.data.id },
      }))!.status,
    ).toBe('REJECTED');
    expect(
      (await ctx.prisma.contract.findUnique({ where: { id: contract.id } }))!
        .status,
    ).toBe('ACTIVE');
    expect(
      (await ctx.prisma.employee.findUnique({ where: { id: employee.id } }))!
        .status,
    ).toBe('ACTIVE');
  });

  it('TERM-API-13/18: a settled request refuses every further decision', async () => {
    const { contract } = await seedContracted();
    const created = await request(newRequest(contract.id));
    const id = created.body.data.id;

    await ctx
      .http()
      .post(`/contracts/termination-requests/${id}/approve`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId });

    // Each door takes a different body: approve accepts `comments`, reject
    // requires `reason`, and the ValidationPipe whitelists the other away —
    // so a shared payload would fail on the DTO before reaching the status
    // check this case is actually about.
    const again = await ctx
      .http()
      .post(`/contracts/termination-requests/${id}/approve`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId, comments: 'Again' });
    expect(again.status).toBe(400);
    expect(body(again)).toContain('not pending approval');

    const flip = await ctx
      .http()
      .post(`/contracts/termination-requests/${id}/reject`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId, reason: 'Changed my mind' });
    expect(flip.status).toBe(400);
    expect(body(flip)).toContain('not pending approval');
  });

  it('TERM-API-14: approval is clearance-gated, and the override is audited (P20)', async () => {
    const { employee, contract } = await seedContracted();
    const asset = await ctx.prisma.assetItem.create({
      data: {
        assetTag: `TRMASSET-${fx.runId}-${seq++}`,
        category: 'Laptop',
        name: 'Termination Fixture Laptop',
        branchId: fx.branchA,
        status: 'ASSIGNED',
      },
    });
    await ctx.prisma.assetAssignment.create({
      data: {
        assetId: asset.id,
        employeeId: employee.id,
        assignedAt: new Date('2024-01-01'),
        assignedById: fx.admin.userId,
      },
    });
    const created = await request(newRequest(contract.id));
    const id = created.body.data.id;

    const blocked = await ctx
      .http()
      .post(`/contracts/termination-requests/${id}/approve`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId });
    expect(blocked.status).toBe(400);
    expect(body(blocked)).toContain('Cannot complete offboarding');

    const overridden = await ctx
      .http()
      .post(`/contracts/termination-requests/${id}/approve`)
      .set(bearer(fx.hr.token))
      .send({
        approverId: fx.hr.userId,
        clearanceOverrideReason: 'Asset written off by Finance',
      });
    expect(overridden.status).toBe(201);

    // This is the path that lacked an audit assertion. Without it, an override
    // on the approval door is indistinguishable from no check at all.
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'CLEARANCE_OVERRIDDEN', resourceId: employee.id },
    });
    expect(audit).toBeTruthy();

    await ctx.prisma.assetAssignment.deleteMany({
      where: { employeeId: employee.id },
    });
    await ctx.prisma.assetItem.delete({ where: { id: asset.id } });
  });

  it('TERM-API-16: MANAGER and EMPLOYEE cannot decide', async () => {
    const { contract } = await seedContracted();
    const created = await request(newRequest(contract.id));
    const id = created.body.data.id;

    for (const actor of [fx.manager, fx.employee]) {
      for (const action of ['approve', 'reject']) {
        const res = await ctx
          .http()
          .post(`/contracts/termination-requests/${id}/${action}`)
          .set(bearer(actor.token))
          .send({ approverId: actor.userId, reason: 'nope' });
        expect(res.status).toBe(403);
      }
    }
  });

  it('TERM-API-17: rejection without a reason is refused by the DTO', async () => {
    // The screen keeps its confirm button disabled until a reason is typed;
    // this asserts the server does not depend on the screen for that.
    const { contract } = await seedContracted();
    const created = await request(newRequest(contract.id));

    const res = await ctx
      .http()
      .post(`/contracts/termination-requests/${created.body.data.id}/reject`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId });
    expect(res.status).toBe(400);
  });

  it('TERM-API-19: a scoped HR cannot approve outside their branch grant', async () => {
    const { contract } = await seedContracted({
      branchId: fx.branchB,
      departmentId: fx.foreignDeptId,
    });
    const created = await request(newRequest(contract.id));

    const res = await ctx
      .http()
      .post(`/contracts/termination-requests/${created.body.data.id}/approve`)
      .set(bearer(fx.scopedHr.token))
      .send({ approverId: fx.scopedHr.userId });
    expect(res.status).toBe(404);
  });

  it('TERM-API-20: exactly one of two parallel approvals wins', async () => {
    /**
     * WAS (P31): the status check was a READ and the write followed it, so two
     * approvals arriving together both passed the check before either wrote.
     * The end state looked fine because both wrote the same values — but the
     * whole approval ran twice, including the audited clearance override, and
     * any step with a real side effect would have run twice with it.
     *
     * NOW: the transaction takes a row lock and re-reads the status, so the
     * second one sees APPROVED and is refused.
     */
    const { employee, contract } = await seedContracted();
    const created = await request(newRequest(contract.id));
    const id = created.body.data.id;

    const decide = () =>
      ctx
        .http()
        .post(`/contracts/termination-requests/${id}/approve`)
        .set(bearer(fx.hr.token))
        .send({ approverId: fx.hr.userId });

    const [a, b] = await Promise.all([decide(), decide()]);
    const statuses = [a.status, b.status];
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 400)).toHaveLength(1);
    expect(body(statuses[0] === 400 ? a : b)).toContain(
      'not pending approval',
    );

    const person = await ctx.prisma.employee.findUnique({
      where: { id: employee.id },
    });
    expect(person!.status).toBe('INACTIVE');
    const reqRow = await ctx.prisma.terminationRequest.findUnique({
      where: { id },
    });
    expect(reqRow!.status).toBe('APPROVED');
  });

  it('TERM-API-10: a request reads back by id and by contract', async () => {
    const { contract } = await seedContracted();
    const created = await request(newRequest(contract.id));
    const id = created.body.data.id;

    const byId = await ctx
      .http()
      .get(`/contracts/termination-requests/${id}`)
      .set(bearer(fx.hr.token));
    expect(byId.status).toBe(200);

    const byContract = await ctx
      .http()
      .get(`/contracts/${contract.id}/termination-requests`)
      .set(bearer(fx.hr.token));
    expect(byContract.status).toBe(200);
    expect(rowsOf(byContract).map((r) => r.id)).toContain(id);
  });
});
