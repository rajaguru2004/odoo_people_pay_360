import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupPeopleFixtures, PeopleFixtures } from './utils/people-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * Contracts, end to end.
 *
 * There was no HTTP-level spec for this module: two unit specs covered the
 * backdating and daily-wage arithmetic, and nothing covered the lifecycle, the
 * RBAC matrix, renew, terminate, or the side effect that matters most —
 * `syncEmployeeBaseSalary` writing a contract's salary onto the employee.
 *
 * That sync is the reason the money assertions here read the DATABASE rather
 * than the response: a contract that quietly moves `Employee.baseSalary` for a
 * daily-wage worker turns a ₹1,000/day rate into ₹1,000/month (or pays a
 * monthly figure 26 times), and neither the contract screen nor the employee
 * screen would show anything wrong until payroll ran.
 *
 * One rule is asserted as ABSENT on purpose: every labor-law check in
 * `ContractValidationService` is commented out. A 15-month probation is
 * accepted today, and `CON-API-30` says so — which is what makes re-enabling
 * those rules a visible, deliberate change rather than a surprise.
 */
describe('People — Contracts (e2e)', () => {
  let ctx: E2EContext;
  let fx: PeopleFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  let seq = 0;
  let createdEmployees: string[] = [];

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const daysFromNow = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return iso(d);
  };

  /**
   * Every contract case gets its own employee. "One ACTIVE contract per
   * employee" means a contract left behind by one case refuses the next one's
   * create, and sharing a fixture employee would couple them in run order.
   */
  const seedEmployee = async (over: Record<string, unknown> = {}) => {
    const n = seq++;
    const e = await ctx.prisma.employee.create({
      data: {
        employeeCode: `CON-${fx.runId}-${n}`,
        fullName: `Contract Subject ${n}`,
        dateOfBirth: new Date('1990-01-01'),
        idCard: `CONID-${fx.runId}-${n}`,
        email: `con${n}-${fx.runId}@test.local`,
        departmentId: fx.mainDeptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: new Date('2020-01-01'),
        baseSalary: 30000,
        status: 'ACTIVE',
        ...over,
      } as any,
    });
    createdEmployees.push(e.id);
    return e;
  };

  const newContract = (employeeId: string, over: Record<string, unknown> = {}) => ({
    employeeId,
    contractType: 'INDEFINITE',
    startDate: '2024-01-01',
    salary: 50000,
    ...over,
  });

  const create = (payload: Record<string, unknown>, token = fx.hr.token) =>
    ctx.http().post('/contracts').set(bearer(token)).send(payload);

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
  // Read + RBAC
  // ───────────────────────────────────────────────────────────────────────────

  it('CON-API-01: the list is ADMIN/HR only', async () => {
    for (const actor of [fx.admin, fx.hr]) {
      expect(
        (await ctx.http().get('/contracts').set(bearer(actor.token))).status,
      ).toBe(200);
    }
    for (const actor of [fx.manager, fx.employee]) {
      expect(
        (await ctx.http().get('/contracts').set(bearer(actor.token))).status,
      ).toBe(403);
    }
    expect((await ctx.http().get('/contracts')).status).toBe(401);
  });

  it('CON-API-02: expiring and statistics answer without a serialization error', async () => {
    const expiring = await ctx
      .http()
      .get('/contracts/expiring?days=30')
      .set(bearer(fx.hr.token));
    expect(expiring.status).toBe(200);

    const stats = await ctx
      .http()
      .get('/contracts/statistics')
      .set(bearer(fx.hr.token));
    expect(stats.status).toBe(200);
    // Raw-SQL counts arrive as BigInt and must be coerced before they reach
    // JSON.stringify, or this 500s rather than answering.
    expect(JSON.stringify(stats.body)).toBeTruthy();
  });

  it('CON-API-19: an employee may read their own contract, and only their own', async () => {
    // WAS (P22): the route admitted ADMIN/HR/MANAGER only, so the document that
    // defines someone's pay was unreadable by them — the same shape of omission
    // as GET /employees/:id.
    const own = await ctx
      .http()
      .get(`/contracts/employee/${fx.employee.employeeId}`)
      .set(bearer(fx.employee.token));
    expect(own.status).toBe(200);

    const other = await ctx
      .http()
      .get(`/contracts/employee/${fx.contractedStaffId}`)
      .set(bearer(fx.employee.token));
    expect(other.status).toBe(403);
    expect(body(other)).toContain('only view your own');
  });

  it('CON-API-20: read by id — MANAGER in scope, out of scope, and a scoped HR off grant', async () => {
    const inScope = await ctx
      .http()
      .get(`/contracts/${fx.activeContractId}`)
      .set(bearer(fx.manager.token));
    expect(inScope.status).toBe(200);

    // A contract belonging to an employee in another branch: 404, not 403 —
    // the branch boundary must not leak existence.
    const foreignEmp = await seedEmployee({
      branchId: fx.branchB,
      departmentId: fx.foreignDeptId,
    });
    const foreignContract = await create(newContract(foreignEmp.id));
    expect(foreignContract.status).toBe(201);

    const offGrant = await ctx
      .http()
      .get(`/contracts/${foreignContract.body.data.id}`)
      .set(bearer(fx.scopedHr.token));
    expect(offGrant.status).toBe(404);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Create
  // ───────────────────────────────────────────────────────────────────────────

  it('CON-API-03/04: endDate is required for every type except INDEFINITE', async () => {
    const indefinite = await create(
      newContract((await seedEmployee()).id, { contractType: 'INDEFINITE' }),
    );
    expect(indefinite.status).toBe(201);
    expect(indefinite.body.data.status).toBe('ACTIVE');

    for (const contractType of ['PROBATION', 'FIXED_TERM']) {
      const res = await create(
        newContract((await seedEmployee()).id, { contractType }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('CON-API-05: a duplicate contract number is a 409 the user can act on', async () => {
    // WAS (P30): `contractNumber` is @unique but nothing caught Prisma's P2002,
    // so a duplicate answered 500 with the raw driver error while every other
    // uniqueness conflict in People answered 409 with a readable sentence.
    const number = `CN-${fx.runId}-${seq++}`;
    const first = await create(
      newContract((await seedEmployee()).id, { contractNumber: number }),
    );
    expect(first.status).toBe(201);

    const dup = await create(
      newContract((await seedEmployee()).id, { contractNumber: number }),
    );
    expect(dup.status).toBe(409);
    expect(body(dup)).toContain('already exists');

    const rows = await ctx.prisma.contract.findMany({
      where: { contractNumber: number },
    });
    expect(rows).toHaveLength(1);
  });

  it('CON-API-06: the endDate boundary agrees with the nightly cron', async () => {
    // A contract that ended yesterday is born EXPIRED; one ending tomorrow is
    // ACTIVE. TODAY is the interesting one: the create path and the auto-expire
    // cron both use `lt`, and if they ever diverge a contract ending today is
    // ACTIVE by one path and EXPIRED by the other.
    const yesterday = await create(
      newContract((await seedEmployee()).id, {
        contractType: 'FIXED_TERM',
        endDate: daysFromNow(-1),
      }),
    );
    expect(yesterday.status).toBe(201);
    expect(yesterday.body.data.status).toBe('EXPIRED');

    const today = await create(
      newContract((await seedEmployee()).id, {
        contractType: 'FIXED_TERM',
        endDate: daysFromNow(0),
      }),
    );
    expect(today.status).toBe(201);
    expect(today.body.data.status).toBe('ACTIVE');

    const tomorrow = await create(
      newContract((await seedEmployee()).id, {
        contractType: 'FIXED_TERM',
        endDate: daysFromNow(1),
      }),
    );
    expect(tomorrow.status).toBe(201);
    expect(tomorrow.body.data.status).toBe('ACTIVE');
  });

  it('CON-API-07/08: one ACTIVE contract at a time, and the slot frees on expiry', async () => {
    const emp = await seedEmployee();
    expect((await create(newContract(emp.id))).status).toBe(201);

    const second = await create(newContract(emp.id));
    expect(second.status).toBe(409);
    expect(body(second)).toContain('already has an active contract');

    // An EXPIRED contract does not hold the slot.
    const expired = await seedEmployee();
    await create(
      newContract(expired.id, {
        contractType: 'FIXED_TERM',
        endDate: daysFromNow(-1),
      }),
    );
    expect((await create(newContract(expired.id))).status).toBe(201);
  });

  it('CON-API-09: an unknown employee is refused', async () => {
    const res = await create(
      newContract('00000000-0000-0000-0000-000000000000'),
    );
    expect([400, 404]).toContain(res.status);
    expect(body(res)).toContain('Employee not found');
  });

  it('CON-API-10: the DTO refuses malformed input and accepts its boundaries', async () => {
    const emp = await seedEmployee();
    for (const over of [
      { contractType: 'CASUAL' },
      { workType: 'REMOTE_ISH' },
      { salary: -1 },
      { contractNumber: 'x'.repeat(101) },
      { startDate: 'not-a-date' },
      { workHoursPerWeek: 0 },
    ]) {
      const res = await create(newContract(emp.id, over));
      expect(res.status).toBe(400);
    }
    expect(
      (await create(newContract(emp.id, { workHoursPerWeek: 1 }))).status,
    ).toBe(201);
  });

  it('CON-API-11: MANAGER and EMPLOYEE cannot create a contract', async () => {
    const emp = await seedEmployee();
    expect((await create(newContract(emp.id), fx.manager.token)).status).toBe(
      403,
    );
    expect((await create(newContract(emp.id), fx.employee.token)).status).toBe(
      403,
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The salary sync — the money path
  // ───────────────────────────────────────────────────────────────────────────

  it('CON-API-12: a monthly contract moves Employee.baseSalary', async () => {
    const emp = await seedEmployee({ baseSalary: 30000 });
    const res = await create(newContract(emp.id, { salary: 55000 }));
    expect(res.status).toBe(201);

    const after = await ctx.prisma.employee.findUnique({
      where: { id: emp.id },
    });
    expect(Number(after!.baseSalary)).toBe(55000);
  });

  it('CON-API-13: a DAILY-wage contract does NOT move it — the ~26x overpay guard', async () => {
    // `baseSalary` is a PER-DAY rate for daily-wage staff. Writing a monthly
    // contract figure over it would pay that amount every working day; writing
    // a daily figure into a monthly field underpays by the same factor. The
    // guard is the only thing between those two outcomes, and it is invisible
    // from every screen.
    const emp = await seedEmployee({ salaryType: 'DAILY', baseSalary: 1200 });
    const res = await create(newContract(emp.id, { salary: 55000 }));
    expect(res.status).toBe(201);

    const after = await ctx.prisma.employee.findUnique({
      where: { id: emp.id },
    });
    expect(Number(after!.baseSalary)).toBe(1200);
  });

  it('CON-API-14: a salary PATCH follows the same rule in both directions', async () => {
    const monthly = await seedEmployee({ baseSalary: 30000 });
    const mc = await create(newContract(monthly.id, { salary: 40000 }));
    await ctx
      .http()
      .patch(`/contracts/${mc.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ salary: 61000 });
    expect(
      Number(
        (await ctx.prisma.employee.findUnique({ where: { id: monthly.id } }))!
          .baseSalary,
      ),
    ).toBe(61000);

    const daily = await seedEmployee({ salaryType: 'DAILY', baseSalary: 900 });
    const dc = await create(newContract(daily.id, { salary: 40000 }));
    await ctx
      .http()
      .patch(`/contracts/${dc.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ salary: 61000 });
    expect(
      Number(
        (await ctx.prisma.employee.findUnique({ where: { id: daily.id } }))!
          .baseSalary,
      ),
    ).toBe(900);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Renew and terminate
  // ───────────────────────────────────────────────────────────────────────────

  it('CON-API-15: renew expires the old contract and starts the new one where it ended', async () => {
    const emp = await seedEmployee();
    const first = await create(
      newContract(emp.id, {
        contractType: 'FIXED_TERM',
        startDate: '2024-01-01',
        endDate: daysFromNow(30),
      }),
    );
    const oldId = first.body.data.id;

    const res = await ctx
      .http()
      .post(`/contracts/${oldId}/renew`)
      .set(bearer(fx.hr.token))
      .send({ newEndDate: daysFromNow(400) });
    expect(res.status).toBe(201);

    const old = await ctx.prisma.contract.findUnique({ where: { id: oldId } });
    expect(old!.status).toBe('EXPIRED');

    const fresh = await ctx.prisma.contract.findUnique({
      where: { id: res.body.data.id },
    });
    expect(fresh!.status).toBe('ACTIVE');
    expect(iso(fresh!.startDate)).toBe(iso(old!.endDate!));
  });

  it('CON-API-17: terminate ends the contract AND deactivates the person', async () => {
    const emp = await seedEmployee();
    const c = await create(newContract(emp.id));

    const res = await ctx
      .http()
      .post(`/contracts/${c.body.data.id}/terminate`)
      .set(bearer(fx.hr.token))
      .send({ reason: 'Mutual agreement' });
    expect(res.status).toBe(201);

    // Both halves, on the rows. A terminate that moves only one of them leaves
    // a live employee with no contract or a contract with no-one to serve it.
    const contract = await ctx.prisma.contract.findUnique({
      where: { id: c.body.data.id },
    });
    expect(contract!.status).toBe('TERMINATED');
    const person = await ctx.prisma.employee.findUnique({
      where: { id: emp.id },
    });
    expect(person!.status).toBe('INACTIVE');
    expect(person!.endDate).toBeTruthy();
  });

  it('CON-API-18: an unreturned asset blocks a terminate, and an override is audited', async () => {
    const emp = await seedEmployee();
    const c = await create(newContract(emp.id));
    const asset = await ctx.prisma.assetItem.create({
      data: {
        assetTag: `CONASSET-${fx.runId}-${seq++}`,
        category: 'Laptop',
        name: 'Contract Fixture Laptop',
        branchId: fx.branchA,
        status: 'ASSIGNED',
      },
    });
    await ctx.prisma.assetAssignment.create({
      data: {
        assetId: asset.id,
        employeeId: emp.id,
        assignedAt: new Date('2024-01-01'),
        assignedById: fx.admin.userId,
      },
    });

    const blocked = await ctx
      .http()
      .post(`/contracts/${c.body.data.id}/terminate`)
      .set(bearer(fx.hr.token))
      .send({ reason: 'Leaving' });
    expect(blocked.status).toBe(400);
    expect(body(blocked)).toContain('Cannot complete offboarding');

    const overridden = await ctx
      .http()
      .post(`/contracts/${c.body.data.id}/terminate`)
      .set(bearer(fx.hr.token))
      .send({ reason: 'Leaving', clearanceOverrideReason: 'Laptop written off' });
    expect(overridden.status).toBe(201);

    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'CLEARANCE_OVERRIDDEN', resourceId: emp.id },
    });
    expect(audit).toBeTruthy();

    await ctx.prisma.assetAssignment.deleteMany({ where: { employeeId: emp.id } });
    await ctx.prisma.assetItem.delete({ where: { id: asset.id } });
  });

  it('CON-API-18b: the clearance kill switch releases the terminate path too', async () => {
    const emp = await seedEmployee();
    const c = await create(newContract(emp.id));
    const asset = await ctx.prisma.assetItem.create({
      data: {
        assetTag: `CONASSET2-${fx.runId}-${seq++}`,
        category: 'Laptop',
        name: 'Contract Fixture Laptop 2',
        branchId: fx.branchA,
        status: 'ASSIGNED',
      },
    });
    await ctx.prisma.assetAssignment.create({
      data: {
        assetId: asset.id,
        employeeId: emp.id,
        assignedAt: new Date('2024-01-01'),
        assignedById: fx.admin.userId,
      },
    });

    await withSetting(ctx, 'clearance_blocking_enabled', 'false', async () => {
      const res = await ctx
        .http()
        .post(`/contracts/${c.body.data.id}/terminate`)
        .set(bearer(fx.hr.token))
        .send({ reason: 'Switch off' });
      expect(res.status).toBe(201);
    });

    await ctx.prisma.assetAssignment.deleteMany({ where: { employeeId: emp.id } });
    await ctx.prisma.assetItem.delete({ where: { id: asset.id } });
  });

  it('CON-API-21: an employee’s contract history comes back complete', async () => {
    const emp = await seedEmployee();
    const first = await create(
      newContract(emp.id, {
        contractType: 'FIXED_TERM',
        endDate: daysFromNow(10),
      }),
    );
    await ctx
      .http()
      .post(`/contracts/${first.body.data.id}/renew`)
      .set(bearer(fx.hr.token))
      .send({ newEndDate: daysFromNow(400) });

    const res = await ctx
      .http()
      .get(`/contracts/employee/${emp.id}`)
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(200);
    const statuses = rowsOf(res).map((c) => c.status);
    expect(statuses).toContain('EXPIRED');
    expect(statuses).toContain('ACTIVE');
  });

  it('CON-API-24: the expiring window is inclusive at its edge', async () => {
    const inside = await seedEmployee();
    await create(
      newContract(inside.id, {
        contractType: 'FIXED_TERM',
        endDate: daysFromNow(29),
      }),
    );
    const outside = await seedEmployee();
    await create(
      newContract(outside.id, {
        contractType: 'FIXED_TERM',
        endDate: daysFromNow(31),
      }),
    );

    const res = await ctx
      .http()
      .get('/contracts/expiring?days=30')
      .set(bearer(fx.hr.token));
    // Each row is `{ contract, daysUntilExpiry }`, not a bare contract — the
    // screen needs the countdown, so the endpoint wraps.
    const ids = rowsOf(res).map((r) => r.contract?.employee?.id);
    expect(ids).toContain(inside.id);
    expect(ids).not.toContain(outside.id);
  });

  it('CON-API-28: two parallel creates for one employee leave exactly one contract', async () => {
    const emp = await seedEmployee();
    const payload = newContract(emp.id);
    const [a, b] = await Promise.all([create(payload), create(payload)]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);

    const rows = await ctx.prisma.contract.findMany({
      where: { employeeId: emp.id, status: 'ACTIVE' },
    });
    expect(rows).toHaveLength(1);
  });

  it('CON-API-30: the labor-law rules are NOT enforced — deliberate, and pinned (P7)', async () => {
    // `ContractValidationService` is still constructed and injected, so the
    // code reads as though it validates. Every rule inside it is commented out.
    // A 15-month probation is accepted; when someone re-enables the service,
    // this case turns red and the change becomes a decision.
    const emp = await seedEmployee();
    const res = await create(
      newContract(emp.id, {
        contractType: 'PROBATION',
        startDate: '2024-01-01',
        endDate: '2025-04-01', // 15 months
      }),
    );
    expect(res.status).toBe(201);
  });

  it('CON-API-31: the literal termination-request routes win over :id', async () => {
    // `termination-requests/pending` and `/history` are declared before the
    // `:id` param route. Latent today only because ids are uuids.
    const pending = await ctx
      .http()
      .get('/contracts/termination-requests/pending')
      .set(bearer(fx.hr.token));
    expect(pending.status).toBe(200);

    const history = await ctx
      .http()
      .get('/contracts/termination-requests/history')
      .set(bearer(fx.hr.token));
    expect(history.status).toBe(200);

    // With no suffix it falls through to `:id` and looks up a contract whose
    // id is the literal string "termination-requests".
    const bare = await ctx
      .http()
      .get('/contracts/termination-requests')
      .set(bearer(fx.hr.token));
    expect([400, 404, 500]).toContain(bare.status);
  });
});
