import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupLeaveOvertimeFixtures,
  LeaveOtFixtures,
  freeWindow,
  freeDate,
  atUtc,
  LEAVE_YEAR,
} from './utils/leave-overtime-fixtures';
import { bearer } from './utils/settings';

/**
 * Branch and department scoping for Leave & Overtime — and the IDOR register.
 *
 * ── The rule this file exists to check ──────────────────────────────────────
 *
 * Mirrors `attendance-scoping.e2e-spec.ts`: **guard the id the CALLER supplied,
 * never the one their token did.** A door that only checks the principal is not
 * scoped; it is merely authenticated.
 *
 * Two structural properties of the fixture make the results readable:
 *
 *   - `deptFin` sits in `branchMain`, the SAME branch as `deptOps`. So every
 *     department refusal below is department scope or it is nothing — a
 *     department in another branch would let branch scope pass as if it were
 *     department scope.
 *   - `scopedHr` holds TWO branches (main + alt), so the envelope and the
 *     `X-Branch-Id` narrowing can be exercised separately. `branchForeign` is
 *     outside the envelope and is what every 404 points at.
 *
 * ── What it finds ───────────────────────────────────────────────────────────
 *
 * Every door below is now guarded. The group called "the register" is where the
 * gaps were: by-employee reads, balances, accrual, allocation, attachments and
 * the approval trail all crossed the branch line, and four by-id doors let any
 * colleague read another employee's leave, overtime, balances — and file leave
 * against them. The final group is the contrast that made those omissions
 * rather than a design: DELETE, on every one of the same resources, always
 * refused a peer correctly. They agree now.
 *
 * ── Actors this file OWNS for writes ────────────────────────────────────────
 *
 *   foreignStaff · finStaff · nullBranchStaff · applicant · applicant2
 */
describe('Leave & Overtime — branch, department and peer scoping (e2e)', () => {
  let ctx: E2EContext;
  let fx: LeaveOtFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any) => res.body?.data ?? res.body;

  const get = (token: string, path: string, branch?: string) => {
    const req = ctx.http().get(path).set(bearer(token));
    return branch ? req.set('X-Branch-Id', branch) : req;
  };
  const post = (token: string, path: string, payload: any = {}) =>
    ctx.http().post(path).set(bearer(token)).send(payload);
  const del = (token: string, path: string) =>
    ctx.http().delete(path).set(bearer(token));
  const patch = (token: string, path: string, payload: any = {}) =>
    ctx.http().patch(path).set(bearer(token)).send(payload);

  const otDate = (offset: number) => {
    for (let i = 0; i < 7; i++) {
      const d = freeDate(700 + offset + i);
      const dow = new Date(`${d}T00:00:00.000Z`).getUTCDay();
      if (dow !== 0 && dow !== 6) return d;
    }
    /* istanbul ignore next */
    return freeDate(700 + offset);
  };

  let owned: string[] = [];
  let foreignLeave = '';
  let foreignOt = '';
  let finLeave = '';
  let finOt = '';
  let peerLeave = '';
  let peerOt = '';

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupLeaveOvertimeFixtures(ctx);
    owned = [
      fx.foreignStaffId,
      fx.finStaffId,
      fx.nullBranchStaffId,
      fx.applicantId,
      fx.applicant2Id,
    ];
  }, 120000);

  beforeEach(async () => {
    // Targets are seeded straight to the database: a scoped caller cannot
    // create them, and the whole point is to have a REAL row to be refused on
    // rather than a 404 that means "no such record".
    const a = freeWindow(700, 3);
    const b = freeWindow(710, 3);
    const c = freeWindow(720, 3);
    foreignLeave = await fx.seedLeave({
      employeeId: fx.foreignStaffId,
      start: a.start,
      end: a.end,
    });
    finLeave = await fx.seedLeave({
      employeeId: fx.finStaffId,
      start: b.start,
      end: b.end,
    });
    peerLeave = await fx.seedLeave({
      employeeId: fx.applicantId,
      start: c.start,
      end: c.end,
    });
    foreignOt = await fx.seedOvertime({
      employeeId: fx.foreignStaffId,
      date: otDate(0),
    });
    finOt = await fx.seedOvertime({
      employeeId: fx.finStaffId,
      date: otDate(10),
    });
    peerOt = await fx.seedOvertime({
      employeeId: fx.applicantId,
      date: otDate(20),
    });
  });

  afterEach(async () => {
    const leaveIds = (
      await ctx.prisma.leaveRequest.findMany({
        where: { employeeId: { in: owned } },
        select: { id: true },
      })
    ).map((r) => r.id);
    const otIds = (
      await ctx.prisma.overtimeRequest.findMany({
        where: { employeeId: { in: owned } },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (leaveIds.length || otIds.length) {
      await ctx.prisma.requestApproval.deleteMany({
        where: { requestId: { in: [...leaveIds, ...otIds] } },
      });
      await ctx.prisma.leaveAttachment.deleteMany({
        where: { leaveRequestId: { in: leaveIds } },
      });
    }
    await ctx.prisma.leaveRequest.deleteMany({
      where: { employeeId: { in: owned } },
    });
    await ctx.prisma.overtimeRequest.deleteMany({
      where: { employeeId: { in: owned } },
    });
    await ctx.prisma.attendance.deleteMany({
      where: { employeeId: { in: owned } },
    });
    await ctx.prisma.leaveAccrualHistory.deleteMany({
      where: { employeeId: { in: owned } },
    });
    for (const id of owned) {
      await fx.resetBalances(id, LEAVE_YEAR);
      await fx.resetBalances(id, new Date().getUTCFullYear());
    }
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the by-id doors a scoped HR must not reach', () => {
    it('LOS-API-01 a leave request in a foreign branch answers 404', async () => {
      const res = await get(
        fx.scopedHr.token,
        `/leave-requests/${foreignLeave}`,
      );
      expect(res.status).toBe(404);
      expect(body(res)).not.toContain(fx.foreignStaffId);
    });

    it('LOS-API-02 a GLOBAL HR reads the very same row — which is what proves 01 was scoping', async () => {
      const res = await get(fx.hr.token, `/leave-requests/${foreignLeave}`);
      expect(res.status).toBe(200);
      expect(dataOf(res).id).toBe(foreignLeave);
    });

    it('LOS-API-03 approve and reject on a foreign leave answer 404 and change nothing', async () => {
      for (const [path, payload] of [
        [`/leave-requests/${foreignLeave}/approve`, {}],
        [`/leave-requests/${foreignLeave}/reject`, { rejectedReason: 'x' }],
      ] as const) {
        const res = await post(fx.scopedHr.token, path, payload);
        expect(res.status).toBe(404);
      }
      const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
        where: { id: foreignLeave },
      });
      expect(row.status).toBe('PENDING');
      expect(row.approverId).toBeNull();
    });

    it('LOS-API-04 deleting a foreign leave answers 404', async () => {
      const res = await del(
        fx.scopedHr.token,
        `/leave-requests/${foreignLeave}`,
      );
      expect(res.status).toBe(404);
    });

    it('LOS-API-05 creating a leave for a foreign employee answers 404 and writes nothing', async () => {
      const before = await ctx.prisma.leaveRequest.count({
        where: { employeeId: fx.foreignStaffId },
      });
      const w = freeWindow(730, 3);
      const res = await post(fx.scopedHr.token, '/leave-requests', {
        employeeId: fx.foreignStaffId,
        leaveType: 'ANNUAL',
        startDate: w.start,
        endDate: w.end,
        reason: `scoping spec ${fx.runId}`,
      });
      expect(res.status).toBe(404);
      expect(
        await ctx.prisma.leaveRequest.count({
          where: { employeeId: fx.foreignStaffId },
        }),
      ).toBe(before);
    });

    it('LOS-API-06 every by-id overtime door answers 404 for a foreign request', async () => {
      expect((await get(fx.scopedHr.token, `/overtime/${foreignOt}`)).status).toBe(
        404,
      );
      expect(
        (await post(fx.scopedHr.token, `/overtime/${foreignOt}/approve`)).status,
      ).toBe(404);
      expect(
        (
          await post(fx.scopedHr.token, `/overtime/${foreignOt}/reject`, {
            rejectedReason: 'x',
          })
        ).status,
      ).toBe(404);
      expect((await del(fx.scopedHr.token, `/overtime/${foreignOt}`)).status).toBe(
        404,
      );
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: foreignOt },
      });
      expect(row.status).toBe('PENDING');
    });

    it('LOS-API-07 registering overtime for a foreign employee answers 404 and writes nothing', async () => {
      const before = await ctx.prisma.overtimeRequest.count({
        where: { employeeId: fx.foreignStaffId },
      });
      const date = otDate(30);
      const res = await post(
        fx.scopedHr.token,
        `/overtime/employee/${fx.foreignStaffId}`,
        {
          date,
          startTime: atUtc(date, '18:00'),
          endTime: atUtc(date, '20:00'),
          hours: 2,
          reason: `scoping spec ${fx.runId}`,
        },
      );
      expect(res.status).toBe(404);
      expect(
        await ctx.prisma.overtimeRequest.count({
          where: { employeeId: fx.foreignStaffId },
        }),
      ).toBe(before);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the register — the doors that used to be open', () => {
    /**
     * L6, FIXED. `findByEmployee` took no `user`, and the `employee.findUnique`
     * at the top was unscoped while the `findMany` beneath it was — so a
     * cross-branch id answered **200 with an empty list** rather than 404, the
     * same existence oracle attendance recorded as A6. The caller learned the
     * employee existed.
     */
    it('LOS-API-08 a foreign employee is now indistinguishable from a nonexistent one', async () => {
      const real = await get(
        fx.scopedHr.token,
        `/leave-requests/employee/${fx.foreignStaffId}`,
      );
      expect(real.status).toBe(404);

      const invented = await get(
        fx.scopedHr.token,
        '/leave-requests/employee/11111111-1111-4111-8111-111111111111',
      );
      expect(invented.status).toBe(404);

      // The two refusals are now the same shape, so the pair says nothing about
      // whether the id exists.
      expect(real.status).toBe(invented.status);

      // In-envelope, the door still answers.
      const allowed = await get(
        fx.scopedHr.token,
        `/leave-requests/employee/${fx.applicantId}`,
      );
      expect(allowed.status).toBe(200);
    });

    /**
     * L4 + L5, FIXED. `LeaveBalancesService` never called `assertInBranch`, and
     * `findUnique` is not in `BRANCH_READ_ACTIONS` — so the read crossed the
     * branch line AND materialised rows on the far side of it.
     */
    it('LOS-API-09 a scoped HR can no longer read — or create — a foreign employee’s balances', async () => {
      await fx.resetBalances(fx.foreignStaffId, LEAVE_YEAR);
      const res = await get(
        fx.scopedHr.token,
        `/leave-balances/employee/${fx.foreignStaffId}?year=${LEAVE_YEAR}`,
      );
      expect(res.status).toBe(404);
      expect(
        await ctx.prisma.leaveBalance.count({
          where: { employeeId: fx.foreignStaffId, year: LEAVE_YEAR },
        }),
      ).toBe(0);
    });

    /** L11, the write half of the same omission. */
    it('LOS-API-10 accrual no longer crosses the branch line', async () => {
      const res = await post(
        fx.scopedHr.token,
        `/leave-balances/accrual/employee/${fx.foreignStaffId}`,
        { daysToAdd: 3, notes: `scoping spec ${fx.runId}` },
      );
      expect(res.status).toBe(404);
      expect(
        await ctx.prisma.leaveAccrualHistory.count({
          where: { employeeId: fx.foreignStaffId },
        }),
      ).toBe(0);
    });

    it('LOS-API-11 the per-type allocation PATCH honours the envelope too', async () => {
      const res = await patch(
        fx.scopedHr.token,
        `/leave-balances/${fx.foreignStaffId}/${LEAVE_YEAR}/Annual%20Leave`,
        { allocated: 44 },
      );
      expect(res.status).toBe(404);
      expect(
        await ctx.prisma.leaveTypeBalance.count({
          where: {
            employeeId: fx.foreignStaffId,
            year: LEAVE_YEAR,
            leaveTypeKey: 'Annual Leave',
          },
        }),
      ).toBe(0);
    });

    /**
     * L7 + L8, FIXED. `LeaveAttachment` was missing from `BRANCH_SCOPE` while
     * its sibling `LeaveApproval` carried `{ path: ['leaveRequest','employee'] }`.
     * The parent request was correctly refused; its attachments were not.
     */
    it('LOS-API-12 the attachment doors are refused exactly where their parent is', async () => {
      expect(
        (await get(fx.scopedHr.token, `/leave-requests/${foreignLeave}`)).status,
      ).toBe(404);
      const listed = await get(
        fx.scopedHr.token,
        `/leave-requests/${foreignLeave}/attachments`,
      );
      expect(listed.status).toBe(404);
    });

    /**
     * L9, FIXED. `RequestApproval` is in no scope rule and `getTrail` was a bare
     * `findMany`. The trail names who decided what and when.
     */
    it('LOS-API-13 the approval trail of a foreign request is no longer readable', async () => {
      await ctx.prisma.requestApproval.create({
        data: {
          requestType: 'LEAVE',
          requestId: foreignLeave,
          stepOrder: 1,
          approverType: 'HR_MANAGER',
          status: 'ACTIVE',
        },
      });
      const res = await get(
        fx.scopedHr.token,
        `/approval-workflows/trail/LEAVE/${foreignLeave}`,
      );
      expect(res.status).toBe(404);

      // A global HR still reads it, so the refusal was the envelope.
      const global = await get(
        fx.hr.token,
        `/approval-workflows/trail/LEAVE/${foreignLeave}`,
      );
      expect(global.status).toBe(200);
      expect(dataOf(global).steps).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('self-service reads are not branch-guarded, and need not be', () => {
    it('LOS-API-14 my-requests answers 200 with the branch pointed somewhere else', async () => {
      for (const path of [
        '/leave-requests/my-requests',
        '/overtime/my-requests',
      ]) {
        const res = await get(fx.employee.token, path, fx.branchMain);
        expect(res.status).toBe(200);
      }
    });

    it('LOS-API-15 and the caller can still file their own leave and overtime', async () => {
      const w = freeWindow(740, 3);
      const leave = await post(fx.employee.token, '/leave-requests', {
        leaveType: 'ANNUAL',
        startDate: w.start,
        endDate: w.end,
        reason: `scoping spec ${fx.runId}`,
      });
      expect(leave.status).toBe(201);

      const date = otDate(40);
      const ot = await post(fx.employee.token, '/overtime', {
        date,
        startTime: atUtc(date, '18:00'),
        endTime: atUtc(date, '20:00'),
        hours: 2,
        reason: `scoping spec ${fx.runId}`,
      });
      expect(ot.status).toBe(201);
    });

    it('LOS-API-16 while the by-PARAMETER doors stay refused — so 14 and 15 reopened nothing', async () => {
      expect(
        (await get(fx.scopedHr.token, `/leave-requests/${foreignLeave}`)).status,
      ).toBe(404);
      expect(
        (await get(fx.scopedHr.token, `/overtime/${foreignOt}`)).status,
      ).toBe(404);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('X-Branch-Id', () => {
    it('LOS-API-17 the header narrows a two-branch envelope on every list door', async () => {
      const w = freeWindow(750, 3);
      const inAlt = await fx.seedLeave({
        employeeId: fx.altStaffId,
        start: w.start,
        end: w.end,
      });
      try {
        const wide = await get(
          fx.scopedHr.token,
          '/leave-requests?limit=200',
        );
        expect(dataOf(wide).map((r: any) => r.id)).toContain(inAlt);

        const narrowed = await get(
          fx.scopedHr.token,
          '/leave-requests?limit=200',
          fx.branchMain,
        );
        expect(dataOf(narrowed).map((r: any) => r.id)).not.toContain(inAlt);

        // And the peer row in branchMain survives the narrowing, so the header
        // narrowed rather than emptied.
        expect(dataOf(narrowed).map((r: any) => r.id)).toContain(peerLeave);
      } finally {
        await ctx.prisma.leaveRequest.deleteMany({ where: { id: inAlt } });
      }
    });

    it('LOS-API-18 a branch outside the envelope is refused rather than silently widening it', async () => {
      const res = await get(
        fx.scopedHr.token,
        '/leave-requests?limit=10',
        fx.branchForeign,
      );
      expect(res.status).toBe(403);
      // The refusal must not be a quiet fallback to the whole envelope.
      expect(body(res)).not.toContain(peerLeave);
    });

    it('LOS-API-19 a company-wide employee is visible to a global caller and fails closed for a scoped one', async () => {
      const w = freeWindow(760, 3);
      const id = await fx.seedLeave({
        employeeId: fx.nullBranchStaffId,
        start: w.start,
        end: w.end,
      });
      const global = await get(fx.hr.token, `/leave-requests/${id}`);
      expect(global.status).toBe(200);

      const scoped = await get(fx.scopedHr.token, `/leave-requests/${id}`);
      expect(scoped.status).toBe(404);
    });

    it('LOS-API-20 an approved leave for a branchless employee writes attendance nobody scoped can see', async () => {
      await fx.setBalance(fx.nullBranchStaffId, 'Annual Leave', 30, LEAVE_YEAR);
      const w = freeWindow(770, 3);
      const created = await post(fx.hr.token, '/leave-requests', {
        employeeId: fx.nullBranchStaffId,
        leaveType: 'ANNUAL',
        startDate: w.start,
        endDate: w.end,
        reason: `scoping spec ${fx.runId}`,
      });
      expect(created.status).toBe(201);
      await post(
        fx.hr.token,
        `/leave-requests/${dataOf(created).id}/approve`,
      );

      const rows = await ctx.prisma.attendance.findMany({
        where: { employeeId: fx.nullBranchStaffId },
      });
      // The A9 fix stamps `employee.branchId ?? null` — and for this employee
      // that IS null. `Attendance` is a `direct`-rule model where
      // `branchId IN (…)` never matches NULL, so these rows are invisible to
      // every branch-scoped reader while payroll still counts them. The residue
      // the fix cannot reach.
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.branchId).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('department scope, inside one branch', () => {
    it('LOS-API-21 the two departments share a branch, so every refusal below is department scope', async () => {
      const ops = await ctx.prisma.employee.findUniqueOrThrow({
        where: { id: fx.applicantId },
      });
      const fin = await ctx.prisma.employee.findUniqueOrThrow({
        where: { id: fx.finStaffId },
      });
      expect(ops.branchId).toBe(fin.branchId);
      expect(ops.departmentId).not.toBe(fin.departmentId);

      const leaves = await get(fx.mgr.token, '/leave-requests?limit=200');
      expect(dataOf(leaves).map((r: any) => r.id)).toContain(peerLeave);
      expect(dataOf(leaves).map((r: any) => r.id)).not.toContain(finLeave);

      const ot = await get(fx.mgr.token, '/overtime?limit=200');
      expect(ot.body.data.map((r: any) => r.id)).toContain(peerOt);
      expect(ot.body.data.map((r: any) => r.id)).not.toContain(finOt);
    });

    it('LOS-API-22 the overtime by-employee door refuses an out-of-department MANAGER by name', async () => {
      const res = await get(
        fx.mgr.token,
        `/overtime/employee/${fx.finStaffId}`,
      );
      expect(res.status).toBe(403);
      expect(body(res)).toContain(
        'You do not have permission to view employees outside your department.',
      );
    });

    /**
     * L6, the department half — FIXED. `OvertimeService.findByEmployee` checked
     * exactly this, one module away in the same codebase, and the leave
     * equivalent did not. That contrast is what made it an omission. Both doors
     * now run the shared `assertCanAccessEmployeeRecord`, so both refuse with
     * the same sentence.
     */
    it('LOS-API-23 the LEAVE by-employee door now refuses out-of-department, exactly as its overtime sibling does', async () => {
      const leave = await get(
        fx.mgr.token,
        `/leave-requests/employee/${fx.finStaffId}`,
      );
      expect(leave.status).toBe(403);
      expect(body(leave)).toContain(
        'You do not have permission to view employees outside your department.',
      );

      const overtime = await get(
        fx.mgr.token,
        `/overtime/employee/${fx.finStaffId}`,
      );
      expect(overtime.status).toBe(403);
      // The same sentence from both doors, which is the point of the shared
      // guard — a caller cannot tell the two modules apart by their refusal.
      expect(overtime.body.message).toBe(leave.body.message);

      // In-department, the leave door still answers.
      const inScope = await get(
        fx.mgr.token,
        `/leave-requests/employee/${fx.applicantId}`,
      );
      expect(inScope.status).toBe(200);
      expect(dataOf(inScope).map((r: any) => r.id)).toContain(peerLeave);
    });

    it('LOS-API-24 approve and reject refuse out-of-department on both modules, with four distinct sentences', async () => {
      const leaveApprove = await post(
        fx.mgr.token,
        `/leave-requests/${finLeave}/approve`,
      );
      expect(leaveApprove.status).toBe(403);
      expect(body(leaveApprove)).toContain(
        'You do not have permission to perform this action outside your department.',
      );

      const leaveReject = await post(
        fx.mgr.token,
        `/leave-requests/${finLeave}/reject`,
        { rejectedReason: 'x' },
      );
      expect(leaveReject.status).toBe(403);
      expect(body(leaveReject)).toContain(
        'You do not have permission to perform this action outside your department.',
      );

      const otApprove = await post(fx.mgr.token, `/overtime/${finOt}/approve`);
      expect(otApprove.status).toBe(403);
      expect(body(otApprove)).toContain(
        'You do not have permission to approve overtime outside your department.',
      );

      const otReject = await post(fx.mgr.token, `/overtime/${finOt}/reject`, {
        rejectedReason: 'x',
      });
      expect(otReject.status).toBe(403);
      expect(body(otReject)).toContain(
        'You do not have permission to reject overtime outside your department.',
      );

      // And nothing moved.
      expect(
        (await ctx.prisma.leaveRequest.findUniqueOrThrow({ where: { id: finLeave } }))
          .status,
      ).toBe('PENDING');
      expect(
        (
          await ctx.prisma.overtimeRequest.findUniqueOrThrow({
            where: { id: finOt },
          })
        ).status,
      ).toBe('PENDING');
    });

    it('LOS-API-25 team-balances covers every department the manager heads and none they do not', async () => {
      const res = await get(fx.mgr.token, '/leave-requests/team-balances');
      expect(res.status).toBe(200);
      const ids = dataOf(res).map((r: any) => r.employeeId);
      expect(ids).toContain(fx.applicantId);
      expect(ids).not.toContain(fx.finStaffId);
      expect(ids).not.toContain(fx.foreignStaffId);
      expect(res.body.meta.departmentIds).toEqual([fx.deptOps]);
    });

    it('LOS-API-26 a department move takes effect on the very next call, with no re-login', async () => {
      const before = await get(fx.mgr.token, '/leave-requests?limit=200');
      expect(dataOf(before).map((r: any) => r.id)).not.toContain(finLeave);

      await ctx.prisma.employee.update({
        where: { id: fx.finStaffId },
        data: { departmentId: fx.deptOps },
      });
      try {
        const after = await get(fx.mgr.token, '/leave-requests?limit=200');
        // Same token, same manager, different answer — `buildPrincipal` re-reads
        // the headship on every request.
        expect(dataOf(after).map((r: any) => r.id)).toContain(finLeave);
      } finally {
        await ctx.prisma.employee.update({
          where: { id: fx.finStaffId },
          data: { departmentId: fx.deptFin },
        });
      }
    });

    it('LOS-API-27 a MANAGER who heads nothing falls back to their own department', async () => {
      // Detach the headship; `managerDeptScope` then uses `user.departmentId`.
      await ctx.prisma.department.update({
        where: { id: fx.deptOps },
        data: { managerId: null },
      });
      try {
        const res = await get(fx.mgr.token, '/leave-requests?limit=200');
        expect(res.status).toBe(200);
        // mgrEmp is itself in deptOps, so the fallback still sees that team.
        expect(dataOf(res).map((r: any) => r.id)).toContain(peerLeave);
        expect(dataOf(res).map((r: any) => r.id)).not.toContain(finLeave);
      } finally {
        await ctx.prisma.department.update({
          where: { id: fx.deptOps },
          data: { managerId: fx.mgr.employeeId },
        });
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('IDOR between peers — one branch, one department', () => {
    it('LOS-API-28 a colleague cannot read another’s leave request', async () => {
      const res = await get(
        fx.otherEmployee.token,
        `/leave-requests/${peerLeave}`,
      );
      expect(res.status).toBe(403);

      // Their own is still readable — `/leave-requests/:id` stays open to its
      // requester by design, which is what the screens rely on.
      const own = await fx.seedLeave({
        employeeId: fx.applicant2Id,
        start: freeWindow(790, 3).start,
        end: freeWindow(790, 3).end,
      });
      expect(
        (await get(fx.otherEmployee.token, `/leave-requests/${own}`)).status,
      ).toBe(200);
    });

    /**
     * L2, FIXED. Worse than the leave equivalent: the overtime payload includes
     * `employee.baseSalary` and `salaryType`, so walking overtime ids was a
     * salary disclosure.
     */
    it('LOS-API-29 a colleague cannot read another’s overtime record, and so cannot read their salary', async () => {
      const res = await get(fx.otherEmployee.token, `/overtime/${peerOt}`);
      expect(res.status).toBe(403);
      expect(body(res)).not.toContain('baseSalary');

      // HR still sees the whole record, salary included — the payload did not
      // change, only who may ask for it.
      const hr = await get(fx.hr.token, `/overtime/${peerOt}`);
      expect(hr.status).toBe(200);
      expect(hr.body.employee).toHaveProperty('baseSalary');
    });

    it('LOS-API-30 a colleague cannot read another’s leave balances', async () => {
      const res = await get(
        fx.otherEmployee.token,
        `/leave-balances/employee/${fx.applicantId}?year=${LEAVE_YEAR}`,
      );
      expect(res.status).toBe(403);

      // Their own balance is still theirs to read.
      const own = await get(
        fx.otherEmployee.token,
        `/leave-balances/employee/${fx.applicant2Id}?year=${LEAVE_YEAR}`,
      );
      expect(own.status).toBe(200);
    });

    /** L1, FIXED. And it was the VICTIM's balance the days came out of. */
    it('LOS-API-31 a colleague cannot file leave against another employee', async () => {
      const w = freeWindow(780, 3);
      const res = await post(fx.otherEmployee.token, '/leave-requests', {
        employeeId: fx.applicantId,
        leaveType: 'ANNUAL',
        startDate: w.start,
        endDate: w.end,
        reason: `scoping spec ${fx.runId}`,
      });
      expect(res.status).toBe(403);
      expect(
        await ctx.prisma.leaveRequest.count({
          where: {
            employeeId: fx.applicantId,
            reason: { contains: 'scoping spec' },
          },
        }),
      ).toBe(0);
    });

    /**
     * The contrast that MADE 28–31 findings rather than a design decision:
     * every DELETE on the same three resources always refused a peer correctly,
     * and said so by name. The codebase already knew how; the read doors simply
     * did not ask. Kept as the regression guard for the half that was never
     * broken.
     */
    it('LOS-API-32 every DELETE on the same resources refuses a peer, by name', async () => {
      const leaveDelete = await del(
        fx.otherEmployee.token,
        `/leave-requests/${peerLeave}`,
      );
      expect(leaveDelete.status).toBe(403);
      expect(body(leaveDelete)).toContain(
        'You can only cancel your own requests',
      );

      const otDelete = await del(fx.otherEmployee.token, `/overtime/${peerOt}`);
      expect(otDelete.status).toBe(403);
      expect(body(otDelete)).toContain(
        'You do not have permission to cancel this request',
      );

      const uploaded = await ctx
        .http()
        .post(`/leave-requests/${peerLeave}/attachments`)
        .set(bearer(fx.hr.token))
        .attach('file', Buffer.alloc(512, 0x25), {
          filename: 'note.pdf',
          contentType: 'application/pdf',
        });
      expect(uploaded.status).toBe(201);
      const attachmentDelete = await del(
        fx.otherEmployee.token,
        `/leave-requests/${peerLeave}/attachments/${dataOf(uploaded).id}`,
      );
      expect(attachmentDelete.status).toBe(403);
      expect(body(attachmentDelete)).toContain(
        'You do not have permission to delete this attachment',
      );
    });
  });
});
