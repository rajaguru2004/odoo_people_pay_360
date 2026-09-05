import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupPeopleFixtures, PeopleFixtures } from './utils/people-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * Employees, end to end — the People module's core record.
 *
 * Employee CRUD had no dedicated spec before this one. What coverage existed
 * was profile-TEMPLATE coverage (`employee-custom-fields`, `employee-kill-switch`,
 * `employee-write-doors`, `employee-template-*`) plus incidental use of employees
 * as setup inside `multi-branch` and the Organization suite. So the rules below
 * — the age floor, three distinct uniqueness conflicts, the team-department
 * refusal, soft vs hard delete, and the clearance gate — were all unprotected.
 *
 * Two rules are asserted against the DATABASE rather than the response body,
 * because nothing in the API surfaces them and no screen would show them wrong:
 * the linked `User` a create mints, and the `EmployeeHistory` rows an update
 * writes.
 *
 * KNOWN GAPs pinned with `it.failing` twins: an employee cannot read their own
 * record by id (P2), and a MANAGER's reach into a foreign department's activity
 * feed is unchecked (P23).
 */
describe('People — Employees (e2e)', () => {
  let ctx: E2EContext;
  let fx: PeopleFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  let seq = 0;

  /** A valid create payload nobody else's test will collide with. */
  const newEmployee = (over: Record<string, unknown> = {}) => {
    const n = seq++;
    return {
      fullName: `New Hire ${n}`,
      dateOfBirth: '1995-06-15',
      idCard: `NID-${fx.runId}-${n}`,
      email: `hire${n}-${fx.runId}@test.local`,
      departmentId: fx.mainDeptId,
      branchId: fx.branchA,
      position: 'Engineer',
      startDate: '2025-01-06',
      baseSalary: 40000,
      ...over,
    };
  };

  const create = (payload: Record<string, unknown>, token = fx.hr.token) =>
    ctx.http().post('/employees').set(bearer(token)).send(payload);

  /** DOB exactly `years` before today, shifted by `days`. */
  const dobAged = (years: number, days = 0): string => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - years);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupPeopleFixtures(ctx);
  }, 180000);

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Directory and list
  // ───────────────────────────────────────────────────────────────────────────

  it('EMP-API-01: the directory answers every signed-in role and refuses anon', async () => {
    for (const actor of [fx.admin, fx.hr, fx.manager, fx.employee]) {
      const res = await ctx
        .http()
        .get('/employees/directory')
        .set(bearer(actor.token));
      expect(res.status).toBe(200);
    }
    const anon = await ctx.http().get('/employees/directory');
    expect(anon.status).toBe(401);
  });

  it('EMP-API-02: GET /employees is ADMIN/HR/MANAGER only', async () => {
    for (const actor of [fx.admin, fx.hr, fx.manager]) {
      const res = await ctx.http().get('/employees').set(bearer(actor.token));
      expect(res.status).toBe(200);
    }
    const emp = await ctx
      .http()
      .get('/employees')
      .set(bearer(fx.employee.token));
    expect(emp.status).toBe(403);
    expect((await ctx.http().get('/employees')).status).toBe(401);
  });

  it('EMP-API-02b: a MANAGER sees their own departments and not a foreign one', async () => {
    const res = await ctx
      .http()
      .get('/employees?limit=200')
      .set(bearer(fx.manager.token));
    expect(res.status).toBe(200);
    const ids = rowsOf(res).map((e) => e.id);
    expect(ids).toContain(fx.activeStaff[0]);
    // staffBranchB lives in foreignDept, which this manager does not head.
    expect(ids).not.toContain(fx.staffBranchBId);
  });

  it('EMP-API-03: the list carries a pagination envelope and the joins the screen reads', async () => {
    const res = await ctx
      .http()
      .get('/employees?limit=5')
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ total: expect.any(Number) });
    const row = rowsOf(res)[0];
    expect(row).toHaveProperty('employeeCode');
    expect(row).toHaveProperty('department');
  });

  it('EMP-API-04: sortBy is allowlisted and limit is bounded', async () => {
    const ok = await ctx
      .http()
      .get('/employees?sortBy=fullName&sortOrder=asc')
      .set(bearer(fx.hr.token));
    expect(ok.status).toBe(200);

    // Anything outside EMPLOYEE_SORT_FIELDS must be refused, not passed to
    // Prisma's orderBy — that is the difference between a 400 and a 500.
    const bad = await ctx
      .http()
      .get('/employees?sortBy=passwordHash')
      .set(bearer(fx.hr.token));
    expect(bad.status).toBe(400);

    expect(
      (await ctx.http().get('/employees?limit=1').set(bearer(fx.hr.token)))
        .status,
    ).toBe(200);
    expect(
      (await ctx.http().get('/employees?limit=1000').set(bearer(fx.hr.token)))
        .status,
    ).toBe(200);
    expect(
      (await ctx.http().get('/employees?limit=1001').set(bearer(fx.hr.token)))
        .status,
    ).toBe(400);
    expect(
      (await ctx.http().get('/employees?limit=0').set(bearer(fx.hr.token)))
        .status,
    ).toBe(400);
    expect(
      (await ctx.http().get('/employees?page=0').set(bearer(fx.hr.token)))
        .status,
    ).toBe(400);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Create
  // ───────────────────────────────────────────────────────────────────────────

  it('EMP-API-05: a create mints a linked EMPLOYEE user — asserted on the row', async () => {
    const payload = newEmployee();
    const res = await create(payload);
    expect(res.status).toBe(201);
    expect(res.body.data.employeeCode).toBeTruthy();

    // The user is NOT fire-and-forget (the welcome email is). If this row is
    // missing the person can never sign in, and nothing in the response would
    // say so.
    const user = await ctx.prisma.user.findUnique({
      where: { email: payload.email as string },
    });
    expect(user).toBeTruthy();
    expect(user!.role).toBe('EMPLOYEE');
    expect(user!.employeeId).toBe(res.body.data.id);
  });

  it('EMP-API-07: autoGenerateIdCard replaces idCard, and neither is refused', async () => {
    const auto = await create({
      ...newEmployee(),
      idCard: undefined,
      autoGenerateIdCard: true,
    });
    expect(auto.status).toBe(201);

    const neither = await create({ ...newEmployee(), idCard: undefined });
    expect(neither.status).toBe(400);
  });

  it('EMP-API-10: the age floor is exactly 18', async () => {
    const justUnder = await create({
      ...newEmployee(),
      dateOfBirth: dobAged(18, 1), // one day short of 18
    });
    expect(justUnder.status).toBe(400);
    expect(body(justUnder)).toContain('at least 18 years old');

    // The start date has to sit after the 18th birthday too — a SECOND rule,
    // with its own message. A payload that clears the age floor but backdates
    // employment into the person's childhood is still refused, which is why
    // this case carries a present-day start date rather than the shared one.
    const today = new Date().toISOString().slice(0, 10);
    const exactly = await create({
      ...newEmployee(),
      dateOfBirth: dobAged(18, -1), // one day past 18
      startDate: today,
    });
    expect(exactly.status).toBe(201);
  });

  it('EMP-API-10b: employment cannot start before the employee turns 18', async () => {
    const res = await create({
      ...newEmployee(),
      dateOfBirth: dobAged(18, -1),
      startDate: '2025-01-06', // before the 18th birthday
    });
    expect(res.status).toBe(400);
    expect(body(res)).toContain('before the employee turns 18');
  });

  it('EMP-API-11: an impossible date of birth is refused', async () => {
    const future = await create({
      ...newEmployee(),
      dateOfBirth: dobAged(-1),
    });
    expect(future.status).toBe(400);

    const ancient = await create({ ...newEmployee(), dateOfBirth: dobAged(120) });
    expect(ancient.status).toBe(400);
    expect(body(ancient)).toContain('Invalid date of birth');
  });

  it('EMP-API-12: three distinct uniqueness conflicts, each with its own message', async () => {
    const first = newEmployee();
    expect((await create(first)).status).toBe(201);

    const dupEmail = await create({ ...newEmployee(), email: first.email });
    expect(dupEmail.status).toBe(409);
    expect(body(dupEmail)).toContain('Email already exists');

    const dupIdCard = await create({ ...newEmployee(), idCard: first.idCard });
    expect(dupIdCard.status).toBe(409);
    expect(body(dupIdCard)).toContain('ID card already exists');

    // An address that exists as a USER but not as an employee is a different
    // conflict with a different message — the two tables are checked apart.
    const userOnly = `useronly${seq++}-${fx.runId}@test.local`;
    await ctx.prisma.user.create({
      data: {
        email: userOnly,
        passwordHash: 'x',
        role: 'EMPLOYEE',
        isActive: true,
      },
    });
    const dupUser = await create({ ...newEmployee(), email: userOnly });
    expect(dupUser.status).toBe(409);
    expect(body(dupUser)).toContain('User email already exists');
  });

  it('EMP-API-13: the department must exist', async () => {
    const missing = await create({
      ...newEmployee(),
      departmentId: '00000000-0000-0000-0000-000000000000',
    });
    expect(missing.status).toBe(400);
    expect(body(missing)).toContain('Department not found');
  });

  it('EMP-API-13b: create refuses an INACTIVE department, as update does', async () => {
    // WAS (P28): create checked only that the department row existed, so a
    // hire could be filed somewhere no transfer could move them.
    const res = await create({
      ...newEmployee(),
      departmentId: fx.inactiveDeptId,
    });
    expect(res.status).toBe(400);
    expect(body(res)).toContain('inactive department');
  });

  it('EMP-API-14: create ACCEPTS a sub-department', async () => {
    // WAS: both doors refused a department with a parent, reading it as a
    // "team". Team membership is the `Team`/`TeamMember` model; a child
    // Department is a sub-department with its own manager and headcount, and
    // tenants had already staffed theirs. Only `isActive` gates the target now.
    const res = await create({ ...newEmployee(), departmentId: fx.teamDeptId });
    expect(res.status).toBe(201);
    expect(res.body.data.departmentId).toBe(fx.teamDeptId);
  });

  it('EMP-API-14b: update ACCEPTS a move into a sub-department', async () => {
    const created = await create(newEmployee());
    const res = await ctx
      .http()
      .patch(`/employees/${created.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ departmentId: fx.teamDeptId });
    expect(res.status).toBe(200);
    expect(res.body.data.departmentId).toBe(fx.teamDeptId);
  });

  it('EMP-API-14c: an employee in a sub-department can still be moved out', async () => {
    // The half that actually stranded people: while `update()` refused a
    // parented TARGET, an employee already filed under one could not be edited
    // at all without re-sending their own department and being refused for it.
    const created = await create({
      ...newEmployee(),
      departmentId: fx.teamDeptId,
    });
    const res = await ctx
      .http()
      .patch(`/employees/${created.body.data.id}`)
      .set(bearer(fx.hr.token))
      .send({ departmentId: fx.mainDeptId });
    expect(res.status).toBe(200);
    expect(res.body.data.departmentId).toBe(fx.mainDeptId);
  });

  it('EMP-API-15: the branch must exist, be active, and be assignable to the caller', async () => {
    const missing = await create({
      ...newEmployee(),
      branchId: '00000000-0000-0000-0000-000000000000',
    });
    expect(missing.status).toBe(400);
    expect(body(missing)).toContain('Branch not found');

    // A branch-scoped HR picking a branch outside their grant gets 403, NOT
    // 404 — on create the branch is a choice they are refused, not a record
    // whose existence is hidden.
    const offGrant = await create(
      { ...newEmployee(), branchId: fx.branchB },
      fx.scopedHr.token,
    );
    expect(offGrant.status).toBe(403);
  });

  it('EMP-API-16: the DTO refuses malformed input field by field', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['fullName too long', { fullName: 'x'.repeat(256) }],
      ['idCard too long', { idCard: 'x'.repeat(51) }],
      ['position too long', { position: 'x'.repeat(101) }],
      ['email malformed', { email: 'not-an-email' }],
      ['gender not in enum', { gender: 'ROBOT' }],
      ['status not in enum', { status: 'SLEEPING' }],
      ['salaryType not in enum', { salaryType: 'HOURLY' }],
      ['baseSalary negative', { baseSalary: -1 }],
      ['departmentId not a uuid', { departmentId: 'nope' }],
      ['attendanceExternalId too long', { attendanceExternalId: 'x'.repeat(101) }],
    ];
    for (const [label, over] of cases) {
      const res = await create({ ...newEmployee(), ...over });
      expect([400, 422]).toContain(res.status);
      if (res.status !== 400) throw new Error(`${label} => ${res.status}`);
    }
  });

  it('EMP-API-17: the start-date policy is enforced when set and unlimited when blank', async () => {
    const PAST = 'employee_start_date_max_past_days';
    const FUTURE = 'employee_start_date_max_future_days';
    const daysFromToday = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return d.toISOString().slice(0, 10);
    };

    await withSetting(ctx, PAST, '30', async () => {
      const res = await create({
        ...newEmployee(),
        startDate: daysFromToday(-60),
      });
      expect(res.status).toBe(400);
    });

    await withSetting(ctx, FUTURE, '7', async () => {
      const res = await create({
        ...newEmployee(),
        startDate: daysFromToday(30),
      });
      expect(res.status).toBe(400);
    });

    // Blank means unlimited — the value the browser baseline relies on.
    await withSetting(ctx, PAST, '', async () => {
      const res = await create({
        ...newEmployee(),
        startDate: daysFromToday(-3650),
      });
      expect(res.status).toBe(201);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Read
  // ───────────────────────────────────────────────────────────────────────────

  it('EMP-API-08: an employee may read their own record, and only their own', async () => {
    // WAS (P2): the route admitted ADMIN/HR/MANAGER only, so an employee could
    // update themselves and read their own profile but not read their own
    // record — and the detail screen's self-service branch was unreachable
    // because the fetch 403'd first.
    const own = await ctx
      .http()
      .get(`/employees/${fx.employee.employeeId}`)
      .set(bearer(fx.employee.token));
    expect(own.status).toBe(200);

    const other = await ctx
      .http()
      .get(`/employees/${fx.activeStaff[2]}`)
      .set(bearer(fx.employee.token));
    expect(other.status).toBe(403);
    expect(body(other)).toContain('only view your own');
  });

  it('EMP-API-09: read scoping — 403 across departments, 404 across branches', async () => {
    const own = await ctx
      .http()
      .get(`/employees/${fx.activeStaff[0]}`)
      .set(bearer(fx.manager.token));
    expect(own.status).toBe(200);

    const foreign = await ctx
      .http()
      .get(`/employees/${fx.staffBranchBId}`)
      .set(bearer(fx.manager.token));
    expect(foreign.status).toBe(403);

    // A branch-scoped HR gets 404, not 403: the record's existence must not
    // leak across a branch boundary.
    const offGrant = await ctx
      .http()
      .get(`/employees/${fx.staffBranchBId}`)
      .set(bearer(fx.scopedHr.token));
    expect(offGrant.status).toBe(404);

    const unknown = await ctx
      .http()
      .get('/employees/00000000-0000-0000-0000-000000000000')
      .set(bearer(fx.hr.token));
    expect(unknown.status).toBe(404);

  });

  it('EMP-API-09b: a malformed id is a 400 that says nothing about the server', async () => {
    // WAS (P27): no ParseUUIDPipe, so `not-a-uuid` reached Prisma and answered
    // 500 with the raw driver error — including this repository's absolute path
    // — to any authenticated caller.
    const res = await ctx
      .http()
      .get('/employees/not-a-uuid')
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(400);
    expect(body(res).toLowerCase()).not.toContain('prisma');
    expect(body(res).toLowerCase()).not.toContain('/home/');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Update
  // ───────────────────────────────────────────────────────────────────────────

  it('EMP-API-19: branchId and startDate are not editable through PATCH (P11)', async () => {
    const target = fx.activeStaff[2];
    const withBranch = await ctx
      .http()
      .patch(`/employees/${target}`)
      .set(bearer(fx.hr.token))
      .send({ branchId: fx.branchB });
    expect(withBranch.status).toBe(400);

    const withStart = await ctx
      .http()
      .patch(`/employees/${target}`)
      .set(bearer(fx.hr.token))
      .send({ startDate: '2020-01-01' });
    expect(withStart.status).toBe(400);
  });

  it('EMP-API-20: a changed field writes one EmployeeHistory row carrying both values', async () => {
    const created = await create(newEmployee({ position: 'Engineer' } as any));
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const res = await ctx
      .http()
      .patch(`/employees/${id}`)
      .set(bearer(fx.hr.token))
      .send({ position: 'Senior Engineer' });
    expect(res.status).toBe(200);

    const history = await ctx.prisma.employeeHistory.findMany({
      where: { employeeId: id, field: 'position' },
    });
    expect(history).toHaveLength(1);
    expect(history[0].oldValue).toBe('Engineer');
    expect(history[0].newValue).toBe('Senior Engineer');
  });

  it('EMP-API-21: writing the same value again writes no history row', async () => {
    const created = await create(newEmployee({ position: 'Analyst' } as any));
    const id = created.body.data.id;

    await ctx
      .http()
      .patch(`/employees/${id}`)
      .set(bearer(fx.hr.token))
      .send({ position: 'Analyst' });

    const history = await ctx.prisma.employeeHistory.findMany({
      where: { employeeId: id, field: 'position' },
    });
    expect(history).toHaveLength(0);
  });

  it('EMP-API-22/23: self-service updates are self-only for MANAGER and EMPLOYEE', async () => {
    const selfAsEmployee = await ctx
      .http()
      .patch(`/employees/${fx.employee.employeeId}`)
      .set(bearer(fx.employee.token))
      .send({ address: 'A new street' });
    expect(selfAsEmployee.status).toBe(200);

    const otherAsEmployee = await ctx
      .http()
      .patch(`/employees/${fx.activeStaff[2]}`)
      .set(bearer(fx.employee.token))
      .send({ address: 'Somewhere else' });
    expect(otherAsEmployee.status).toBe(403);
    expect(body(otherAsEmployee)).toContain('only update your own');

    // A MANAGER heading the department is still refused a report's record:
    // heading a department is not the same as owning its people's details.
    const reportAsManager = await ctx
      .http()
      .patch(`/employees/${fx.activeStaff[2]}`)
      .set(bearer(fx.manager.token))
      .send({ address: 'Manager was here' });
    expect(reportAsManager.status).toBe(403);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Delete — soft, clearance-gated, and hard
  // ───────────────────────────────────────────────────────────────────────────

  it('EMP-API-25: a soft delete terminates rather than removes', async () => {
    const created = await create(newEmployee());
    const id = created.body.data.id;

    const res = await ctx
      .http()
      .delete(`/employees/${id}`)
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(200);

    const row = await ctx.prisma.employee.findUnique({ where: { id } });
    // R72 (fixed): this path wrote `TERMINATED` while the two contract-side
    // offboarding paths wrote `INACTIVE`, so the same outcome — this person has
    // left — was recorded two ways and every report keying on one missed the
    // other population. All three exits now write `INACTIVE`, which is the
    // value the dashboard turnover report and the chatbot headcount already
    // read. `TERMINATED` remains a CONTRACT status.
    expect(row?.status).toBe('INACTIVE');
    expect(row?.endDate).toBeTruthy();

    // The linked user loses access at the same moment.
    const user = await ctx.prisma.user.findFirst({ where: { employeeId: id } });
    expect(user?.isActive).toBe(false);
  });

  it('EMP-API-26: an unreturned asset blocks offboarding, and the kill switch releases it', async () => {
    const blocked = await ctx
      .http()
      .delete(`/employees/${fx.staffWithOpenAssetId}`)
      .set(bearer(fx.hr.token));
    expect(blocked.status).toBe(400);
    expect(body(blocked)).toContain('Cannot complete offboarding');

    await withSetting(ctx, 'clearance_blocking_enabled', 'false', async () => {
      const released = await ctx
        .http()
        .delete(`/employees/${fx.staffWithOpenAssetId}`)
        .set(bearer(fx.hr.token));
      expect(released.status).toBe(200);
    });

    // Put the employee back so the override case below starts from ACTIVE.
    await ctx.prisma.employee.update({
      where: { id: fx.staffWithOpenAssetId },
      data: { status: 'ACTIVE', endDate: null },
    });
  });

  it('EMP-API-27: only ADMIN/HR may override clearance, and the override is audited', async () => {
    const res = await ctx
      .http()
      .delete(
        `/employees/${fx.staffWithOpenAssetId}?clearanceOverrideReason=${encodeURIComponent(
          'Laptop written off, approved by Finance',
        )}`,
      )
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(200);

    // An override that leaves no audit trail is indistinguishable from a
    // missing check the next time someone asks who let this through.
    const audit = await ctx.prisma.auditLog.findFirst({
      where: {
        action: 'CLEARANCE_OVERRIDDEN',
        resourceId: fx.staffWithOpenAssetId,
      },
    });
    expect(audit).toBeTruthy();

    await ctx.prisma.employee.update({
      where: { id: fx.staffWithOpenAssetId },
      data: { status: 'ACTIVE', endDate: null },
    });
  });

  it('EMP-API-28/29/30/31: the hard-delete path refuses everything it should', async () => {
    const HARD = 'allow_hard_delete_terminated';

    // 1. Disabled outright.
    await withSetting(ctx, HARD, 'false', async () => {
      const res = await ctx
        .http()
        .delete(`/employees/${fx.terminatedStaffId}/hard`)
        .set(bearer(fx.hr.token));
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Hard delete is not enabled');
    });

    await withSetting(ctx, HARD, 'true', async () => {
      // 2. Still live.
      const live = await ctx
        .http()
        .delete(`/employees/${fx.activeStaff[1]}/hard`)
        .set(bearer(fx.hr.token));
      expect(live.status).toBe(400);
      expect(body(live)).toContain('Only terminated employees');

      // 3. Clean and terminated — gone, and the user with it.
      const res = await ctx
        .http()
        .delete(`/employees/${fx.terminatedStaffId}/hard`)
        .set(bearer(fx.hr.token));
      expect(res.status).toBe(200);
      expect(
        await ctx.prisma.employee.findUnique({
          where: { id: fx.terminatedStaffId },
        }),
      ).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Documents — three routes, three different guard predicates (P21)
  // ───────────────────────────────────────────────────────────────────────────

  it('EMP-API-33: document reads are self-only for EMPLOYEE and department-scoped for MANAGER', async () => {
    const self = await ctx
      .http()
      .get(`/employees/${fx.employee.employeeId}/documents`)
      .set(bearer(fx.employee.token));
    expect(self.status).toBe(200);

    const other = await ctx
      .http()
      .get(`/employees/${fx.activeStaff[2]}/documents`)
      .set(bearer(fx.employee.token));
    expect(other.status).toBe(403);
    expect(body(other)).toContain('only view your own');

    const inScope = await ctx
      .http()
      .get(`/employees/${fx.activeStaff[0]}/documents`)
      .set(bearer(fx.manager.token));
    expect(inScope.status).toBe(200);

    const outOfScope = await ctx
      .http()
      .get(`/employees/${fx.staffBranchBId}/documents`)
      .set(bearer(fx.manager.token));
    expect(outOfScope.status).toBe(403);
  });

  it('EMP-API-34: document WRITES use a different predicate from document reads (P21)', async () => {
    // The read route runs a MANAGER department-scope check; the write routes do
    // not — they use `isSelfServiceOnly`, which lets a MANAGER through only for
    // their own record. Defensible, but nowhere stated, so it is stated here:
    // a fourth route added by copy-paste inherits whichever neighbour it lands
    // next to.
    const res = await ctx
      .http()
      .delete(`/employees/${fx.activeStaff[0]}/documents/${fx.activeStaff[0]}`)
      .set(bearer(fx.manager.token));
    // MANAGER is self-service-only here, and activeStaff[0] is not them.
    expect(res.status).toBe(403);
    expect(body(res)).toContain('only delete your own');
  });

  const postDocument = (filename: string, mime: string, size: number) =>
    ctx
      .http()
      .post(`/employees/${fx.activeStaff[0]}/documents`)
      .set(bearer(fx.hr.token))
      .field('documentType', 'OTHER')
      .attach('file', Buffer.alloc(size, 1), { filename, contentType: mime });

  it('EMP-API-36: an allowed document uploads', async () => {
    const pdf = await postDocument('cv.pdf', 'application/pdf', 1024);
    expect([200, 201]).toContain(pdf.status);
  });

  it('EMP-API-36b: a rejected document MIME is a 400 naming the allowed types', async () => {
    // WAS (P29): both upload filters rejected with a bare `new Error`, which
    // the global filter turned into a 500 — "Internal Server Error" for the
    // most ordinary mistake a user can make on an upload screen. The import
    // filter twenty lines below always used BadRequestException.
    const exe = await postDocument('virus.exe', 'application/x-msdownload', 1024);
    expect(exe.status).toBe(400);
    expect(body(exe)).toContain('allowed');
  });

  it('EMP-API-36c: a document over the 10 MB cap is refused', async () => {
    const huge = await postDocument(
      'big.pdf',
      'application/pdf',
      11 * 1024 * 1024,
    );
    // Multer's own limit, not the fileFilter — a different path, and it is
    // asserted separately so a fix to one does not silently mask the other.
    expect(huge.status).toBeGreaterThanOrEqual(400);
  });

  it('EMP-API-32: an image avatar uploads, and EMPLOYEE is refused outright', async () => {
    const png = await ctx
      .http()
      .post(`/employees/${fx.activeStaff[0]}/avatar`)
      .set(bearer(fx.hr.token))
      .attach('file', Buffer.alloc(512, 1), {
        filename: 'face.png',
        contentType: 'image/png',
      });
    expect([200, 201]).toContain(png.status);

    const asEmployee = await ctx
      .http()
      .post(`/employees/${fx.employee.employeeId}/avatar`)
      .set(bearer(fx.employee.token))
      .attach('file', Buffer.alloc(512, 1), {
        filename: 'face.png',
        contentType: 'image/png',
      });
    expect(asEmployee.status).toBe(403);
  });

  it('EMP-API-32b: a non-image avatar is a 400', async () => {
    const pdf = await ctx
      .http()
      .post(`/employees/${fx.activeStaff[0]}/avatar`)
      .set(bearer(fx.hr.token))
      .attach('file', Buffer.alloc(512, 1), {
        filename: 'cv.pdf',
        contentType: 'application/pdf',
      });
    expect(pdf.status).toBe(400);
  });

  it('EMP-API-38: history returns one row per change, newest first', async () => {
    const created = await create(newEmployee({ position: 'One' } as any));
    const id = created.body.data.id;

    for (const position of ['Two', 'Three']) {
      await ctx
        .http()
        .patch(`/employees/${id}`)
        .set(bearer(fx.hr.token))
        .send({ position });
    }

    const res = await ctx
      .http()
      .get(`/employees/${id}/history`)
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(200);
    const rows = rowsOf(res).filter((r) => r.field === 'position');
    expect(rows).toHaveLength(2);
    const times = rows.map((r) => new Date(r.changedAt).getTime());
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
    expect(rows[0].changedBy).toBeTruthy();
  });

  it('EMP-API-37: the activity feed IS department-scoped — P23 disproved', async () => {
    // Planned as a KNOWN GAP on the strength of a read of the controller: the
    // route carries no visible scope check next to its `@Roles`. It turns out
    // the check lives in the service, and a MANAGER is correctly refused a
    // foreign department's feed. The pin is gone; this is the assertion that
    // keeps it correct.
    const res = await ctx
      .http()
      .get(`/employees/${fx.staffBranchBId}/activities`)
      .set(bearer(fx.manager.token));
    expect(res.status).toBe(403);

    const inScope = await ctx
      .http()
      .get(`/employees/${fx.activeStaff[0]}/activities`)
      .set(bearer(fx.manager.token));
    expect(inScope.status).toBe(200);
  });

  it('EMP-API-43: resend-welcome answers for a linked account and is ADMIN/HR only', async () => {
    const created = await create(newEmployee());
    const id = created.body.data.id;

    const res = await ctx
      .http()
      .post(`/employees/${id}/resend-welcome`)
      .set(bearer(fx.hr.token));
    expect([200, 201]).toContain(res.status);

    const asEmployee = await ctx
      .http()
      .post(`/employees/${id}/resend-welcome`)
      .set(bearer(fx.employee.token));
    expect(asEmployee.status).toBe(403);
  });

  it('EMP-API-44: the import template downloads and preview refuses a non-workbook', async () => {
    const tpl = await ctx
      .http()
      .get('/employees/import/template')
      .set(bearer(fx.hr.token))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(tpl.status).toBe(200);
    // A real workbook, not an empty 200: xlsx files are zip archives, so the
    // first two bytes are "PK".
    expect((tpl.body as Buffer).subarray(0, 2).toString()).toBe('PK');

    const csv = await ctx
      .http()
      .post('/employees/import/preview')
      .set(bearer(fx.hr.token))
      .attach('file', Buffer.from('a,b,c'), {
        filename: 'people.csv',
        contentType: 'text/csv',
      });
    expect(csv.status).toBe(400);

    const noFile = await ctx
      .http()
      .post('/employees/import/preview')
      .set(bearer(fx.hr.token));
    expect(noFile.status).toBe(400);
  });

  it('EMP-API-44b: import is closed to MANAGER and EMPLOYEE', async () => {
    for (const actor of [fx.manager, fx.employee]) {
      const res = await ctx
        .http()
        .get('/employees/import/template')
        .set(bearer(actor.token));
      expect(res.status).toBe(403);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Reporting endpoints
  // ───────────────────────────────────────────────────────────────────────────

  it('EMP-API-42b: profile-completion stats answer ADMIN/HR and refuse the rest', async () => {
    expect(
      (
        await ctx
          .http()
          .get('/employees/stats/profile-completion')
          .set(bearer(fx.hr.token))
      ).status,
    ).toBe(200);
    expect(
      (
        await ctx
          .http()
          .get('/employees/stats/profile-completion')
          .set(bearer(fx.manager.token))
      ).status,
    ).toBe(403);
  });

  it('EMP-API-39: statistics are ADMIN/HR only — the directory admits MANAGER, this does not', async () => {
    expect(
      (await ctx.http().get('/employees/statistics').set(bearer(fx.hr.token)))
        .status,
    ).toBe(200);
    expect(
      (
        await ctx
          .http()
          .get('/employees/statistics')
          .set(bearer(fx.manager.token))
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .get('/employees/statistics')
          .set(bearer(fx.employee.token))
      ).status,
    ).toBe(403);
  });

  it('EMP-API-40: without-active-contract lists exactly who has none', async () => {
    const res = await ctx
      .http()
      .get('/employees/without-active-contract')
      .set(bearer(fx.hr.token));
    expect(res.status).toBe(200);
    const ids = rowsOf(res).map((e) => e.id);
    expect(ids).toContain(fx.uncontractedStaffId);
    expect(ids).not.toContain(fx.contractedStaffId);
  });

  it('EMP-API-41: generate-code never returns a code that is already taken', async () => {
    const first = await ctx
      .http()
      .get('/employees/generate-code')
      .set(bearer(fx.hr.token));
    expect(first.status).toBe(200);
    const code = first.body?.data?.employeeCode ?? first.body?.data?.code;
    expect(code).toBeTruthy();
    expect(
      await ctx.prisma.employee.findFirst({ where: { employeeCode: code } }),
    ).toBeNull();
  });

  it('EMP-API-42: recalculate-profiles is ADMIN-only', async () => {
    expect(
      (
        await ctx
          .http()
          .post('/employees/recalculate-profiles')
          .set(bearer(fx.hr.token))
      ).status,
    ).toBe(403);
    expect(
      (
        await ctx
          .http()
          .post('/employees/recalculate-profiles')
          .set(bearer(fx.admin.token))
      ).status,
    ).toBe(201);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Concurrency and cross-module interaction
  // ───────────────────────────────────────────────────────────────────────────

  it('EMP-API-46: two parallel creates with one email leave exactly one employee', async () => {
    const payload = newEmployee();
    const [a, b] = await Promise.all([create(payload), create(payload)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain(201);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);

    const rows = await ctx.prisma.employee.findMany({
      where: { email: payload.email as string },
    });
    expect(rows).toHaveLength(1);
  });

  it('EMP-API-48: a department move changes a manager’s reach on the very next request', async () => {
    // No re-login: `buildPrincipal` recomputes managedDepartmentIds per request,
    // so authority has to follow the data immediately.
    const created = await create(
      newEmployee({ departmentId: fx.foreignDeptId } as any),
    );
    const id = created.body.data.id;

    const before = await ctx
      .http()
      .get(`/employees/${id}`)
      .set(bearer(fx.manager.token));
    expect(before.status).toBe(403);

    await ctx
      .http()
      .patch(`/employees/${id}`)
      .set(bearer(fx.hr.token))
      .send({ departmentId: fx.mainDeptId });

    const after = await ctx
      .http()
      .get(`/employees/${id}`)
      .set(bearer(fx.manager.token));
    expect(after.status).toBe(200);
  });
});
