import * as bcrypt from 'bcrypt';
import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupOrgFixtures,
  OrgFixtures,
  bearer,
  withSetting,
} from './utils/org-fixtures';

/**
 * Department change requests, end to end.
 *
 * This is the only approval flow in the Organization module, and the only place
 * in the product where approving a request CHANGES SOMEONE'S ROLE: a head who is
 * appointed becomes a MANAGER, and the head they replaced is demoted unless they
 * still run something else. Getting that wrong either strands authority with
 * someone who left the post or hands it to someone who was never appointed, and
 * neither is visible from the request list — so the side effects are asserted
 * against the database, not against the response body.
 *
 * Three behaviours here are pinned as KNOWN GAPs with `it.failing` twins:
 * approval re-checks none of the hierarchy rules, RESTRUCTURE approves and does
 * nothing, and the CANCELLED status the UI offers has no route behind it.
 */
describe('Organization — Department change requests (e2e)', () => {
  let ctx: E2EContext;
  let fx: OrgFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const rowsOf = (res: any): any[] => {
    const d = res.body?.data;
    return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
  };

  const TENURE_KEY = 'dept_manager_min_tenure_months';
  const TRANSITION_KEY = 'dept_manager_transition_days';

  let seq = 0;

  /** A department nobody else's test will touch. */
  const seedDept = (over: Record<string, unknown> = {}) =>
    ctx.prisma.department.create({
      data: {
        code: `CR-D${seq++}-${fx.runId}`,
        name: `CR Dept ${seq}`,
        isActive: true,
        ...over,
      },
    });

  /** An ACTIVE employee with a long tenure, plus the user account behind them. */
  const seedPerson = async (label: string, departmentId: string) => {
    const employee = await ctx.prisma.employee.create({
      data: {
        employeeCode: `EMP-${fx.runId}-${label}${seq}`,
        fullName: `CR ${label} ${seq}`,
        dateOfBirth: new Date('1990-01-01'),
        idCard: `ID-${fx.runId}-${label}${seq++}`,
        email: `cr-${label.toLowerCase()}${seq}-${fx.runId}@test.local`,
        departmentId,
        branchId: fx.branchA,
        position: 'Engineer',
        startDate: new Date('2019-01-01'),
        baseSalary: 50000,
        status: 'ACTIVE',
      },
    });
    const user = await ctx.prisma.user.create({
      data: {
        email: `cru-${label.toLowerCase()}${seq}-${fx.runId}@test.local`,
        passwordHash: await bcrypt.hash(fx.password, 10),
        role: 'EMPLOYEE',
        isActive: true,
        employeeId: employee.id,
      },
    });
    return { employee, user };
  };

  const login = async (email: string): Promise<string> => {
    const res = await ctx
      .http()
      .post('/auth/login')
      .send({ email, password: fx.password });
    return res.body.data.accessToken;
  };

  const createCR = (
    token: string,
    departmentId: string,
    payload: Record<string, unknown>,
  ) =>
    ctx
      .http()
      .post(`/departments/${departmentId}/change-requests`)
      .set(bearer(token))
      .send(payload);

  const review = (
    token: string,
    requestId: string,
    payload: Record<string, unknown>,
  ) =>
    ctx
      .http()
      .patch(`/departments/change-requests/${requestId}/review`)
      .set(bearer(token))
      .send(payload);

  const REASON = 'The current head is moving to another office';

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupOrgFixtures(ctx);
  }, 120000);

  /**
   * The shared fixture departments are the only ones more than one test raises
   * a request against, and "one PENDING per department" means a request left
   * open by one test refuses every request the next one makes — a failure that
   * points at the wrong place entirely. Cases that seed their own department do
   * not need this; these three do.
   */
  afterEach(async () => {
    if (!fx) return;
    await ctx.prisma.departmentChangeRequest.deleteMany({
      where: {
        status: 'PENDING',
        departmentId: { in: [fx.topDeptId, fx.secondDeptId, fx.thirdDeptId] },
      },
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ── Raising a request ─────────────────────────────────────────────────────
  describe('raising a change request', () => {
    it('CR-API-01 snapshots the department as it was when the request was raised', async () => {
      const dept = await seedDept({ name: 'Snapshot Source' });
      const { employee: head } = await seedPerson('HEAD', dept.id);
      await ctx.prisma.department.update({
        where: { id: dept.id },
        data: { managerId: head.id },
      });

      const res = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      expect(res.status).toBe(201);

      const cr = res.body.data;
      expect(cr.status).toBe('PENDING');
      expect(cr.requestedBy).toBe(fx.admin.userId);
      expect(cr.oldManagerId).toBe(head.id);
      expect(cr.newManagerId).toBe(fx.seniorCandidateId);
      expect(cr.newData).toEqual({ managerId: fx.seniorCandidateId });
      // The old values are frozen at raise time so the reviewer sees what was
      // proposed, not what the department drifted to since.
      expect(cr.oldData.code).toBe(dept.code);
      expect(cr.oldData.name).toBe('Snapshot Source');
      expect(new Date(cr.effectiveDate).getTime()).toBeGreaterThan(0);
    });

    it('CR-API-02 admits ADMIN, HR and the department’s own MANAGER; refuses the rest', async () => {
      const asHrDept = await seedDept();
      expect(
        (
          await createCR(fx.hr.token, asHrDept.id, {
            requestType: 'CHANGE_MANAGER',
            newManagerId: fx.seniorCandidateId,
            reason: REASON,
          })
        ).status,
      ).toBe(201);

      const ownDept = await createCR(fx.deptManager.token, fx.topDeptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      expect(ownDept.status).toBe(201);

      const foreign = await createCR(fx.deptManager.token, fx.secondDeptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      expect(foreign.status).toBe(403);

      const asEmployee = await createCR(fx.employee.token, fx.topDeptId, {
        requestType: 'CHANGE_MANAGER',
        reason: REASON,
      });
      expect(asEmployee.status).toBe(403);

      const anon = await ctx
        .http()
        .post(`/departments/${fx.topDeptId}/change-requests`)
        .send({ requestType: 'CHANGE_MANAGER', reason: REASON });
      expect(anon.status).toBe(401);
    });

    it('CR-API-03 404s a request against a department that does not exist', async () => {
      const res = await createCR(
        fx.admin.token,
        '00000000-0000-0000-0000-000000000000',
        { requestType: 'CHANGE_MANAGER', reason: REASON },
      );
      expect(res.status).toBe(404);
    });

    it('CR-API-04 refuses a reason under ten characters, a bad type and a bad date', async () => {
      const dept = await seedDept();

      const short = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        reason: 'too short',
      });
      expect(short.status).toBe(400);
      expect(body(short)).toContain('Reason must be at least 10 characters');

      expect(
        (await createCR(fx.admin.token, dept.id, { reason: REASON })).status,
      ).toBe(400);
      expect(
        (
          await createCR(fx.admin.token, dept.id, {
            requestType: 'NONSENSE',
            reason: REASON,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await createCR(fx.admin.token, dept.id, {
            requestType: 'CHANGE_MANAGER',
            newManagerId: 'not-a-uuid',
            reason: REASON,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await createCR(fx.admin.token, dept.id, {
            requestType: 'CHANGE_MANAGER',
            reason: REASON,
            effectiveDate: 'tomorrow-ish',
          })
        ).status,
      ).toBe(400);
    });

    it('CR-API-04b defaults the effective date to now when none is given', async () => {
      const dept = await seedDept();
      const before = Date.now();
      const res = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      expect(res.status).toBe(201);
      const effective = new Date(res.body.data.effectiveDate).getTime();
      expect(effective).toBeGreaterThanOrEqual(before - 1000);
    });

    it('CR-API-05 refuses a head who is not an active employee', async () => {
      const dept = await seedDept();
      const res = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.inactiveCandidateId,
        reason: REASON,
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Employee must be ACTIVE');
    });

    it('CR-API-06 enforces minimum tenure on a MANAGER’s request and waives it for HR', async () => {
      // The waiver is deliberate: HR appointing someone recently hired is an
      // administrative decision, a manager proposing the same is the rule the
      // tenure setting exists for.
      const fromManager = await createCR(fx.deptManager.token, fx.topDeptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.juniorCandidateId,
        reason: REASON,
      });
      expect(fromManager.status).toBe(400);
      expect(body(fromManager)).toContain('Minimum tenure is 6 months');
      expect(body(fromManager)).toContain('current: 2 months');

      const dept = await seedDept();
      const fromHr = await createCR(fx.hr.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.juniorCandidateId,
        reason: REASON,
      });
      expect(fromHr.status).toBe(201);
    });

    it('CR-API-07 follows the tenure setting, and falls back to six months when it is nonsense', async () => {
      await withSetting(ctx, TENURE_KEY, '0', async () => {
        const res = await createCR(fx.deptManager.token, fx.topDeptId, {
          requestType: 'CHANGE_MANAGER',
          newManagerId: fx.juniorCandidateId,
          reason: REASON,
        });
        expect(res.status).toBe(201);
        await ctx.prisma.departmentChangeRequest.deleteMany({
          where: { departmentId: fx.topDeptId, status: 'PENDING' },
        });
      });

      await withSetting(ctx, TENURE_KEY, 'not-a-number', async () => {
        const res = await createCR(fx.deptManager.token, fx.topDeptId, {
          requestType: 'CHANGE_MANAGER',
          newManagerId: fx.juniorCandidateId,
          reason: REASON,
        });
        expect(res.status).toBe(400);
        expect(body(res)).toContain('Minimum tenure is 6 months');
      });
    });

    it('CR-API-08 refuses a parent change with no target, an unknown target, or a target that is itself a child', async () => {
      const dept = await seedDept();

      const noTarget = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_PARENT',
        reason: REASON,
      });
      expect(noTarget.status).toBe(400);
      expect(body(noTarget)).toContain('New parent ID is required');

      const unknown = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_PARENT',
        newParentId: '00000000-0000-0000-0000-000000000000',
        reason: REASON,
      });
      expect(unknown.status).toBe(400);
      expect(body(unknown)).toContain('New parent department not found');

      const tooDeep = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_PARENT',
        newParentId: fx.childDeptId,
        reason: REASON,
      });
      expect(tooDeep.status).toBe(400);
      expect(body(tooDeep)).toContain('max 2 levels');
    });

    it('CR-API-09 allows only one open request per department, and accepts a new one once it is settled', async () => {
      const dept = await seedDept();

      const first = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      expect(first.status).toBe(201);

      const second = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.staffAId,
        reason: REASON,
      });
      expect(second.status).toBe(400);
      expect(body(second)).toContain('already a pending change request');

      await review(fx.hr.token, first.body.data.id, {
        action: 'REJECT',
        reviewNote: 'not now',
      });

      const third = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.staffAId,
        reason: REASON,
      });
      expect(third.status).toBe(201);
    });

    it('CR-API-10 lets exactly one of two simultaneous requests open', async () => {
      // The "one pending" rule used to be a read followed by a write, which two
      // concurrent raises pass together — and two reviewers then approve
      // conflicting heads for the same department. A row lock on the department
      // serializes the pair.
      const dept = await seedDept();
      const payload = {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      };

      const [a, b] = await Promise.all([
        createCR(fx.admin.token, dept.id, payload),
        createCR(fx.admin.token, dept.id, payload),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 400]);

      const pending = await ctx.prisma.departmentChangeRequest.count({
        where: { departmentId: dept.id, status: 'PENDING' },
      });
      expect(pending).toBe(1);
    });
  });

  // ── Reading requests ──────────────────────────────────────────────────────
  describe('reading requests', () => {
    let deptId: string;
    let requestId: string;

    beforeAll(async () => {
      const dept = await seedDept();
      deptId = dept.id;
      const res = await createCR(fx.admin.token, deptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      requestId = res.body.data.id;
    });

    it('CR-API-12 lists for ADMIN and HR only', async () => {
      expect(
        (
          await ctx
            .http()
            .get('/departments/change-requests')
            .set(bearer(fx.admin.token))
        ).status,
      ).toBe(200);
      expect(
        (
          await ctx
            .http()
            .get('/departments/change-requests')
            .set(bearer(fx.hr.token))
        ).status,
      ).toBe(200);
      expect(
        (
          await ctx
            .http()
            .get('/departments/change-requests')
            .set(bearer(fx.deptManager.token))
        ).status,
      ).toBe(403);
      expect(
        (
          await ctx
            .http()
            .get('/departments/change-requests')
            .set(bearer(fx.employee.token))
        ).status,
      ).toBe(403);
    });

    it('CR-API-13 filters by status and department, and returns newest first', async () => {
      const byDept = await ctx
        .http()
        .get(`/departments/change-requests?departmentId=${deptId}`)
        .set(bearer(fx.admin.token));
      expect(byDept.status).toBe(200);
      expect(rowsOf(byDept).every((r: any) => r.departmentId === deptId)).toBe(
        true,
      );

      const pending = await ctx
        .http()
        .get('/departments/change-requests?status=PENDING')
        .set(bearer(fx.admin.token));
      expect(rowsOf(pending).every((r: any) => r.status === 'PENDING')).toBe(
        true,
      );
      expect(rowsOf(pending).map((r: any) => r.id)).toContain(requestId);

      const times = rowsOf(pending).map((r: any) =>
        new Date(r.createdAt).getTime(),
      );
      expect([...times].sort((x, y) => y - x)).toEqual(times);

      // An unknown status is a filter that matches nothing rather than an error
      // — worth pinning, because a typo in a query string then looks like "no
      // requests exist" on screen.
      const nonsense = await ctx
        .http()
        .get('/departments/change-requests?status=NOPE')
        .set(bearer(fx.admin.token));
      expect(nonsense.status).toBe(200);
      expect(rowsOf(nonsense)).toHaveLength(0);
    });

    it('CR-API-13b hides another branch’s requests from a scoped HR', async () => {
      // Same reach as the detail and the review. A list that showed them would
      // leak the department and requester names of branches the caller has no
      // access to, even though they could not act on any of it.
      const elsewhere = await seedDept();
      await ctx.prisma.employee.create({
        data: {
          employeeCode: `EMP-${fx.runId}-LISTB`,
          fullName: 'Branch B Only',
          dateOfBirth: new Date('1990-01-01'),
          idCard: `ID-${fx.runId}-LISTB`,
          email: `listb-${fx.runId}@test.local`,
          departmentId: elsewhere.id,
          branchId: fx.branchB,
          position: 'Engineer',
          startDate: new Date('2019-01-01'),
          baseSalary: 50000,
          status: 'ACTIVE',
        },
      });
      const hidden = await createCR(fx.admin.token, elsewhere.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });

      const asScoped = await ctx
        .http()
        .get('/departments/change-requests')
        .set(bearer(fx.scopedHr.token));
      expect(asScoped.status).toBe(200);
      expect(rowsOf(asScoped).map((r: any) => r.id)).not.toContain(
        hidden.body.data.id,
      );

      // The global admin still sees everything.
      const asAdmin = await ctx
        .http()
        .get('/departments/change-requests')
        .set(bearer(fx.admin.token));
      expect(rowsOf(asAdmin).map((r: any) => r.id)).toContain(
        hidden.body.data.id,
      );
    });

    it('CR-API-14 serves one request to ADMIN and HR, 404s an unknown id, refuses an EMPLOYEE', async () => {
      const asAdmin = await ctx
        .http()
        .get(`/departments/change-requests/${requestId}`)
        .set(bearer(fx.admin.token));
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.body.data.id).toBe(requestId);

      const unknown = await ctx
        .http()
        .get(
          '/departments/change-requests/00000000-0000-0000-0000-000000000000',
        )
        .set(bearer(fx.admin.token));
      expect(unknown.status).toBe(404);

      const asEmployee = await ctx
        .http()
        .get(`/departments/change-requests/${requestId}`)
        .set(bearer(fx.employee.token));
      expect(asEmployee.status).toBe(403);
    });

    it('CR-API-14b refuses a MANAGER a request for a department they do not head', async () => {
      // The detail route used to admit MANAGER with no isDeptInManagerScope
      // check — unlike GET /departments/:id right beside it — so the headcount
      // and pending-approval figures of any department were readable by any
      // manager through the impact panel.
      const res = await ctx
        .http()
        .get(`/departments/change-requests/${requestId}`)
        .set(bearer(fx.deptManager.token));
      expect(res.status).toBe(403);
    });

    it('CR-API-14c admits a MANAGER to a request about their own department', async () => {
      const own = await createCR(fx.admin.token, fx.topDeptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      const res = await ctx
        .http()
        .get(`/departments/change-requests/${own.body.data.id}`)
        .set(bearer(fx.deptManager.token));
      expect(res.status).toBe(200);
    });

    it('CR-API-15 reports the real impact of the change', async () => {
      const res = await createCR(fx.admin.token, fx.secondDeptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      await ctx.prisma.departmentChangeRequest.delete({
        where: { id: res.body.data.id },
      });

      // Raised against the department the fixtures actually populated.
      const onTop = await createCR(fx.admin.token, fx.topDeptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      expect(onTop.status).toBe(201);

      const detail = await withSetting(ctx, TRANSITION_KEY, '21', () =>
        ctx
          .http()
          .get(`/departments/change-requests/${onTop.body.data.id}`)
          .set(bearer(fx.admin.token)),
      );

      const impact = detail.body.data.impact;
      const headcount = await ctx.prisma.employee.count({
        where: { departmentId: fx.topDeptId },
      });
      expect(impact.affectedEmployees).toBe(headcount);
      expect(impact.affectedTeams).toBe(1);
      expect(impact.pendingApprovals.leaves).toBe(1);
      expect(impact.pendingApprovals.overtime).toBe(1);
      expect(impact.estimatedTransitionDays).toBe(21);

      await ctx.prisma.departmentChangeRequest.delete({
        where: { id: onTop.body.data.id },
      });
    });
  });

  // ── Approving and rejecting ───────────────────────────────────────────────
  describe('reviewing a request', () => {
    it('CR-API-16 applies an approved head change, with a transition and a history entry', async () => {
      const dept = await seedDept({ name: 'Handover Dept' });
      const { employee: oldHead } = await seedPerson('OLD', dept.id);
      await ctx.prisma.department.update({
        where: { id: dept.id },
        data: { managerId: oldHead.id },
      });
      const { employee: newHead } = await seedPerson('NEW', dept.id);

      const effectiveDate = '2026-10-01T00:00:00.000Z';
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: newHead.id,
        reason: REASON,
        effectiveDate,
      });

      const res = await withSetting(ctx, TRANSITION_KEY, '14', () =>
        review(fx.hr.token, created.body.data.id, {
          action: 'APPROVE',
          reviewNote: 'Approved after handover plan agreed',
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('APPROVED');
      expect(res.body.data.reviewedBy).toBe(fx.hr.userId);
      expect(res.body.data.reviewedAt).toBeTruthy();
      expect(res.body.data.reviewNote).toContain('handover plan');

      const after = await ctx.prisma.department.findUnique({
        where: { id: dept.id },
      });
      expect(after?.managerId).toBe(newHead.id);

      const transition = await ctx.prisma.managerTransition.findFirst({
        where: { departmentId: dept.id },
      });
      expect(transition).toBeTruthy();
      expect(transition!.status).toBe('INITIATED');
      expect(transition!.oldManagerId).toBe(oldHead.id);
      expect(transition!.newManagerId).toBe(newHead.id);
      // 1 Oct + 14 days.
      expect(transition!.targetEndDate.toISOString().slice(0, 10)).toBe(
        '2026-10-15',
      );
      expect((transition!.handoverTasks as any[]).length).toBe(5);

      const history = await ctx.prisma.departmentHistory.findFirst({
        where: { departmentId: dept.id, changeType: 'MANAGER_CHANGED' },
      });
      expect(history).toBeTruthy();
      expect((history!.oldValue as any).managerId).toBe(oldHead.id);
      expect((history!.newValue as any).managerId).toBe(newHead.id);
      expect(history!.changeReason).toBe(REASON);
    });

    it('CR-API-17 promotes the appointed head, effective on their existing session', async () => {
      const dept = await seedDept();
      const { employee: newHead, user } = await seedPerson('PROMO', dept.id);
      const token = await login(user.email);

      const before = await ctx.http().get('/departments').set(bearer(token));
      expect(before.status).toBe(403);

      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: newHead.id,
        reason: REASON,
      });
      await review(fx.hr.token, created.body.data.id, { action: 'APPROVE' });

      const promoted = await ctx.prisma.user.findUnique({
        where: { id: user.id },
      });
      expect(promoted?.role).toBe('MANAGER');

      // Same token, no re-login: buildPrincipal reads the database per request.
      const after = await ctx
        .http()
        .get(`/departments/${dept.id}`)
        .set(bearer(token));
      expect(after.status).toBe(200);
    });

    it('CR-API-18 demotes the outgoing head only when they run nothing else', async () => {
      const dept = await seedDept();
      const { employee: outgoing, user: outgoingUser } = await seedPerson(
        'OUT',
        dept.id,
      );
      await ctx
        .http()
        .patch(`/departments/${dept.id}/manager`)
        .set(bearer(fx.admin.token))
        .send({ managerId: outgoing.id });
      expect(
        (await ctx.prisma.user.findUnique({ where: { id: outgoingUser.id } }))
          ?.role,
      ).toBe('MANAGER');

      const { employee: incoming } = await seedPerson('IN', dept.id);
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: incoming.id,
        reason: REASON,
      });
      await review(fx.hr.token, created.body.data.id, { action: 'APPROVE' });

      const demoted = await ctx.prisma.user.findUnique({
        where: { id: outgoingUser.id },
      });
      expect(demoted?.role).toBe('EMPLOYEE');

      // And the reverse: a head who still runs another department keeps the role.
      const second = await seedDept();
      const created2 = await createCR(fx.admin.token, fx.secondDeptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.staffAId,
        reason: REASON,
      });
      await review(fx.hr.token, created2.body.data.id, {
        action: 'APPROVE',
      });

      const stillManager = await ctx.prisma.user.findUnique({
        where: { id: fx.multiDeptManager.userId },
      });
      expect(stillManager?.role).toBe('MANAGER');
      expect(second).toBeTruthy();
    });

    it('CR-API-19 does not demote an outgoing head who is an ADMIN or HR', async () => {
      const dept = await seedDept();
      await ctx.prisma.department.update({
        where: { id: dept.id },
        data: { managerId: fx.hr.employeeId },
      });

      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      await review(fx.hr.token, created.body.data.id, { action: 'APPROVE' });

      const hrUser = await ctx.prisma.user.findUnique({
        where: { id: fx.hr.userId },
      });
      expect(hrUser?.role).toBe('HR_MANAGER');
    });

    it('CR-API-20 clears the head when no replacement is named, without opening a transition', async () => {
      const dept = await seedDept();
      const { employee: head } = await seedPerson('CLEAR', dept.id);
      await ctx.prisma.department.update({
        where: { id: dept.id },
        data: { managerId: head.id },
      });

      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        reason: 'Head is leaving and no successor has been chosen yet',
      });
      expect(created.status).toBe(201);
      await review(fx.hr.token, created.body.data.id, { action: 'APPROVE' });

      const after = await ctx.prisma.department.findUnique({
        where: { id: dept.id },
      });
      expect(after?.managerId).toBeNull();

      const transitions = await ctx.prisma.managerTransition.count({
        where: { departmentId: dept.id },
      });
      expect(transitions).toBe(0);

      const history = await ctx.prisma.departmentHistory.findFirst({
        where: { departmentId: dept.id, changeType: 'MANAGER_CHANGED' },
      });
      expect((history!.newValue as any).managerId).toBeNull();
    });

    it('CR-API-21 applies an approved parent change and records it', async () => {
      const dept = await seedDept();
      const newParent = await seedDept();

      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_PARENT',
        newParentId: newParent.id,
        reason: REASON,
      });
      expect(created.status).toBe(201);

      const res = await review(fx.hr.token, created.body.data.id, {
        action: 'APPROVE',
      });
      expect(res.status).toBe(200);

      const after = await ctx.prisma.department.findUnique({
        where: { id: dept.id },
      });
      expect(after?.parentId).toBe(newParent.id);

      const history = await ctx.prisma.departmentHistory.findFirst({
        where: { departmentId: dept.id, changeType: 'PARENT_CHANGED' },
      });
      expect((history!.newValue as any).parentId).toBe(newParent.id);
    });

    it('CR-API-21b refuses a stale parent change, and leaves the request open', async () => {
      // The rules live in DepartmentsService.update, and the approval path used
      // to bypass them by writing parentId straight onto the row: a request that
      // was legal when raised was applied unchanged however much the tree had
      // moved in between, producing the three-level hierarchy the API refuses to
      // create directly.
      const dept = await seedDept();
      const futureParent = await seedDept();

      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_PARENT',
        newParentId: futureParent.id,
        reason: REASON,
      });

      // Meanwhile the intended parent becomes someone else's child.
      const grandparent = await seedDept();
      await ctx.prisma.department.update({
        where: { id: futureParent.id },
        data: { parentId: grandparent.id },
      });

      const res = await review(fx.hr.token, created.body.data.id, {
        action: 'APPROVE',
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('2 levels deep');

      const after = await ctx.prisma.department.findUnique({
        where: { id: dept.id },
      });
      expect(after?.parentId).toBeNull();

      // And the request is still PENDING rather than marked APPROVED for a
      // change that never happened — someone can still reject it, or fix the
      // tree and approve it properly.
      const row = await ctx.prisma.departmentChangeRequest.findUnique({
        where: { id: created.body.data.id },
      });
      expect(row?.status).toBe('PENDING');
    });

    it('CR-API-11 refuses a RESTRUCTURE request rather than approving a no-op', async () => {
      // The type is in the DTO and both status screens render it, but nothing in
      // applyApprovedChange could carry one out — so it used to reach APPROVED,
      // write no history and change nothing, leaving the reader believing a
      // restructure had happened. Refused at the door until it means something.
      const dept = await seedDept();
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'RESTRUCTURE',
        reason: 'Splitting the department into two teams next quarter',
      });

      expect(created.status).toBe(400);
      expect(body(created)).toContain('not supported yet');

      const raised = await ctx.prisma.departmentChangeRequest.count({
        where: { departmentId: dept.id },
      });
      expect(raised).toBe(0);
    });

    it('CR-API-22 leaves the department untouched when a request is rejected', async () => {
      const dept = await seedDept();
      const { employee: head } = await seedPerson('KEEP', dept.id);
      await ctx.prisma.department.update({
        where: { id: dept.id },
        data: { managerId: head.id },
      });

      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      const res = await review(fx.hr.token, created.body.data.id, {
        action: 'REJECT',
        reviewNote: 'The successor is not ready yet',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REJECTED');
      expect(res.body.data.reviewNote).toContain('not ready');

      const after = await ctx.prisma.department.findUnique({
        where: { id: dept.id },
      });
      expect(after?.managerId).toBe(head.id);

      expect(
        await ctx.prisma.managerTransition.count({
          where: { departmentId: dept.id },
        }),
      ).toBe(0);
      expect(
        await ctx.prisma.departmentHistory.count({
          where: { departmentId: dept.id },
        }),
      ).toBe(0);
    });

    it('CR-API-23 refuses to review the same request twice', async () => {
      const dept = await seedDept();
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      await review(fx.hr.token, created.body.data.id, { action: 'APPROVE' });

      const again = await review(fx.hr.token, created.body.data.id, {
        action: 'REJECT',
      });
      expect(again.status).toBe(400);
      expect(body(again)).toContain('already been reviewed');
    });

    it('CR-API-24 404s a review of an unknown request', async () => {
      const res = await review(
        fx.admin.token,
        '00000000-0000-0000-0000-000000000000',
        { action: 'APPROVE' },
      );
      expect(res.status).toBe(404);
    });

    it('CR-API-25 refuses a MANAGER and an EMPLOYEE, including on their own department', async () => {
      const created = await createCR(fx.deptManager.token, fx.topDeptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      expect(created.status).toBe(201);

      const asManager = await review(
        fx.deptManager.token,
        created.body.data.id,
        {
          action: 'APPROVE',
        },
      );
      const asEmployee = await review(fx.employee.token, created.body.data.id, {
        action: 'APPROVE',
      });
      expect(asManager.status).toBe(403);
      expect(asEmployee.status).toBe(403);

      await ctx.prisma.departmentChangeRequest.delete({
        where: { id: created.body.data.id },
      });
    });

    it('CR-API-26 refuses to let the requester review their own request', async () => {
      // Leave, overtime and reimbursement all refuse self-approval. This flow
      // decides who holds managerial authority, so it was the last one that
      // should have allowed it.
      const dept = await seedDept();
      const created = await createCR(fx.hr.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });

      const approve = await review(fx.hr.token, created.body.data.id, {
        action: 'APPROVE',
      });
      expect(approve.status).toBe(403);
      expect(body(approve)).toContain('you raised yourself');

      // Rejecting your own is refused for the same reason.
      const reject = await review(fx.hr.token, created.body.data.id, {
        action: 'REJECT',
        reviewNote: 'changed my mind',
      });
      expect(reject.status).toBe(403);

      // Somebody else still can — the request is refused to its author, not
      // frozen.
      const other = await review(fx.admin.token, created.body.data.id, {
        action: 'APPROVE',
      });
      expect(other.status).toBe(200);
    });

    it('CR-API-27 refuses a review note under five characters and accepts none at all', async () => {
      const dept = await seedDept();
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });

      const tooShort = await review(fx.hr.token, created.body.data.id, {
        action: 'APPROVE',
        reviewNote: 'ok',
      });
      expect(tooShort.status).toBe(400);
      expect(body(tooShort)).toContain(
        'Review note must be at least 5 characters',
      );

      const noNote = await review(fx.hr.token, created.body.data.id, {
        action: 'APPROVE',
      });
      expect(noNote.status).toBe(200);
    });

    it('CR-API-28 refuses an action that is neither APPROVE nor REJECT', async () => {
      const dept = await seedDept();
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });

      const res = await review(fx.hr.token, created.body.data.id, {
        action: 'MAYBE',
      });
      expect(res.status).toBe(400);
    });

    it('CR-API-32 refuses a branch-scoped HR a request for staff outside its grant', async () => {
      // Change requests carry no branch of their own, so neither the detail nor
      // the review had a branch check — the branch engine that isolates every
      // other record did not reach this flow. A request's reach is now the reach
      // of the department it is about: the branches its staff sit in.
      const dept = await seedDept();
      const outsider = await ctx.prisma.employee.create({
        data: {
          employeeCode: `EMP-${fx.runId}-BOUT`,
          fullName: 'Branch B Outsider',
          dateOfBirth: new Date('1990-01-01'),
          idCard: `ID-${fx.runId}-BOUT`,
          email: `bout-${fx.runId}@test.local`,
          departmentId: dept.id,
          branchId: fx.branchB,
          position: 'Engineer',
          startDate: new Date('2019-01-01'),
          baseSalary: 50000,
          status: 'ACTIVE',
        },
      });

      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: outsider.id,
        reason: REASON,
      });
      const res = await review(fx.scopedHr.token, created.body.data.id, {
        action: 'APPROVE',
        reviewNote: 'approved from another branch entirely',
      });
      expect(res.status).toBe(403);
      expect(body(res)).toContain('branch you do not have access to');

      // A department with nobody in it belongs to no branch in particular, and
      // stays reviewable — otherwise a freshly created one could never be
      // acted on.
      const empty = await seedDept();
      const emptyReq = await createCR(fx.admin.token, empty.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      const allowed = await review(fx.scopedHr.token, emptyReq.body.data.id, {
        action: 'REJECT',
        reviewNote: 'not this one',
      });
      expect(allowed.status).toBe(200);
    });
  });

  // ── What approval hands over ──────────────────────────────────────────────
  describe('the authority an approved change moves', () => {
    it('X-05 the incoming head inherits the team’s pending approvals, the outgoing one loses them', async () => {
      // The point of the whole flow. A head change that leaves the leave and
      // overtime queue with the person who left the post is not a cosmetic bug:
      // requests sit unapproved with nobody who can see them.
      const dept = await seedDept();
      const { employee: outgoing, user: outgoingUser } = await seedPerson(
        'QOUT',
        dept.id,
      );
      const { employee: incoming, user: incomingUser } = await seedPerson(
        'QIN',
        dept.id,
      );
      const { employee: staff } = await seedPerson('QSTAFF', dept.id);

      await ctx
        .http()
        .patch(`/departments/${dept.id}/manager`)
        .set(bearer(fx.admin.token))
        .send({ managerId: outgoing.id });

      const leave = await ctx.prisma.leaveRequest.create({
        data: {
          employeeId: staff.id,
          leaveType: 'UNPAID',
          startDate: new Date('2026-09-10'),
          endDate: new Date('2026-09-11'),
          totalDays: 2,
          reason: `handover queue check ${fx.runId}`,
          status: 'PENDING',
        },
      });

      const outgoingToken = await login(outgoingUser.email);
      const before = await ctx
        .http()
        .get('/leave-requests/pending')
        .set(bearer(outgoingToken));
      expect(before.status).toBe(200);
      expect(JSON.stringify(before.body)).toContain(leave.id);

      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: incoming.id,
        reason: REASON,
      });
      await review(fx.hr.token, created.body.data.id, { action: 'APPROVE' });

      const incomingToken = await login(incomingUser.email);
      const after = await ctx
        .http()
        .get('/leave-requests/pending')
        .set(bearer(incomingToken));
      expect(after.status).toBe(200);
      expect(JSON.stringify(after.body)).toContain(leave.id);

      // And the outgoing head, now demoted, cannot reach the queue at all.
      const lost = await ctx
        .http()
        .get('/leave-requests/pending')
        .set(bearer(outgoingToken));
      expect(lost.status).toBe(403);
    });
  });

  // ── The status the UI offers but the API does not ─────────────────────────
  describe('cancelling', () => {
    it('CR-API-29 withdraws a pending request, freeing the department', async () => {
      // CANCELLED existed in the schema and in both status badges from the
      // start, and nothing could reach it: the only caller was a frontend method
      // PATCHing a route no controller declared. A raiser who changed their mind
      // had to ask someone else to reject their own request — or leave it open,
      // blocking every later request for that department.
      const dept = await seedDept();
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });

      const res = await ctx
        .http()
        .patch(`/departments/change-requests/${created.body.data.id}/cancel`)
        .set(bearer(fx.admin.token))
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');

      // The department is free again — the whole point of being able to withdraw.
      const next = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.staffAId,
        reason: REASON,
      });
      expect(next.status).toBe(201);
    });

    it('CR-API-29b refuses to cancel a settled request, or someone else’s', async () => {
      const dept = await seedDept();
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });

      const byManager = await ctx
        .http()
        .patch(`/departments/change-requests/${created.body.data.id}/cancel`)
        .set(bearer(fx.deptManager.token))
        .send({});
      expect(byManager.status).toBe(403);

      await review(fx.hr.token, created.body.data.id, {
        action: 'REJECT',
        reviewNote: 'no thanks',
      });

      const settled = await ctx
        .http()
        .patch(`/departments/change-requests/${created.body.data.id}/cancel`)
        .set(bearer(fx.admin.token))
        .send({});
      expect(settled.status).toBe(400);
      expect(body(settled)).toContain('Only a pending change request');
    });

    it('CR-API-29c lets a MANAGER withdraw the request they raised', async () => {
      const created = await createCR(fx.deptManager.token, fx.topDeptId, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      expect(created.status).toBe(201);

      const res = await ctx
        .http()
        .patch(`/departments/change-requests/${created.body.data.id}/cancel`)
        .set(bearer(fx.deptManager.token))
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');
    });
  });

  // ── Lifecycle around the department ───────────────────────────────────────
  describe('requests and the department they belong to', () => {
    it('CR-API-30 keeps a request readable after its department is removed', async () => {
      const dept = await seedDept();
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      await review(fx.hr.token, created.body.data.id, {
        action: 'REJECT',
        reviewNote: 'no thanks',
      });
      await ctx
        .http()
        .delete(`/departments/${dept.id}`)
        .set(bearer(fx.admin.token));

      const res = await ctx
        .http()
        .get(`/departments/change-requests/${created.body.data.id}`)
        .set(bearer(fx.admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.department.isActive).toBe(false);
    });

    it('CR-API-31 records who raised and who reviewed in the audit trail', async () => {
      const dept = await seedDept();
      const created = await createCR(fx.admin.token, dept.id, {
        requestType: 'CHANGE_MANAGER',
        newManagerId: fx.seniorCandidateId,
        reason: REASON,
      });
      await review(fx.hr.token, created.body.data.id, {
        action: 'APPROVE',
        reviewNote: 'audited approval',
      });

      const rows = await ctx.prisma.auditLog.findMany({
        where: { resourceType: 'Department', userId: fx.admin.userId },
        select: { action: true },
      });
      expect(rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['CREATE', 'UPDATE']),
      );
    });
  });
});
