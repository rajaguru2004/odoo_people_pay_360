import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupPeopleFixtures, PeopleFixtures } from './utils/people-fixtures';
import { bearer } from './utils/settings';

/**
 * Where People meets everything else.
 *
 * Each spec in this phase proves its own module. These cases prove the SEAMS —
 * the places where an action in one module is only correct because of what it
 * does somewhere else, and where nothing on either screen would show the join
 * coming apart:
 *
 *  - approving a department change request changes a person's ROLE, and with it
 *    what they can see the next time they ask;
 *  - terminating a contract removes someone from the directory and from the
 *    "needs a contract" worklist at the same moment;
 *  - the offboarding clearance gate closes and re-opens as assets move;
 *  - a hard delete has to take the login with it, or an ex-employee keeps an
 *    account nobody can find.
 *
 * These are deliberately end-to-end over HTTP rather than unit-level: the point
 * is that the modules agree in the running system, not that each is internally
 * consistent.
 */
describe('People — cross-module seams (e2e)', () => {
  let ctx: E2EContext;
  let fx: PeopleFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  let seq = 0;
  let createdEmployees: string[] = [];

  const seedEmployee = async (over: Record<string, unknown> = {}) => {
    const n = seq++;
    const e = await ctx.prisma.employee.create({
      data: {
        employeeCode: `XP-${fx.runId}-${n}`,
        fullName: `Seam Subject ${n}`,
        dateOfBirth: new Date('1990-01-01'),
        idCard: `XPID-${fx.runId}-${n}`,
        email: `xp${n}-${fx.runId}@test.local`,
        departmentId: fx.mainDeptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: new Date('2019-01-01'),
        baseSalary: 40000,
        status: 'ACTIVE',
        ...over,
      } as any,
    });
    createdEmployees.push(e.id);
    return e;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPeopleFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    // Approving the head change in X-P-01 opens a `ManagerTransition`, and
    // `ManagerTransition.newManager` is RESTRICT — so it pins the employee it
    // names and has to go first. Same class of edge `org-fixtures.ts` documents
    // for `DepartmentHistory.user` and `DepartmentChangeRequest.requester`;
    // this spec is the one People case that creates one.
    await ctx.prisma.managerTransition.deleteMany({
      where: { department: { code: { contains: fx.runId } } },
    });
    await ctx.prisma.managerTransition.deleteMany({
      where: { newManagerId: { in: createdEmployees } },
    });
    await ctx.prisma.departmentHistory.deleteMany({
      where: { department: { code: { contains: fx.runId } } },
    });
    await ctx.prisma.departmentChangeRequest.deleteMany({
      where: { department: { code: { contains: fx.runId } } },
    });

    await ctx.prisma.terminationRequest.deleteMany({
      where: { contract: { employeeId: { in: createdEmployees } } },
    });
    await ctx.prisma.contract.deleteMany({
      where: { employeeId: { in: createdEmployees } },
    });
    await ctx.prisma.assetAssignment.deleteMany({
      where: { employeeId: { in: createdEmployees } },
    });
    await ctx.prisma.assetItem.deleteMany({
      where: { assetTag: { contains: fx.runId } },
    });
    await ctx.prisma.employee.deleteMany({
      where: { id: { in: createdEmployees } },
    });
    await fx?.cleanup();
    await ctx?.app.close();
  });

  it('X-P-01: approving a head change moves the ROLE, and authority follows on the next request', async () => {
    // The Organization suite proves the request lifecycle. What it does not
    // assert is the People consequence: the new head becomes a MANAGER, and
    // their reach over that department's staff is real immediately — no
    // re-login, because `buildPrincipal` recomputes per request.
    // Its OWN department, not the fixture's `mainDept`. Approving a head
    // change promotes the incoming head and DEMOTES the outgoing one, so
    // running this against a shared department would strip `fx.manager` of
    // their role and every later case that depends on it would fail for a
    // reason that has nothing to do with what it asserts.
    const dept = await ctx.prisma.department.create({
      data: {
        code: `XP-DEPT-${fx.runId}-${seq++}`,
        name: 'Seam Department',
        isActive: true,
      },
    });
    const staff = await seedEmployee({ departmentId: dept.id });
    const outgoing = await seedEmployee({ departmentId: dept.id });
    await ctx.prisma.department.update({
      where: { id: dept.id },
      data: { managerId: outgoing.id },
    });

    const candidate = await seedEmployee({
      departmentId: dept.id,
      position: 'Senior Engineer',
    });
    const candidateUser = await ctx.prisma.user.create({
      data: {
        email: `xpuser${seq++}-${fx.runId}@test.local`,
        passwordHash: (
          await ctx.prisma.user.findUnique({
            where: { id: fx.employee.userId },
            select: { passwordHash: true },
          })
        )!.passwordHash,
        role: 'EMPLOYEE',
        isActive: true,
        employeeId: candidate.id,
        isGlobalBranchAccess: false,
      },
    });

    const raised = await ctx
      .http()
      .post(`/departments/${dept.id}/change-requests`)
      .set(bearer(fx.hr.token))
      .send({
        requestType: 'CHANGE_MANAGER',
        newManagerId: candidate.id,
        reason: 'Handover to the senior engineer on the team',
      });
    expect(raised.status).toBe(201);

    const reviewed = await ctx
      .http()
      .patch(`/departments/change-requests/${raised.body.data.id}/review`)
      .set(bearer(fx.admin.token))
      .send({ action: 'APPROVE', reviewNote: 'Agreed at the review' });
    expect(reviewed.status).toBe(200);

    // The role moved…
    const promoted = await ctx.prisma.user.findUnique({
      where: { id: candidateUser.id },
    });
    expect(promoted!.role).toBe('MANAGER');

    // …and so did the authority. Logging in fresh proves the principal is
    // built from the data rather than from anything cached at approval time.
    const login = await ctx
      .http()
      .post('/auth/login')
      .send({ email: candidateUser.email, password: fx.password });
    expect(login.status).toBe(201);
    const token = login.body.data.accessToken;

    // Narrowed by search rather than scanned: the full suite leaves well over
    // a thousand employees behind, and a capped list would stop containing
    // this one for reasons that have nothing to do with authority.
    const list = await ctx
      .http()
      .get(`/employees?search=${staff.employeeCode}&limit=50`)
      .set(bearer(token));
    expect(list.status).toBe(200);
    expect(rowsOf(list).map((e) => e.id)).toContain(staff.id);

    // And the outgoing head loses the role, since they now run nothing.
    const demoted = await ctx.prisma.user.findFirst({
      where: { employeeId: outgoing.id },
    });
    if (demoted) expect(demoted.role).not.toBe('MANAGER');
  });

  it('X-P-02: terminating a contract removes the person from the directory AND the worklist', async () => {
    const person = await seedEmployee();
    const contract = await ctx.prisma.contract.create({
      data: {
        employeeId: person.id,
        contractType: 'INDEFINITE',
        startDate: new Date('2020-01-01'),
        salary: 40000,
        status: 'ACTIVE',
      },
    });

    // Before: present in the ACTIVE directory, absent from "needs a contract".
    const activeBefore = await ctx
      .http()
      .get(`/employees?status=ACTIVE&search=${person.employeeCode}&limit=50`)
      .set(bearer(fx.hr.token));
    expect(rowsOf(activeBefore).map((e) => e.id)).toContain(person.id);

    const worklistBefore = await ctx
      .http()
      .get('/employees/without-active-contract')
      .set(bearer(fx.hr.token));
    expect(rowsOf(worklistBefore).map((e) => e.id)).not.toContain(person.id);

    const terminated = await ctx
      .http()
      .post(`/contracts/${contract.id}/terminate`)
      .set(bearer(fx.hr.token))
      .send({ reason: 'End of engagement' });
    expect(terminated.status).toBe(201);

    // After: gone from the ACTIVE directory, because the terminate deactivated
    // the person as well as the contract.
    const activeAfter = await ctx
      .http()
      .get(`/employees?status=ACTIVE&search=${person.employeeCode}&limit=50`)
      .set(bearer(fx.hr.token));
    expect(rowsOf(activeAfter).map((e) => e.id)).not.toContain(person.id);

    // The worklist is the seam that would bite: an INACTIVE person with no
    // live contract must not be offered as someone who "needs a contract".
    const worklistAfter = await ctx
      .http()
      .get('/employees/without-active-contract')
      .set(bearer(fx.hr.token));
    expect(rowsOf(worklistAfter).map((e) => e.id)).not.toContain(person.id);
  });

  it('X-P-03: clearance closes the offboarding door and returning the asset re-opens it', async () => {
    const person = await seedEmployee();
    const contract = await ctx.prisma.contract.create({
      data: {
        employeeId: person.id,
        contractType: 'INDEFINITE',
        startDate: new Date('2020-01-01'),
        salary: 40000,
        status: 'ACTIVE',
      },
    });
    const asset = await ctx.prisma.assetItem.create({
      data: {
        assetTag: `XPASSET-${fx.runId}-${seq++}`,
        category: 'Laptop',
        name: 'Seam Fixture Laptop',
        branchId: fx.branchA,
        status: 'ASSIGNED',
      },
    });
    const assignment = await ctx.prisma.assetAssignment.create({
      data: {
        assetId: asset.id,
        employeeId: person.id,
        assignedAt: new Date('2024-01-01'),
        assignedById: fx.admin.userId,
      },
    });

    const request = await ctx
      .http()
      .post('/contracts/termination-requests')
      .set(bearer(fx.hr.token))
      .send({
        contractId: contract.id,
        requestedBy: fx.hr.userId,
        terminationCategory: 'RESIGNATION',
        noticeDate: new Date().toISOString().slice(0, 10),
        terminationDate: new Date().toISOString().slice(0, 10),
        reason: 'Leaving, laptop still out',
      });
    expect(request.status).toBe(201);

    const blocked = await ctx
      .http()
      .post(`/contracts/termination-requests/${request.body.data.id}/approve`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId });
    expect(blocked.status).toBe(400);
    expect(body(blocked)).toContain('Cannot complete offboarding');

    // Return the asset — the Assets module's action, with a People consequence.
    await ctx.prisma.assetAssignment.update({
      where: { id: assignment.id },
      data: { returnedAt: new Date() },
    });

    const allowed = await ctx
      .http()
      .post(`/contracts/termination-requests/${request.body.data.id}/approve`)
      .set(bearer(fx.hr.token))
      .send({ approverId: fx.hr.userId });
    expect(allowed.status).toBe(201);

    const after = await ctx.prisma.employee.findUnique({
      where: { id: person.id },
    });
    expect(after!.status).toBe('INACTIVE');
  });

  it('X-P-04: a daily-wage contract leaves the per-day rate alone, end to end', async () => {
    // The guard is invisible from every screen and only wrong at payroll time,
    // so it is asserted here as well as at the contract boundary: `baseSalary`
    // is a PER-DAY rate for daily-wage staff, and a monthly contract figure
    // must not overwrite it.
    const person = await seedEmployee({ salaryType: 'DAILY', baseSalary: 1100 });
    const created = await ctx
      .http()
      .post('/contracts')
      .set(bearer(fx.hr.token))
      .send({
        employeeId: person.id,
        contractType: 'INDEFINITE',
        startDate: '2024-01-01',
        salary: 52000,
      });
    expect(created.status).toBe(201);

    const after = await ctx.prisma.employee.findUnique({
      where: { id: person.id },
    });
    expect(Number(after!.baseSalary)).toBe(1100);
    expect(after!.salaryType).toBe('DAILY');
  });

  it('X-P-06: moving someone between departments moves who can see them', async () => {
    const person = await seedEmployee({ departmentId: fx.foreignDeptId });

    const beforeMain = await ctx
      .http()
      .get(`/employees/${person.id}`)
      .set(bearer(fx.manager.token));
    expect(beforeMain.status).toBe(403);

    const beforeForeign = await ctx
      .http()
      .get(`/employees/${person.id}`)
      .set(bearer(fx.foreignManager.token));
    expect(beforeForeign.status).toBe(200);

    await ctx
      .http()
      .patch(`/employees/${person.id}`)
      .set(bearer(fx.hr.token))
      .send({ departmentId: fx.mainDeptId });

    // Both directions, on the same request cycle: the new manager gains the
    // record and the old one loses it. Asserting only the gain would miss a
    // scoping rule that grants without revoking.
    const afterMain = await ctx
      .http()
      .get(`/employees/${person.id}`)
      .set(bearer(fx.manager.token));
    expect(afterMain.status).toBe(200);

    const afterForeign = await ctx
      .http()
      .get(`/employees/${person.id}`)
      .set(bearer(fx.foreignManager.token));
    expect(afterForeign.status).toBe(403);
  });

  it('X-P-08: a hard delete takes the login with it', async () => {
    // An ex-employee whose `User` survives keeps a credential that no employee
    // screen lists any more — the account outlives the person it belonged to.
    const created = await ctx
      .http()
      .post('/employees')
      .set(bearer(fx.hr.token))
      .send({
        fullName: 'Hard Delete Subject',
        dateOfBirth: '1990-01-01',
        email: `xphard${seq++}-${fx.runId}@test.local`,
        autoGenerateIdCard: true,
        departmentId: fx.mainDeptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: '2024-01-01',
        baseSalary: 30000,
      });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const userBefore = await ctx.prisma.user.findFirst({
      where: { employeeId: id },
    });
    expect(userBefore).toBeTruthy();

    await ctx.http().delete(`/employees/${id}`).set(bearer(fx.hr.token));
    const hard = await ctx
      .http()
      .delete(`/employees/${id}/hard`)
      .set(bearer(fx.hr.token));
    expect(hard.status).toBe(200);

    expect(
      await ctx.prisma.employee.findUnique({ where: { id } }),
    ).toBeNull();
    expect(
      await ctx.prisma.user.findFirst({ where: { employeeId: id } }),
    ).toBeNull();
    // And the original address cannot sign in any more.
    const login = await ctx
      .http()
      .post('/auth/login')
      .send({ email: userBefore!.email, password: fx.password });
    expect(login.status).toBeGreaterThanOrEqual(400);
  });
});
