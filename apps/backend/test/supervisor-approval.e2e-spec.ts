import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { readApprovalSwitch, restoreApprovalSwitch } from './utils/approval-switch';
import { bearer } from './utils/fixtures';

/**
 * End-to-end coverage for the Supervisor Assignment & Configurable Approval
 * Hierarchy feature. Proves, against the real DB:
 *   1. Supervisor assignment (self/cycle guards, my-team, supervisor-of).
 *   2. Supervisor teams (create/update/delete) sync members' supervisorId and
 *      stay isolated from generic project teams.
 *   3. Workflow config CRUD returns the {success,data} envelope (the reload bug).
 *   4. A full LEAVE chain SUPERVISOR->HR->ADMIN: eligibility, advancement,
 *      inbox, finalize; and a REJECT termination.
 *   5. An OVERTIME chain SUPERVISOR->ADMIN.
 *   6. Regressions: kill-switch off => legacy single-approver, no trail;
 *      generic /teams excludes SUPERVISION teams.
 *
 * A supervisor here is a role=EMPLOYEE user, proving approval authority is a
 * data-driven assignment, not an RBAC grant.
 */
describe('Supervisor & Approval Hierarchy (e2e)', () => {
  let ctx: E2EContext;
  const PASSWORD = 'Passw0rd!';
  const runId = `sup${Date.now()}`;

  const emails = {
    admin: `admin-${runId}@test.local`,
    hr: `hr-${runId}@test.local`,
    supervisor: `sup-${runId}@test.local`,
    requester: `req-${runId}@test.local`,
    outsider: `out-${runId}@test.local`,
    member2: `mem2-${runId}@test.local`,
  };

  let branchId: string;
  let deptId: string;
  let supervisorEmpId: string;
  let requesterEmpId: string;
  let outsiderEmpId: string;
  let member2EmpId: string;

  let adminToken: string;
  let hrToken: string;
  let supervisorToken: string;
  let requesterToken: string;
  let outsiderToken: string;

  const createdWorkflowIds: string[] = [];
  // This suite flips the master switch and replaces the active workflows. Those
  // are SHARED, environment-wide configuration — a dev/demo database is very
  // likely to have real chains configured — so snapshot them up front and put
  // them back on teardown instead of resetting to a hardcoded default.
  let originalSwitchValue: string | null = null;
  let originallyActiveWorkflowIds: string[] = [];

  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    const { prisma } = ctx;
    const hash = await bcrypt.hash(PASSWORD, 10);

    originalSwitchValue = await readApprovalSwitch(prisma);
    originallyActiveWorkflowIds = (
      await prisma.approvalWorkflow.findMany({
        where: { isActive: true },
        select: { id: true },
      })
    ).map((w) => w.id);

    const branch = await prisma.branch.create({
      data: {
        code: `SUP-BR-${runId}`,
        name: 'Sup Branch',
        isActive: true,
        timezone: 'Asia/Kolkata',
        officeStartTime: '09:00',
        officeEndTime: '18:00',
      },
    });
    branchId = branch.id;

    const dept = await prisma.department.create({
      data: { code: `SUP-D-${runId}`, name: `Sup Dept ${runId}`, isActive: true },
    });
    deptId = dept.id;

    const mkEmp = (suffix: string) =>
      prisma.employee.create({
        data: {
          employeeCode: `SUP-${runId}-${suffix}`,
          fullName: `Sup ${suffix}`,
          dateOfBirth: new Date('1990-01-01'),
          idCard: `SUP-ID-${runId}-${suffix}`,
          email: `emp-${suffix}-${runId}@test.local`,
          departmentId: dept.id,
          branchId: branch.id,
          position: 'Engineer',
          startDate: new Date('2015-01-01'),
          baseSalary: 50000,
          status: 'ACTIVE',
        },
      });
    const [supEmp, reqEmp, outEmp, mem2Emp] = await Promise.all([
      mkEmp('SUP'),
      mkEmp('REQ'),
      mkEmp('OUT'),
      mkEmp('MEM2'),
    ]);
    supervisorEmpId = supEmp.id;
    requesterEmpId = reqEmp.id;
    outsiderEmpId = outEmp.id;
    member2EmpId = mem2Emp.id;

    const mkUser = (
      email: string,
      role: string,
      employeeId?: string,
    ) =>
      prisma.user.create({
        data: {
          email,
          passwordHash: hash,
          role,
          isActive: true,
          isGlobalBranchAccess: true,
          employeeId,
        },
      });
    await Promise.all([
      mkUser(emails.admin, 'ADMIN'),
      mkUser(emails.hr, 'HR_MANAGER'),
      mkUser(emails.supervisor, 'EMPLOYEE', supervisorEmpId),
      mkUser(emails.requester, 'EMPLOYEE', requesterEmpId),
      mkUser(emails.outsider, 'EMPLOYEE', outsiderEmpId),
      mkUser(emails.member2, 'EMPLOYEE', member2EmpId),
    ]);

    const login = async (email: string) =>
      (await ctx.http().post('/auth/login').send({ email, password: PASSWORD }))
        .body?.data?.accessToken as string;
    [adminToken, hrToken, supervisorToken, requesterToken, outsiderToken] =
      await Promise.all([
        login(emails.admin),
        login(emails.hr),
        login(emails.supervisor),
        login(emails.requester),
        login(emails.outsider),
      ]);
  });

  afterAll(async () => {
    const { prisma } = ctx;
    const empWhere = { employee: { employeeCode: { contains: runId } } };
    await prisma.requestApproval.deleteMany({
      where: {
        requestId: {
          in: [
            ...(await prisma.leaveRequest.findMany({
              where: empWhere,
              select: { id: true },
            })).map((r) => r.id),
            ...(await prisma.overtimeRequest.findMany({
              where: empWhere,
              select: { id: true },
            })).map((r) => r.id),
          ],
        },
      },
    });
    await prisma.attendance.deleteMany({ where: empWhere });
    await prisma.leaveRequest.deleteMany({ where: empWhere });
    await prisma.overtimeRequest.deleteMany({ where: empWhere });
    await prisma.leaveBalance.deleteMany({ where: empWhere });
    await prisma.leaveTypeBalance.deleteMany({ where: empWhere });
    await prisma.teamMember.deleteMany({ where: empWhere });
    // Supervisor-team codes are auto-generated (SUP-<base36>) and don't contain
    // runId; match by the runId-tagged name too so a mid-run failure can't leak.
    await prisma.team.deleteMany({
      where: {
        OR: [{ code: { contains: runId } }, { name: { contains: runId } }],
      },
    });
    if (createdWorkflowIds.length) {
      await prisma.approvalStep.deleteMany({
        where: { workflowId: { in: createdWorkflowIds } },
      });
      await prisma.approvalWorkflow.deleteMany({
        where: { id: { in: createdWorkflowIds } },
      });
    }
    await prisma.approvalWorkflow.deleteMany({
      where: { name: { contains: runId } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: runId } } });
    await prisma.employee.deleteMany({
      where: { employeeCode: { contains: runId } },
    });
    await prisma.department.deleteMany({ where: { code: { contains: runId } } });
    await prisma.branch.deleteMany({ where: { code: { contains: runId } } });
    // Put the environment's own approval configuration back exactly as found:
    // the switch to its prior value, and the workflows that were active before
    // this suite replaced them (upserting a workflow deactivates its siblings).
    await restoreApprovalSwitch(prisma, originalSwitchValue);
    if (originallyActiveWorkflowIds.length) {
      await prisma.approvalWorkflow.updateMany({
        where: { id: { in: originallyActiveWorkflowIds } },
        data: { isActive: true },
      });
    }
    await ctx.app.close();
  });

  // ── 1. Assignment ────────────────────────────────────────────────────
  it('ADMIN assigns a supervisor; self-assign and cycles are rejected', async () => {
    const ok = await ctx
      .http()
      .post('/supervisors/assign')
      .set(bearer(adminToken))
      .send({ employeeId: requesterEmpId, supervisorId: supervisorEmpId });
    expect(ok.status).toBe(201);

    const selfAssign = await ctx
      .http()
      .post('/supervisors/assign')
      .set(bearer(adminToken))
      .send({ employeeId: supervisorEmpId, supervisorId: supervisorEmpId });
    expect(selfAssign.status).toBe(400);

    // requester supervises nobody yet; make supervisor report to requester -> cycle
    const cycle = await ctx
      .http()
      .post('/supervisors/assign')
      .set(bearer(adminToken))
      .send({ employeeId: supervisorEmpId, supervisorId: requesterEmpId });
    expect(cycle.status).toBe(400);
  });

  it('supervisor sees the requester in /supervisors/my-team; supervisor-of resolves', async () => {
    const team = await ctx
      .http()
      .get('/supervisors/my-team')
      .set(bearer(supervisorToken));
    expect(team.status).toBe(200);
    expect(JSON.stringify(team.body)).toContain(requesterEmpId);

    const of = await ctx
      .http()
      .get(`/supervisors/of/${requesterEmpId}`)
      .set(bearer(adminToken));
    expect(of.body?.data?.id).toBe(supervisorEmpId);
  });

  // ── 2. Workflow config (envelope shape) ──────────────────────────────
  it('ADMIN configures LEAVE + OVERTIME chains; GET returns {success,data}', async () => {
    const leave = await ctx
      .http()
      .put('/approval-workflows')
      .set(bearer(adminToken))
      .send({
        requestType: 'LEAVE',
        name: `wf-leave-${runId}`,
        steps: [
          { approverType: 'SUPERVISOR' },
          { approverType: 'HR_MANAGER' },
          { approverType: 'ADMIN' },
        ],
      });
    expect(leave.status).toBe(200);
    expect(leave.body?.data?.id).toBeDefined();
    createdWorkflowIds.push(leave.body.data.id);

    const ot = await ctx
      .http()
      .put('/approval-workflows')
      .set(bearer(adminToken))
      .send({
        requestType: 'OVERTIME',
        name: `wf-ot-${runId}`,
        steps: [{ approverType: 'SUPERVISOR' }, { approverType: 'ADMIN' }],
      });
    expect(ot.status).toBe(200);
    createdWorkflowIds.push(ot.body.data.id);

    const list = await ctx
      .http()
      .get('/approval-workflows')
      .set(bearer(adminToken));
    expect(list.body?.success).toBe(true);
    expect(Array.isArray(list.body?.data)).toBe(true);
    const leaveWf = list.body.data.find(
      (w: any) => w.name === `wf-leave-${runId}`,
    );
    expect(leaveWf?.steps?.length).toBe(3);
  });

  // ── 3. LEAVE chain end-to-end ────────────────────────────────────────
  it('enables the master switch, then routes a leave through SUPERVISOR->HR->ADMIN', async () => {
    await ctx
      .http()
      .post('/system-settings')
      .set(bearer(adminToken))
      .send({ settings: { supervisor_approval_enabled: 'true' } });

    const start = new Date(Date.now() + 40 * 86400000);
    const create = await ctx
      .http()
      .post('/leave-requests')
      .set(bearer(requesterToken))
      .send({
        leaveType: 'UNPAID',
        startDate: ymd(start),
        endDate: ymd(start),
        reason: 'e2e chain',
      });
    expect(create.status).toBe(201);
    const leaveId = create.body?.data?.id;
    expect(leaveId).toBeDefined();

    // Trail materialized: step 1 ACTIVE, snapshot = supervisor user.
    const trail = await ctx
      .http()
      .get(`/approval-workflows/trail/LEAVE/${leaveId}`)
      .set(bearer(adminToken));
    // The trail endpoint returns { engaged, steps, activeStep, canAct } so a
    // screen can gate its Approve button on canAct rather than on the caller role.
    expect(trail.body.data.engaged).toBe(true);
    expect(trail.body.data.activeStep).toBe(1);
    const step1 = trail.body.data.steps.find((t: any) => t.stepOrder === 1);
    expect(step1.status).toBe('ACTIVE');
    expect(step1.approverType).toBe('SUPERVISOR');

    // Supervisor's inbox shows it.
    const inbox = await ctx
      .http()
      .get('/approval-workflows/inbox')
      .set(bearer(supervisorToken));
    expect(JSON.stringify(inbox.body.data)).toContain(leaveId);

    // Outsider EMPLOYEE cannot approve.
    const outsider = await ctx
      .http()
      .post(`/leave-requests/${leaveId}/approve`)
      .set(bearer(outsiderToken))
      .send({});
    expect(outsider.status).toBe(403);

    // Supervisor approves -> stays PENDING, advances to HR.
    const s = await ctx
      .http()
      .post(`/leave-requests/${leaveId}/approve`)
      .set(bearer(supervisorToken))
      .send({});
    expect(s.status).toBe(201);

    let after = await ctx.prisma.leaveRequest.findUnique({
      where: { id: leaveId },
      select: { status: true },
    });
    expect(after?.status).toBe('PENDING');

    // HR approves -> advances to ADMIN.
    const h = await ctx
      .http()
      .post(`/leave-requests/${leaveId}/approve`)
      .set(bearer(hrToken))
      .send({});
    expect(h.status).toBe(201);
    after = await ctx.prisma.leaveRequest.findUnique({
      where: { id: leaveId },
      select: { status: true },
    });
    expect(after?.status).toBe('PENDING');

    // ADMIN approves -> finalized APPROVED.
    const a = await ctx
      .http()
      .post(`/leave-requests/${leaveId}/approve`)
      .set(bearer(adminToken))
      .send({});
    expect(a.status).toBe(201);
    after = await ctx.prisma.leaveRequest.findUnique({
      where: { id: leaveId },
      select: { status: true },
    });
    expect(after?.status).toBe('APPROVED');
  });

  it('supervisor can REJECT and terminate the chain', async () => {
    const start = new Date(Date.now() + 50 * 86400000);
    const create = await ctx
      .http()
      .post('/leave-requests')
      .set(bearer(requesterToken))
      .send({
        leaveType: 'UNPAID',
        startDate: ymd(start),
        endDate: ymd(start),
        reason: 'e2e reject',
      });
    const leaveId = create.body?.data?.id;

    const r = await ctx
      .http()
      .post(`/leave-requests/${leaveId}/reject`)
      .set(bearer(supervisorToken))
      .send({ rejectedReason: 'nope' });
    expect(r.status).toBe(201);
    const after = await ctx.prisma.leaveRequest.findUnique({
      where: { id: leaveId },
      select: { status: true },
    });
    expect(after?.status).toBe('REJECTED');
  });

  // ── 4. OVERTIME chain ────────────────────────────────────────────────
  it('routes an overtime through SUPERVISOR->ADMIN', async () => {
    // A future weekday (avoid Sunday), overtime 19:00-21:00 (outside work hours).
    let d = new Date(Date.now() + 45 * 86400000);
    if (d.getUTCDay() === 0) d = new Date(d.getTime() + 86400000);
    const dateStr = ymd(d);
    const startTime = `${dateStr}T19:00:00.000Z`;
    const endTime = `${dateStr}T21:00:00.000Z`;

    const create = await ctx
      .http()
      .post('/overtime')
      .set(bearer(requesterToken))
      .send({
        date: dateStr,
        startTime,
        endTime,
        hours: 2,
        reason: 'e2e ot',
      });
    expect(create.status).toBe(201);
    const otId = create.body?.data?.id ?? create.body?.id;
    expect(otId).toBeDefined();

    const s = await ctx
      .http()
      .post(`/overtime/${otId}/approve`)
      .set(bearer(supervisorToken))
      .send({});
    expect(s.status).toBe(201);
    let after = await ctx.prisma.overtimeRequest.findUnique({
      where: { id: otId },
      select: { status: true },
    });
    expect(after?.status).toBe('PENDING'); // still awaiting ADMIN

    const a = await ctx
      .http()
      .post(`/overtime/${otId}/approve`)
      .set(bearer(adminToken))
      .send({});
    expect(a.status).toBe(201);
    after = await ctx.prisma.overtimeRequest.findUnique({
      where: { id: otId },
      select: { status: true },
    });
    expect(after?.status).toBe('APPROVED');
  });

  it('routes overtime AND leave through SUPERVISOR->MANAGER->HR, exposing canAct per role', async () => {
    const { prisma } = ctx;

    // A department manager for the requester's department. MANAGER is a role the
    // legacy approval screens never treated as an approver, which is exactly how
    // a chain used to strand at this step.
    const mgrEmp = await prisma.employee.create({
      data: {
        employeeCode: `SUP-${runId}-MGR`,
        fullName: 'Sup MGR',
        dateOfBirth: new Date('1985-01-01'),
        idCard: `SUP-ID-${runId}-MGR`,
        email: `mgr-${runId}@test.local`,
        departmentId: deptId,
        branchId,
        position: 'Head',
        startDate: new Date('2015-01-01'),
        baseSalary: 90000,
        status: 'ACTIVE',
      },
    });
    await prisma.user.create({
      data: {
        email: `mgruser-${runId}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: 'MANAGER',
        isActive: true,
        isGlobalBranchAccess: true,
        employeeId: mgrEmp.id,
      },
    });
    await prisma.department.update({
      where: { id: deptId },
      data: { managerId: mgrEmp.id },
    });
    const managerToken = (
      await ctx
        .http()
        .post('/auth/login')
        .send({ email: `mgruser-${runId}@test.local`, password: PASSWORD })
    ).body?.data?.accessToken as string;
    expect(managerToken).toBeTruthy();

    const wf = await ctx
      .http()
      .put('/approval-workflows')
      .set(bearer(adminToken))
      .send({
        requestType: 'OVERTIME',
        name: `ot-3step-${runId}`,
        mode: 'SEQUENTIAL',
        steps: [
          { approverType: 'SUPERVISOR' },
          { approverType: 'MANAGER' },
          { approverType: 'HR_MANAGER' },
        ],
      });
    expect(wf.status).toBe(200);
    createdWorkflowIds.push(wf.body?.data?.id);

    // Nav visibility contract: everyone holding a seat in an active chain must
    // be reported as an approver, even with an empty inbox — this is what makes
    // the "Approvals" screen reachable for a supervisor (an EMPLOYEE-role user)
    // and a department manager.
    const canApprove = async (token: string) =>
      (
        await ctx
          .http()
          .get('/approval-workflows/can-approve')
          .set(bearer(token))
      ).body?.data;
    expect((await canApprove(supervisorToken)).isApprover).toBe(true);
    expect((await canApprove(managerToken)).isApprover).toBe(true);
    expect((await canApprove(hrToken)).isApprover).toBe(true);
    // A colleague with no seat in any chain stays out of it.
    expect((await canApprove(outsiderToken)).isApprover).toBe(false);

    let d = new Date(Date.now() + 60 * 86400000);
    if (d.getUTCDay() === 0) d = new Date(d.getTime() + 86400000);
    const dateStr = ymd(d);
    const create = await ctx
      .http()
      .post('/overtime')
      .set(bearer(requesterToken))
      .send({
        date: dateStr,
        startTime: `${dateStr}T19:00:00.000Z`,
        endTime: `${dateStr}T21:00:00.000Z`,
        hours: 2,
        reason: 'e2e ot 3-step',
      });
    expect(create.status).toBe(201);
    const otId = create.body?.data?.id ?? create.body?.id;

    const trail = async (token: string) =>
      (
        await ctx
          .http()
          .get(`/approval-workflows/trail/OVERTIME/${otId}`)
          .set(bearer(token))
      ).body?.data;
    const status = async () =>
      (
        await ctx.prisma.overtimeRequest.findUnique({
          where: { id: otId },
          select: { status: true },
        })
      )?.status;

    // Step 1 — the supervisor, an EMPLOYEE-role user, is the only eligible actor.
    let t = await trail(supervisorToken);
    expect(t).toMatchObject({ engaged: true, activeStep: 1, canAct: true });
    expect((await trail(managerToken)).canAct).toBe(false);
    expect((await trail(hrToken)).canAct).toBe(false);

    expect(
      (await ctx.http().post(`/overtime/${otId}/approve`).set(bearer(supervisorToken)).send({}))
        .status,
    ).toBe(201);
    expect(await status()).toBe('PENDING');

    // Step 2 — the department manager. This is the step that used to stall:
    // no screen offered them the action, and their role is not an approver role.
    t = await trail(managerToken);
    expect(t).toMatchObject({ activeStep: 2, canAct: true });
    expect((await trail(supervisorToken)).canAct).toBe(false);
    expect((await trail(hrToken)).canAct).toBe(false);

    expect(
      (await ctx.http().post(`/overtime/${otId}/approve`).set(bearer(managerToken)).send({}))
        .status,
    ).toBe(201);
    expect(await status()).toBe('PENDING');

    // Step 3 — HR finalizes, and only now does the request become APPROVED.
    t = await trail(hrToken);
    expect(t).toMatchObject({ activeStep: 3, canAct: true });
    expect(
      (await ctx.http().post(`/overtime/${otId}/approve`).set(bearer(hrToken)).send({}))
        .status,
    ).toBe(201);
    expect(await status()).toBe('APPROVED');

    const done = await trail(adminToken);
    expect(done.activeStep).toBeNull();
    expect(done.canAct).toBe(false);
    expect(done.steps.map((s: any) => s.status)).toEqual([
      'APPROVED',
      'APPROVED',
      'APPROVED',
    ]);

    // ── the LEAVE cycle must ride the SAME engine, step for step ──────────
    const wfLeave = await ctx
      .http()
      .put('/approval-workflows')
      .set(bearer(adminToken))
      .send({
        requestType: 'LEAVE',
        name: `leave-3step-${runId}`,
        mode: 'SEQUENTIAL',
        steps: [
          { approverType: 'SUPERVISOR' },
          { approverType: 'MANAGER' },
          { approverType: 'HR_MANAGER' },
        ],
      });
    expect(wfLeave.status).toBe(200);
    createdWorkflowIds.push(wfLeave.body?.data?.id);

    const lvStart = new Date(Date.now() + 75 * 86400000);
    const lvCreate = await ctx
      .http()
      .post('/leave-requests')
      .set(bearer(requesterToken))
      .send({
        leaveType: 'UNPAID',
        startDate: ymd(lvStart),
        endDate: ymd(lvStart),
        reason: 'e2e leave 3-step',
      });
    expect(lvCreate.status).toBe(201);
    const leaveId = lvCreate.body?.data?.id ?? lvCreate.body?.id;

    const leaveTrail = async (token: string) =>
      (
        await ctx
          .http()
          .get(`/approval-workflows/trail/LEAVE/${leaveId}`)
          .set(bearer(token))
      ).body?.data;
    const leaveStatus = async () =>
      (
        await ctx.prisma.leaveRequest.findUnique({
          where: { id: leaveId },
          select: { status: true },
        })
      )?.status;

    expect(await leaveTrail(supervisorToken)).toMatchObject({
      engaged: true,
      activeStep: 1,
      canAct: true,
    });
    expect((await leaveTrail(managerToken)).canAct).toBe(false);

    expect(
      (await ctx.http().post(`/leave-requests/${leaveId}/approve`).set(bearer(supervisorToken)).send({}))
        .status,
    ).toBe(201);
    expect(await leaveStatus()).toBe('PENDING');

    // Step 2 — the department manager, the step that used to be unreachable.
    expect(await leaveTrail(managerToken)).toMatchObject({ activeStep: 2, canAct: true });
    expect((await leaveTrail(hrToken)).canAct).toBe(false);
    expect(
      (await ctx.http().post(`/leave-requests/${leaveId}/approve`).set(bearer(managerToken)).send({}))
        .status,
    ).toBe(201);
    expect(await leaveStatus()).toBe('PENDING');

    // Step 3 — HR finalizes; only now do the leave side-effects fire.
    expect(await leaveTrail(hrToken)).toMatchObject({ activeStep: 3, canAct: true });
    expect(
      (await ctx.http().post(`/leave-requests/${leaveId}/approve`).set(bearer(hrToken)).send({}))
        .status,
    ).toBe(201);
    expect(await leaveStatus()).toBe('APPROVED');

    // Final approval is what runs the domain side-effects: LEAVE attendance rows
    // are written once, by the last step — never by an intermediate one.
    const leaveAttendance = await ctx.prisma.attendance.count({
      where: { employeeId: requesterEmpId, status: 'LEAVE', date: new Date(ymd(lvStart)) },
    });
    expect(leaveAttendance).toBe(1);

    // Leave the department without a head so later tests see the original shape.
    await prisma.department.update({
      where: { id: deptId },
      data: { managerId: null },
    });
  });

  // ── 5. Supervisor teams + isolation ──────────────────────────────────
  it('creates a supervisor team that syncs members and stays out of /teams', async () => {
    const create = await ctx
      .http()
      .post('/supervisors/teams')
      .set(bearer(adminToken))
      .send({
        name: `Team ${runId}`,
        supervisorId: supervisorEmpId,
        memberIds: [member2EmpId],
      });
    expect(create.status).toBe(201);
    const teamId = create.body?.data?.id;

    // member2's supervisorId synced.
    const mem2 = await ctx.prisma.employee.findUnique({
      where: { id: member2EmpId },
      select: { supervisorId: true },
    });
    expect(mem2?.supervisorId).toBe(supervisorEmpId);

    // Isolation: generic project-teams list excludes SUPERVISION teams.
    const generic = await ctx.http().get('/teams').set(bearer(adminToken));
    expect(JSON.stringify(generic.body?.data || [])).not.toContain(teamId);

    // Delete detaches the member.
    const del = await ctx
      .http()
      .delete(`/supervisors/teams/${teamId}`)
      .set(bearer(adminToken));
    expect(del.status).toBe(200);
    const mem2After = await ctx.prisma.employee.findUnique({
      where: { id: member2EmpId },
      select: { supervisorId: true },
    });
    expect(mem2After?.supervisorId).toBeNull();
  });

  it('unassigning a supervisor removes the member from the supervisor team', async () => {
    const create = await ctx
      .http()
      .post('/supervisors/teams')
      .set(bearer(adminToken))
      .send({
        name: `Team sync ${runId}`,
        supervisorId: supervisorEmpId,
        memberIds: [member2EmpId],
      });
    const teamId = create.body?.data?.id;
    expect(teamId).toBeTruthy();

    // Remove the supervisor from the employee profile, not from the team.
    const un = await ctx
      .http()
      .delete(`/supervisors/assignment/${member2EmpId}`)
      .set(bearer(adminToken));
    expect(un.status).toBe(200);

    // The Teams page must no longer show them under that supervisor.
    const teams = await ctx
      .http()
      .get('/supervisors/teams')
      .set(bearer(adminToken));
    const team = (teams.body?.data || []).find((t: any) => t.id === teamId);
    expect(team).toBeTruthy();
    expect(JSON.stringify(team.members || [])).not.toContain(member2EmpId);

    await ctx.http().delete(`/supervisors/teams/${teamId}`).set(bearer(adminToken));
  });

  // ── 6. Regression: kill-switch off => legacy single-approver ──────────
  it('with the master switch OFF, leave uses the legacy single-approver path (no trail)', async () => {
    await ctx
      .http()
      .post('/system-settings')
      .set(bearer(adminToken))
      .send({ settings: { supervisor_approval_enabled: 'false' } });

    const start = new Date(Date.now() + 60 * 86400000);
    const create = await ctx
      .http()
      .post('/leave-requests')
      .set(bearer(requesterToken))
      .send({
        leaveType: 'UNPAID',
        startDate: ymd(start),
        endDate: ymd(start),
        reason: 'legacy path',
      });
    const leaveId = create.body?.data?.id;

    const trail = await ctx.prisma.requestApproval.count({
      where: { requestId: leaveId },
    });
    expect(trail).toBe(0); // engine disengaged

    const a = await ctx
      .http()
      .post(`/leave-requests/${leaveId}/approve`)
      .set(bearer(adminToken))
      .send({});
    expect(a.status).toBe(201);
    const after = await ctx.prisma.leaveRequest.findUnique({
      where: { id: leaveId },
      select: { status: true },
    });
    expect(after?.status).toBe('APPROVED');
  });
});
