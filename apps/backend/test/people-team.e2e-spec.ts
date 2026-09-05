import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupPeopleFixtures, PeopleFixtures } from './utils/people-fixtures';
import { bearer } from './utils/settings';

/**
 * Org teams, end to end.
 *
 * This module had no e2e spec at all, and it is the one place in People where
 * the branch engine is simply absent: `Team` and `TeamMember` are not in
 * `src/common/branch/branch-scope.map.ts`, and `src/teams/teams.service.ts`
 * contains no `assertInBranch` and no manager-department check. So the register
 * at the bottom of this file (`TEAM-API-20..25`) is the point of the spec —
 * everything above it is the ordinary CRUD that has to keep working while that
 * gets fixed.
 *
 * Second, sharper problem, found while building the fixtures: supervisor teams
 * are not a separate model. They are `Team` rows with `type: 'SUPERVISION'`,
 * written by `supervisors.service.ts` (which DOES call `assertInBranch`).
 * `TeamsService.findAll` filters them out; `findOne`, `update`, `delete`,
 * `addMember` and `removeMember` do not. So the org door reaches into approval
 * routing — `TEAM-API-26/27`.
 */
describe('People — Teams (e2e)', () => {
  let ctx: E2EContext;
  let fx: PeopleFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  let seq = 0;
  /** Teams created by a case, cleaned up after it so codes never collide. */
  let created: string[] = [];

  const newTeam = (over: Record<string, unknown> = {}) => {
    const n = seq++;
    return {
      name: `Team ${n}`,
      code: `TM-${fx.runId}-${n}`,
      departmentId: fx.mainDeptId,
      ...over,
    };
  };

  const create = async (
    payload: Record<string, unknown>,
    token = fx.hr.token,
  ) => {
    const res = await ctx
      .http()
      .post('/teams')
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
    // A team holding members refuses deletion, so members go first — the same
    // ordering the API itself enforces.
    if (created.length) {
      await ctx.prisma.teamMember.deleteMany({
        where: { teamId: { in: created } },
      });
      await ctx.prisma.team.deleteMany({ where: { id: { in: created } } });
      created = [];
    }
  });

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Read
  // ───────────────────────────────────────────────────────────────────────────

  it('TEAM-API-01: the list answers ADMIN/HR/MANAGER and refuses EMPLOYEE and anon', async () => {
    for (const actor of [fx.admin, fx.hr, fx.manager]) {
      const res = await ctx.http().get('/teams').set(bearer(actor.token));
      expect(res.status).toBe(200);
    }
    expect(
      (await ctx.http().get('/teams').set(bearer(fx.employee.token))).status,
    ).toBe(403);
    expect((await ctx.http().get('/teams')).status).toBe(401);
  });

  it('TEAM-API-02: the list carries its joins and hides supervision teams', async () => {
    const res = await ctx.http().get('/teams').set(bearer(fx.hr.token));
    const rows = rowsOf(res);
    const mine = rows.find((t) => t.id === fx.mainTeamId);
    expect(mine).toBeTruthy();
    expect(mine.department).toBeTruthy();
    expect(mine._count?.members).toBeGreaterThanOrEqual(1);

    // Supervision teams belong to /supervisors/teams; the org list excludes
    // them by `type`. This is the ONE method that does — see TEAM-API-26.
    expect(rows.map((t) => t.id)).not.toContain(fx.supervisionTeamId);
  });

  it('TEAM-API-03: read by id — found, unknown, malformed', async () => {
    expect(
      (
        await ctx.http().get(`/teams/${fx.mainTeamId}`).set(bearer(fx.hr.token))
      ).status,
    ).toBe(200);
    expect(
      (
        await ctx
          .http()
          .get('/teams/00000000-0000-0000-0000-000000000000')
          .set(bearer(fx.hr.token))
      ).status,
    ).toBe(404);
    const malformed = await ctx
      .http()
      .get('/teams/not-a-uuid')
      .set(bearer(fx.hr.token));
    // Same missing-pipe shape as P27 on employees.
    expect([400, 404, 500]).toContain(malformed.status);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Create / update / delete
  // ───────────────────────────────────────────────────────────────────────────

  it('TEAM-API-04: a minimal create defaults type and isActive', async () => {
    const res = await create(newTeam());
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('PERMANENT');
    expect(res.body.data.isActive).toBe(true);
  });

  it('TEAM-API-05: all three team types are accepted', async () => {
    for (const type of ['PERMANENT', 'PROJECT', 'CROSS_FUNCTIONAL']) {
      const res = await create(newTeam({ type }));
      expect(res.status).toBe(201);
      expect(res.body.data.type).toBe(type);
    }
  });

  it('TEAM-API-06: a duplicate code is a 409', async () => {
    const first = newTeam();
    expect((await create(first)).status).toBe(201);
    const dup = await create(newTeam({ code: first.code }));
    expect(dup.status).toBe(409);
    expect(body(dup)).toContain('Team code already exists');
  });

  it('TEAM-API-07: the department must exist and be active', async () => {
    const missing = await create(
      newTeam({ departmentId: '00000000-0000-0000-0000-000000000000' }),
    );
    expect(missing.status).toBe(400);
    expect(body(missing)).toContain('Department not found');

    const inactive = await create(newTeam({ departmentId: fx.inactiveDeptId }));
    expect(inactive.status).toBe(400);
    expect(body(inactive)).toContain('inactive department');
  });

  it('TEAM-API-08: the team lead must exist, share the department, and be active', async () => {
    const unknown = await create(
      newTeam({ teamLeadId: '00000000-0000-0000-0000-000000000000' }),
    );
    expect(unknown.status).toBe(400);
    expect(body(unknown)).toContain('Team lead not found');

    // staffBranchB sits in foreignDept.
    const wrongDept = await create(newTeam({ teamLeadId: fx.staffBranchBId }));
    expect(wrongDept.status).toBe(400);
    expect(body(wrongDept)).toContain('same department');

    const inactiveEmp = await ctx.prisma.employee.create({
      data: {
        employeeCode: `TML-${fx.runId}-${seq++}`,
        fullName: 'Inactive Lead',
        dateOfBirth: new Date('1990-01-01'),
        idCard: `TMLID-${fx.runId}-${seq}`,
        email: `tml${seq}-${fx.runId}@test.local`,
        departmentId: fx.mainDeptId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: new Date('2020-01-01'),
        baseSalary: 1000,
        status: 'INACTIVE',
      },
    });
    const notActive = await create(newTeam({ teamLeadId: inactiveEmp.id }));
    expect(notActive.status).toBe(400);
    expect(body(notActive)).toContain('active employee');
  });

  it('TEAM-API-09: the DTO refuses malformed input', async () => {
    for (const over of [
      { name: 'x'.repeat(256) },
      { code: 'x'.repeat(51) },
      { departmentId: 'nope' },
      { type: 'SQUAD' },
    ]) {
      const res = await create(newTeam(over));
      expect(res.status).toBe(400);
    }
  });

  it('TEAM-API-10: MANAGER and EMPLOYEE cannot create a team', async () => {
    expect((await create(newTeam(), fx.manager.token)).status).toBe(403);
    expect((await create(newTeam(), fx.employee.token)).status).toBe(403);
  });

  it('TEAM-API-11: update renames, and a taken code is refused while its own is not', async () => {
    const a = await create(newTeam());
    const b = await create(newTeam());

    const rename = await ctx
      .http()
      .patch(`/teams/${a.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ name: 'Renamed' });
    expect(rename.status).toBe(200);
    expect(rename.body.data.name).toBe('Renamed');

    const taken = await ctx
      .http()
      .patch(`/teams/${a.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ code: b.body.data.code });
    expect(taken.status).toBe(409);

    const own = await ctx
      .http()
      .patch(`/teams/${a.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ code: a.body.data.code });
    expect(own.status).toBe(200);
  });

  it('TEAM-API-12/13: an empty team deletes; one holding members does not', async () => {
    const holding = await create(newTeam());
    const add = await ctx
      .http()
      .post(`/teams/${holding.body.data.id}/members`)
      .set(bearer(fx.hr.token))
      .send({ employeeId: fx.activeStaff[0] });
    expect(add.status).toBe(201);

    const blocked = await ctx
      .http()
      .delete(`/teams/${holding.body.data.id}`)
      .set(bearer(fx.hr.token));
    expect(blocked.status).toBe(400);
    expect(body(blocked)).toContain('Remove all members first');

    const empty = await create(newTeam());
    const gone = await ctx
      .http()
      .delete(`/teams/${empty.body.data.id}`)
      .set(bearer(fx.hr.token));
    expect(gone.status).toBe(200);

    // Soft delete: the row survives with isActive false and drops out of the list.
    const row = await ctx.prisma.team.findUnique({
      where: { id: empty.body.data.id },
    });
    expect(row?.isActive).toBe(false);
    const list = await ctx.http().get('/teams').set(bearer(fx.hr.token));
    expect(rowsOf(list).map((t) => t.id)).not.toContain(empty.body.data.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Members
  // ───────────────────────────────────────────────────────────────────────────

  it('TEAM-API-14: every member role is accepted', async () => {
    const team = await create(newTeam());
    const id = team.body.data.id;
    const roles = ['LEAD', 'SENIOR', 'MEMBER', 'CONTRIBUTOR'];
    for (let i = 0; i < roles.length; i++) {
      const res = await ctx
        .http()
        .post(`/teams/${id}/members`)
        .set(bearer(fx.hr.token))
        .send({ employeeId: fx.activeStaff[i % 3], role: roles[i] });
      // activeStaff has 3 entries, so the 4th repeats one — that one is the
      // duplicate case, asserted in TEAM-API-16.
      expect([201, 409]).toContain(res.status);
    }
  });

  it('TEAM-API-15: allocation is bounded at 0 and 100', async () => {
    const team = await create(newTeam());
    const id = team.body.data.id;
    const add = (allocationPercentage: number, employeeId: string) =>
      ctx
        .http()
        .post(`/teams/${id}/members`)
        .set(bearer(fx.hr.token))
        .send({ employeeId, allocationPercentage });

    expect((await add(0, fx.activeStaff[0])).status).toBe(201);
    expect((await add(100, fx.activeStaff[1])).status).toBe(201);
    expect((await add(101, fx.activeStaff[2])).status).toBe(400);
    expect((await add(-1, fx.activeStaff[2])).status).toBe(400);
  });

  it('TEAM-API-16: a member must be active, in the department, and not already in', async () => {
    const team = await create(newTeam());
    const id = team.body.data.id;

    const first = await ctx
      .http()
      .post(`/teams/${id}/members`)
      .set(bearer(fx.hr.token))
      .send({ employeeId: fx.activeStaff[0] });
    expect(first.status).toBe(201);

    const again = await ctx
      .http()
      .post(`/teams/${id}/members`)
      .set(bearer(fx.hr.token))
      .send({ employeeId: fx.activeStaff[0] });
    expect(again.status).toBe(409);
    expect(body(again)).toContain('already a member');

    const foreign = await ctx
      .http()
      .post(`/teams/${id}/members`)
      .set(bearer(fx.hr.token))
      .send({ employeeId: fx.staffBranchBId });
    expect(foreign.status).toBe(400);
    expect(body(foreign)).toContain('same department');
  });

  it('TEAM-API-18: an inactive team refuses new members', async () => {
    const team = await create(newTeam());
    const id = team.body.data.id;
    await ctx.http().delete(`/teams/${id}`).set(bearer(fx.hr.token));

    const res = await ctx
      .http()
      .post(`/teams/${id}/members`)
      .set(bearer(fx.hr.token))
      .send({ employeeId: fx.activeStaff[0] });
    expect(res.status).toBe(404);
    expect(body(res)).toContain('not found or inactive');
  });

  it('TEAM-API-19: removing a member is idempotent-by-404, and removal is soft', async () => {
    const team = await create(newTeam());
    const id = team.body.data.id;
    const added = await ctx
      .http()
      .post(`/teams/${id}/members`)
      .set(bearer(fx.hr.token))
      .send({ employeeId: fx.activeStaff[0] });
    const memberId = added.body.data.id;

    const gone = await ctx
      .http()
      .delete(`/teams/${id}/members/${memberId}`)
      .set(bearer(fx.hr.token));
    expect(gone.status).toBe(200);

    const row = await ctx.prisma.teamMember.findUnique({
      where: { id: memberId },
    });
    expect(row?.isActive).toBe(false);
    expect(row?.endDate).toBeTruthy();

    // A soft-removed member no longer blocks the team's deletion.
    const del = await ctx.http().delete(`/teams/${id}`).set(bearer(fx.hr.token));
    expect(del.status).toBe(200);

    const unknown = await ctx
      .http()
      .delete(`/teams/${id}/members/00000000-0000-0000-0000-000000000000`)
      .set(bearer(fx.hr.token));
    expect(unknown.status).toBe(404);
  });

  it('TEAM-API-25: teams-by-employee answers each role', async () => {
    const res = await ctx
      .http()
      .get(`/teams/employee/${fx.activeStaff[0]}`)
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(200);

    const self = await ctx
      .http()
      .get(`/teams/employee/${fx.employee.employeeId}`)
      .set(bearer(fx.employee.token));
    expect(self.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The scoping register — KNOWN GAP (P1)
  //
  // Every case below asserts what the server does TODAY and is paired with an
  // `it.failing` twin naming what it should do. They are the reason this spec
  // exists.
  // ───────────────────────────────────────────────────────────────────────────

  it('TEAM-API-20: the list is filtered to the caller’s branch envelope', async () => {
    // WAS (P1): `Team` and `TeamMember` are not in `branch-scope.map.ts`, and
    // they cannot be — a team has no `branchId` and neither does a Department.
    // NOW the Teams module uses the rule the Organization module already
    // settled on: a department is in scope if it has staff in the caller's
    // envelope, or no staff at all.
    const res = await ctx.http().get('/teams').set(bearer(fx.scopedHr.token));
    expect(res.status).toBe(200);
    const ids = rowsOf(res).map((t) => t.id);
    expect(ids).toContain(fx.mainTeamId);
    expect(ids).not.toContain(fx.foreignTeamId);
  });

  it('TEAM-API-21: a foreign-branch team is 404 by id — no existence leak', async () => {
    const read = await ctx
      .http()
      .get(`/teams/${fx.foreignTeamId}`)
      .set(bearer(fx.scopedHr.token));
    expect(read.status).toBe(404);

    // 404 on the write doors too: a 403 there would confirm the row exists.
    const write = await ctx
      .http()
      .patch(`/teams/${fx.foreignTeamId}`)
      .set(bearer(fx.scopedHr.token))
      .send({ name: 'Renamed from outside the branch' });
    expect(write.status).toBe(404);

    const del = await ctx
      .http()
      .delete(`/teams/${fx.foreignTeamId}`)
      .set(bearer(fx.scopedHr.token));
    expect(del.status).toBe(404);

    // Unchanged, which is the assertion the status code alone would not make.
    const row = await ctx.prisma.team.findUnique({
      where: { id: fx.foreignTeamId },
    });
    expect(row!.name).toBe('People Foreign Team');
    expect(row!.isActive).toBe(true);
  });

  it('TEAM-API-22: a MANAGER cannot create a team under a department they do not head', async () => {
    // Refused by role before scoping even applies — POST /teams is ADMIN/HR.
    const res = await create(
      newTeam({ departmentId: fx.foreignDeptId }),
      fx.manager.token,
    );
    expect(res.status).toBe(403);
  });

  it('TEAM-API-23: a MANAGER cannot staff a team outside their departments', async () => {
    const res = await ctx
      .http()
      .post(`/teams/${fx.foreignTeamId}/members`)
      .set(bearer(fx.manager.token))
      .send({ employeeId: fx.staffBranchBId });
    expect(res.status).toBe(403);
    expect(body(res)).toContain('outside your department');

    // …and their own department still works, so the guard narrowed rather than
    // simply closed the door.
    const own = await ctx
      .http()
      .post(`/teams/${fx.mainTeamId}/members`)
      .set(bearer(fx.manager.token))
      .send({ employeeId: fx.activeStaff[1] });
    expect(own.status).toBe(201);
    await ctx.prisma.teamMember.deleteMany({
      where: { teamId: fx.mainTeamId, employeeId: fx.activeStaff[1] },
    });
  });

  it('TEAM-API-24: a MANAGER’s list shows only the departments they head', async () => {
    const res = await ctx.http().get('/teams').set(bearer(fx.manager.token));
    expect(res.status).toBe(200);
    const ids = rowsOf(res).map((t) => t.id);
    expect(ids).toContain(fx.mainTeamId);
    expect(ids).not.toContain(fx.foreignTeamId);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The supervision cross-reach — KNOWN GAP (P25)
  // ───────────────────────────────────────────────────────────────────────────

  it('TEAM-API-26: a supervision team is invisible to the org Teams API', async () => {
    // WAS (P25): `findAll` filtered `type: { not: 'SUPERVISION' }` but every
    // by-id method used a bare `findUnique`, so the org door could read,
    // rename, delete and re-staff an approval chain. NOW: one `ORG_TEAM_ONLY`
    // filter is applied by every door onto this table.
    const res = await ctx
      .http()
      .get(`/teams/${fx.supervisionTeamId}`)
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(404);
  });

  it('TEAM-API-27: the org Teams API cannot mutate or delete a supervision team', async () => {
    const del = await ctx
      .http()
      .delete(`/teams/${fx.supervisionTeamId}`)
      .set(bearer(fx.hr.token));
    expect(del.status).toBe(404);

    const rename = await ctx
      .http()
      .patch(`/teams/${fx.supervisionTeamId}`)
      .set(bearer(fx.hr.token))
      .send({ name: 'Renamed through the wrong door' });
    expect(rename.status).toBe(404);

    const member = await ctx.prisma.teamMember.findFirst({
      where: { teamId: fx.supervisionTeamId, isActive: true },
    });
    const remove = await ctx
      .http()
      .delete(`/teams/${fx.supervisionTeamId}/members/${member!.id}`)
      .set(bearer(fx.hr.token));
    expect(remove.status).toBe(404);

    const add = await ctx
      .http()
      .post(`/teams/${fx.supervisionTeamId}/members`)
      .set(bearer(fx.hr.token))
      .send({ employeeId: fx.activeStaff[0] });
    expect(add.status).toBe(404);

    // The chain it expresses is untouched, which is the whole point.
    const routed = await ctx.prisma.employee.findUnique({
      where: { id: fx.activeStaff[2] },
      select: { supervisorId: true },
    });
    expect(routed?.supervisorId).toBe(fx.manager.employeeId);
  });

  it('TEAM-API-28: a team cannot reach across the branch boundary to staff itself', async () => {
    // `addMember` takes a bare employeeId, so this was the cheapest way to pull
    // someone from another branch into a team. 404, not 403 — the boundary must
    // not confirm the id exists.
    const res = await ctx
      .http()
      .post(`/teams/${fx.mainTeamId}/members`)
      .set(bearer(fx.scopedHr.token))
      .send({ employeeId: fx.staffBranchBId });
    expect(res.status).toBe(404);
  });
});
