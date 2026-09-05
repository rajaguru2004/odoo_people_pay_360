import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupPeopleFixtures, PeopleFixtures } from './utils/people-fixtures';
import { bearer } from './utils/settings';

/**
 * Supervisor teams — the approval-chain grouping behind
 * `/dashboard/supervisor-teams`.
 *
 * Deliberately thin. `supervisor-approval.e2e-spec.ts` already owns what these
 * teams DO (routing a leave or overtime request to the right approver); this
 * spec covers only the CRUD door and its RBAC, which nothing covered.
 *
 * The one thing worth stating up front: these are `Team` rows with
 * `type: 'SUPERVISION'`, the same table the org Teams API reads. That overlap
 * is finding P25 and is asserted from the other side in
 * `people-team.e2e-spec.ts`; here it matters only because creating one is what
 * assigns `Employee.supervisorId`, so the membership and the routing have to
 * move together.
 */
describe('People — Supervisor teams (e2e)', () => {
  let ctx: E2EContext;
  let fx: PeopleFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  let seq = 0;
  let created: string[] = [];

  const create = async (
    payload: Record<string, unknown>,
    token = fx.hr.token,
  ) => {
    const res = await ctx
      .http()
      .post('/supervisors/teams')
      .set(bearer(token))
      .send(payload);
    if (res.status === 201 && res.body?.data?.id) created.push(res.body.data.id);
    return res;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPeopleFixtures(ctx);
  }, 180000);

  afterEach(async () => {
    if (created.length) {
      await ctx.prisma.teamMember.deleteMany({
        where: { teamId: { in: created } },
      });
      await ctx.prisma.team.deleteMany({ where: { id: { in: created } } });
      created = [];
    }
    // Creating a supervisor team writes supervisorId onto its members, so the
    // fixture's own routing has to be restored or the next case inherits it.
    await ctx.prisma.employee.updateMany({
      where: { id: { in: [fx.activeStaff[0], fx.activeStaff[1]] } },
      data: { supervisorId: null },
    });
  });

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  });

  it('STEAM-API-01: the list and read are ADMIN/HR only', async () => {
    for (const actor of [fx.admin, fx.hr]) {
      expect(
        (
          await ctx
            .http()
            .get('/supervisors/teams')
            .set(bearer(actor.token))
        ).status,
      ).toBe(200);
    }
    // The screen has no ProtectedRoute and lets a MANAGER in; the server does
    // not. That mismatch is finding P24 — the client admits a role the server
    // refuses, so a manager reaches a page that can only fail.
    for (const actor of [fx.manager, fx.employee]) {
      expect(
        (
          await ctx
            .http()
            .get('/supervisors/teams')
            .set(bearer(actor.token))
        ).status,
      ).toBe(403);
    }
    expect((await ctx.http().get('/supervisors/teams')).status).toBe(401);
  });

  it('STEAM-API-02: the list carries only SUPERVISION teams', async () => {
    const res = await ctx
      .http()
      .get('/supervisors/teams')
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(200);
    const ids = rowsOf(res).map((t) => t.id);
    expect(ids).toContain(fx.supervisionTeamId);
    // The org team from the same fixture must not appear here.
    expect(ids).not.toContain(fx.mainTeamId);
  });

  it('STEAM-API-03: creating a team points its members at the supervisor', async () => {
    const res = await create({
      name: `Sup Team ${seq++}`,
      supervisorId: fx.manager.employeeId,
      memberIds: [fx.activeStaff[0], fx.activeStaff[1]],
    });
    expect(res.status).toBe(201);

    // The membership is the visible half; the routing is the half that matters
    // and that no screen shows.
    const members = await ctx.prisma.employee.findMany({
      where: { id: { in: [fx.activeStaff[0], fx.activeStaff[1]] } },
      select: { supervisorId: true },
    });
    expect(members.map((m) => m.supervisorId)).toEqual([
      fx.manager.employeeId,
      fx.manager.employeeId,
    ]);
  });

  it('STEAM-API-04: a supervisor never supervises themselves', async () => {
    const res = await create({
      name: `Sup Team ${seq++}`,
      supervisorId: fx.manager.employeeId,
      memberIds: [fx.manager.employeeId!, fx.activeStaff[0]],
    });
    expect(res.status).toBe(201);

    const team = await ctx.prisma.team.findUnique({
      where: { id: res.body.data.id },
      include: { members: true },
    });
    expect(team!.members.map((m) => m.employeeId)).not.toContain(
      fx.manager.employeeId,
    );
  });

  it('STEAM-API-05: the supervisor must exist and be active', async () => {
    const unknown = await create({
      name: `Sup Team ${seq++}`,
      supervisorId: '00000000-0000-0000-0000-000000000000',
    });
    expect(unknown.status).toBe(404);
    expect(body(unknown)).toContain('Supervisor not found');

    const inactive = await ctx.prisma.employee.create({
      data: {
        employeeCode: `SUPX-${fx.runId}-${seq++}`,
        fullName: 'Inactive Supervisor',
        dateOfBirth: new Date('1990-01-01'),
        idCard: `SUPXID-${fx.runId}-${seq}`,
        email: `supx${seq}-${fx.runId}@test.local`,
        departmentId: fx.mainDeptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: new Date('2020-01-01'),
        baseSalary: 1000,
        status: 'INACTIVE',
      },
    });
    const notActive = await create({
      name: `Sup Team ${seq++}`,
      supervisorId: inactive.id,
    });
    expect(notActive.status).toBe(400);
    expect(body(notActive)).toContain('active employee');
  });

  it('STEAM-API-06: this door IS branch-scoped, unlike the org Teams door', async () => {
    // `supervisors.service.ts` calls `assertInBranch(supervisor.branchId)`.
    // `teams.service.ts` calls nothing. Same table, two doors, one of them
    // guarded — which is exactly why P1 reads as an omission rather than a
    // design choice.
    const res = await create(
      {
        name: `Sup Team ${seq++}`,
        supervisorId: fx.foreignManager.employeeId,
      },
      fx.scopedHr.token,
    );
    expect(res.status).toBe(404);
  });

  it('STEAM-API-07: update renames and re-points the chain', async () => {
    const team = await create({
      name: `Sup Team ${seq++}`,
      supervisorId: fx.manager.employeeId,
      memberIds: [fx.activeStaff[0]],
    });
    const res = await ctx
      .http()
      .patch(`/supervisors/teams/${team.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ name: 'Renamed Supervision' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed Supervision');
  });

  it('STEAM-API-08: delete removes the team', async () => {
    const team = await create({
      name: `Sup Team ${seq++}`,
      supervisorId: fx.manager.employeeId,
    });
    const res = await ctx
      .http()
      .delete(`/supervisors/teams/${team.body.data.id}`)
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(200);

    const list = await ctx
      .http()
      .get('/supervisors/teams')
      .set(bearer(fx.hr.token));
    expect(rowsOf(list).map((t) => t.id)).not.toContain(team.body.data.id);
  });

  it('STEAM-API-09: write routes are closed to MANAGER and EMPLOYEE', async () => {
    for (const actor of [fx.manager, fx.employee]) {
      const res = await create(
        { name: `Sup Team ${seq++}`, supervisorId: fx.manager.employeeId },
        actor.token,
      );
      expect(res.status).toBe(403);
    }
  });

  it('STEAM-API-10: my-team answers every role for their own chain', async () => {
    for (const actor of [fx.admin, fx.hr, fx.manager, fx.employee]) {
      const res = await ctx
        .http()
        .get('/supervisors/my-team')
        .set(bearer(actor.token));
      expect(res.status).toBe(200);
    }
    expect((await ctx.http().get('/supervisors/my-team')).status).toBe(401);
  });
});
