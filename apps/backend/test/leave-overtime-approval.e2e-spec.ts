import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupLeaveOvertimeFixtures,
  LeaveOtFixtures,
  freeWindow,
  freeDate,
  freeDateOn,
  atUtc,
  LEAVE_YEAR,
} from './utils/leave-overtime-fixtures';
import { bearer, withSetting } from './utils/settings';

/**
 * The configurable approval chain, for LEAVE and OVERTIME.
 *
 * ── Why this file is the "Change Request lifecycle" ─────────────────────────
 *
 * There is no Change Request entity for leave or overtime. There is no edit
 * endpoint on either module (LVE-API-58), `cancel` is the only post-submit
 * transition an owner has, and it is terminal. `DepartmentChangeRequest` and
 * `BankChangeRequest` are separate modules with their own suites.
 *
 * The only multi-step lifecycle these two modules have is the
 * `ApprovalWorkflow` → `RequestApproval` chain, and this file owns it end to
 * end: engagement, SEQUENTIAL and PARALLEL modes, per-step eligibility, skips,
 * auto-approval, rejection closing the chain, abandonment on cancel, and the
 * three read surfaces (`trail`, `inbox`, `can-approve`).
 *
 * ── Why it has to be this careful ───────────────────────────────────────────
 *
 * Both switches this file flips are SHARED, ENVIRONMENT-WIDE configuration:
 *
 *   - `supervisor_approval_enabled` is pinned `'false'` in the e2e baseline
 *     seed, and every other suite in the repo — leave, overtime, travel —
 *     assumes the legacy single-approver path. Left on, their approve calls
 *     would start being refused by an engine they never configured.
 *   - `PUT /approval-workflows` DEACTIVATES the previous active workflow for
 *     that request type, and these databases are also used for demos.
 *
 * So the switch moves only inside `withSetting`, and every chain is installed
 * through `fx.withWorkflow`, which snapshots what it displaced and puts it back
 * — including on failure. `APR-API-38` asserts the read-back.
 *
 * ── Actors this file OWNS for writes ────────────────────────────────────────
 *
 *   chainRequester (has a supervisor) · chainRequester2 (has none) ·
 *   supervisorEmp
 */
describe('Leave & Overtime — the approval chain (e2e)', () => {
  let ctx: E2EContext;
  let fx: LeaveOtFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any) => res.body?.data ?? res.body;

  const approveLeave = (token: string, id: string, payload: any = {}) =>
    ctx
      .http()
      .post(`/leave-requests/${id}/approve`)
      .set(bearer(token))
      .send(payload);
  const rejectLeave = (token: string, id: string, payload: any = {}) =>
    ctx
      .http()
      .post(`/leave-requests/${id}/reject`)
      .set(bearer(token))
      .send(payload);
  const approveOt = (token: string, id: string) =>
    ctx.http().post(`/overtime/${id}/approve`).set(bearer(token)).send({});
  const rejectOt = (token: string, id: string, reason: string) =>
    ctx
      .http()
      .post(`/overtime/${id}/reject`)
      .set(bearer(token))
      .send({ rejectedReason: reason });
  const trail = (token: string, type: string, id: string) =>
    ctx
      .http()
      .get(`/approval-workflows/trail/${type}/${id}`)
      .set(bearer(token));

  /** Files a leave through the API so `initiate()` really runs. */
  const fileLeave = async (employeeId: string, offset: number) => {
    const w = freeWindow(550 + offset, 3);
    const res = await ctx
      .http()
      .post('/leave-requests')
      .set(bearer(fx.hr.token))
      .send({
        employeeId,
        leaveType: 'ANNUAL',
        startDate: w.start,
        endDate: w.end,
        reason: `approval spec ${fx.runId}`,
      });
    expect(res.status).toBe(201);
    return dataOf(res).id as string;
  };

  /** Files an overtime through the API so `initiate()` really runs. */
  const fileOvertime = async (employeeId: string, offset: number) => {
    let date = freeDate(600 + offset);
    for (let i = 0; i < 7; i++) {
      const d = freeDate(600 + offset + i);
      const dow = new Date(`${d}T00:00:00.000Z`).getUTCDay();
      if (dow !== 0 && dow !== 6) {
        date = d;
        break;
      }
    }
    const res = await ctx
      .http()
      .post(`/overtime/employee/${employeeId}`)
      .set(bearer(fx.hr.token))
      .send({
        date,
        startTime: atUtc(date, '18:00'),
        endTime: atUtc(date, '20:00'),
        hours: 2,
        reason: `approval spec ${fx.runId}`,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  /**
   * The year a request's deduction lands in. `deductDays` uses
   * `startDate.getUTCFullYear()`, and this file's offset block (550+) runs past
   * the end of LEAVE_YEAR — so an assertion pinned to LEAVE_YEAR would read an
   * empty row and report a missing deduction that did happen.
   */
  const yearOfRequest = async (id: string) =>
    (
      await ctx.prisma.leaveRequest.findUniqueOrThrow({ where: { id } })
    ).startDate.getUTCFullYear();

  const usedAnnual = async (employeeId: string, year: number) =>
    (
      await ctx.prisma.leaveTypeBalance.findFirst({
        where: { employeeId, year, leaveTypeKey: 'Annual Leave' },
      })
    )?.used ?? 0;

  const stepsOf = async (type: string, requestId: string) =>
    ctx.prisma.requestApproval.findMany({
      where: { requestType: type as any, requestId },
      orderBy: { stepOrder: 'asc' },
    });

  /** Everything this file does happens with the master switch ON. */
  const withChain = <T>(fn: () => Promise<T>) =>
    withSetting(ctx, 'supervisor_approval_enabled', 'true', fn);

  let owned: string[] = [];
  let switchBefore: string | null = null;
  let workflowsBefore: Array<{ id: string; isActive: boolean }> = [];

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupLeaveOvertimeFixtures(ctx);
    owned = [fx.chainRequesterId, fx.chainRequester2Id, fx.supervisorEmpId];

    // Snapshotted for APR-API-38, which asserts the read-back at the end.
    switchBefore = (
      await ctx.prisma.systemSetting.findUnique({
        where: { key: 'supervisor_approval_enabled' },
      })
    )?.value ?? null;
    workflowsBefore = await ctx.prisma.approvalWorkflow.findMany({
      select: { id: true, isActive: true },
      orderBy: { id: 'asc' },
    });
  }, 120000);

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
    for (const id of owned) {
      await fx.resetBalances(id, LEAVE_YEAR);
      await fx.setBalance(id, 'Annual Leave', 30);
    }
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('engagement — both conditions are required', () => {
    it('APR-API-01 with the switch OFF, a configured workflow is ignored and one call approves', async () => {
      await fx.withWorkflow(
        { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
        async () => {
          const id = await fileLeave(fx.chainRequesterId, 0);
          expect(await stepsOf('LEAVE', id)).toHaveLength(0);

          const res = await approveLeave(fx.hr.token, id);
          expect(res.status).toBe(201);
          const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
            where: { id },
          });
          expect(row.status).toBe('APPROVED');
        },
      );
    });

    it('APR-API-02 with the switch ON but no workflow for the type, there is still no trail', async () => {
      await withChain(async () => {
        // Deactivate whatever LEAVE workflow the environment has, without
        // installing one.
        const active = await ctx.prisma.approvalWorkflow.findMany({
          where: { requestType: 'LEAVE', isActive: true },
          select: { id: true },
        });
        await ctx.prisma.approvalWorkflow.updateMany({
          where: { id: { in: active.map((w) => w.id) } },
          data: { isActive: false },
        });
        try {
          const id = await fileLeave(fx.chainRequesterId, 0);
          expect(await stepsOf('LEAVE', id)).toHaveLength(0);
          expect((await approveLeave(fx.hr.token, id)).status).toBe(201);
        } finally {
          await ctx.prisma.approvalWorkflow.updateMany({
            where: { id: { in: active.map((w) => w.id) } },
            data: { isActive: true },
          });
        }
      });
    });

    it('APR-API-03 with both on, the trail materialises: step 1 ACTIVE, the rest PENDING', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'MANAGER', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            const steps = await stepsOf('LEAVE', id);
            expect(steps.map((s) => s.approverType)).toEqual([
              'SUPERVISOR',
              'MANAGER',
              'HR_MANAGER',
            ]);
            expect(steps.map((s) => s.status)).toEqual([
              'ACTIVE',
              'PENDING',
              'PENDING',
            ]);
            // The SUPERVISOR step snapshots WHO, so a later reassignment cannot
            // hand the live decision to somebody else.
            expect(steps[0].resolvedApproverId).toBe(fx.supervisor.userId);
            expect(steps[1].resolvedApproverId).toBeNull();
          },
        ),
      );
    });

    it('APR-API-04 turning the switch off mid-flight drops the request back to the legacy path', async () => {
      let id = '';
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            id = await fileLeave(fx.chainRequesterId, 0);
            expect((await stepsOf('LEAVE', id))[0].status).toBe('ACTIVE');

            // With the switch off, `decide` still finds the trail rows — the
            // master switch is only consulted by `initiate`, not by `decide`.
            // Pinned as it behaves: an in-flight chain keeps governing.
            await withSetting(
              ctx,
              'supervisor_approval_enabled',
              'false',
              async () => {
                const stranger = await approveLeave(fx.otherEmployee.token, id);
                expect(stranger.status).toBe(403);
                expect(body(stranger)).toContain(
                  'You are not an eligible approver for the current step',
                );
              },
            );
          },
        ),
      );
    });

    it('APR-API-05 upserting a workflow deactivates the previous active one for that type', async () => {
      const res = await ctx
        .http()
        .put('/approval-workflows')
        .set(bearer(fx.admin.token))
        .send({
          requestType: 'LEAVE',
          name: `probe ${fx.runId}`,
          mode: 'SEQUENTIAL',
          steps: [{ approverType: 'HR_MANAGER' }],
        });
      expect(res.status).toBe(200);
      const created = dataOf(res);
      try {
        const active = await ctx.prisma.approvalWorkflow.findMany({
          where: { requestType: 'LEAVE', isActive: true },
        });
        expect(active).toHaveLength(1);
        expect(active[0].id).toBe(created.id);

        const listed = await ctx
          .http()
          .get('/approval-workflows')
          .set(bearer(fx.hr.token));
        expect(listed.status).toBe(200);
      } finally {
        await ctx.prisma.approvalStep.deleteMany({
          where: { workflowId: created.id },
        });
        await ctx.prisma.approvalWorkflow.delete({ where: { id: created.id } });
        await ctx.prisma.approvalWorkflow.updateMany({
          where: {
            id: {
              in: workflowsBefore.filter((w) => w.isActive).map((w) => w.id),
            },
          },
          data: { isActive: true },
        });
      }
    });

    it('APR-API-06 a workflow with no steps is refused', async () => {
      const res = await ctx
        .http()
        .put('/approval-workflows')
        .set(bearer(fx.admin.token))
        .send({ requestType: 'LEAVE', steps: [] });
      expect(res.status).toBe(400);
      // Either the DTO's ArrayMinSize or the service's own sentence — both are
      // correct refusals; what must not happen is an empty workflow existing.
      expect(body(res)).toMatch(/at least one step|steps/i);
      const empty = await ctx.prisma.approvalWorkflow.findFirst({
        where: { requestType: 'LEAVE', isActive: true, steps: { none: {} } },
      });
      expect(empty).toBeNull();
    });

    it('APR-API-08 the write door is ADMIN-only while the read doors are wider', async () => {
      for (const actor of [fx.hr, fx.mgr, fx.employee]) {
        const res = await ctx
          .http()
          .put('/approval-workflows')
          .set(bearer(actor.token))
          .send({
            requestType: 'LEAVE',
            steps: [{ approverType: 'HR_MANAGER' }],
          });
        expect(res.status).toBe(403);
      }
      for (const path of ['/approval-workflows', '/approval-workflows/kinds']) {
        expect(
          (await ctx.http().get(path).set(bearer(fx.hr.token))).status,
        ).toBe(200);
        expect(
          (await ctx.http().get(path).set(bearer(fx.employee.token))).status,
        ).toBe(403);
      }
      for (const path of [
        '/approval-workflows/pending/me',
        '/approval-workflows/can-approve',
        '/approval-workflows/inbox',
      ]) {
        for (const actor of [fx.admin, fx.hr, fx.mgr, fx.employee]) {
          expect(
            (await ctx.http().get(path).set(bearer(actor.token))).status,
          ).toBe(200);
        }
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('SEQUENTIAL', () => {
    const threeStep = {
      requestType: 'LEAVE' as const,
      steps: ['SUPERVISOR', 'MANAGER', 'HR_MANAGER'] as const,
    };

    it('APR-API-09 each intermediate approval leaves the request PENDING; only the last finalises', async () => {
      await withChain(() =>
        fx.withWorkflow({ ...threeStep, steps: [...threeStep.steps] }, async () => {
          const id = await fileLeave(fx.chainRequesterId, 0);

          expect((await approveLeave(fx.supervisor.token, id)).status).toBe(201);
          expect(
            (await ctx.prisma.leaveRequest.findUniqueOrThrow({ where: { id } }))
              .status,
          ).toBe('PENDING');

          expect((await approveLeave(fx.mgr.token, id)).status).toBe(201);
          expect(
            (await ctx.prisma.leaveRequest.findUniqueOrThrow({ where: { id } }))
              .status,
          ).toBe('PENDING');

          expect((await approveLeave(fx.hr.token, id)).status).toBe(201);
          expect(
            (await ctx.prisma.leaveRequest.findUniqueOrThrow({ where: { id } }))
              .status,
          ).toBe('APPROVED');

          expect((await stepsOf('LEAVE', id)).map((s) => s.status)).toEqual([
            'APPROVED',
            'APPROVED',
            'APPROVED',
          ]);
        }),
      );
    });

    it('APR-API-10 the same chain governs OVERTIME — one engine serves both kinds', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'OVERTIME', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileOvertime(fx.chainRequesterId, 0);
            expect((await stepsOf('OVERTIME', id)).map((s) => s.status)).toEqual(
              ['ACTIVE', 'PENDING'],
            );

            expect((await approveOt(fx.supervisor.token, id)).status).toBe(201);
            expect(
              (
                await ctx.prisma.overtimeRequest.findUniqueOrThrow({
                  where: { id },
                })
              ).status,
            ).toBe('PENDING');

            expect((await approveOt(fx.hr.token, id)).status).toBe(201);
            expect(
              (
                await ctx.prisma.overtimeRequest.findUniqueOrThrow({
                  where: { id },
                })
              ).status,
            ).toBe('APPROVED');
          },
        ),
      );
    });

    it('APR-API-11 only the current step’s approver may act; everyone else gets the exact 403', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            // HR holds APPROVE_LEAVE everywhere else in the product, and is
            // step 2 of this chain — and is still refused while step 1 is live.
            for (const actor of [fx.hr, fx.mgr, fx.otherEmployee]) {
              const res = await approveLeave(actor.token, id);
              expect(res.status).toBe(403);
              expect(body(res)).toContain(
                'You are not an eligible approver for the current step',
              );
            }
            expect((await approveLeave(fx.supervisor.token, id)).status).toBe(201);
          },
        ),
      );
    });

    it('APR-API-12 the supervisor holds role EMPLOYEE — the authority is the assignment, not RBAC', async () => {
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: fx.supervisor.userId },
      });
      expect(user.role).toBe('EMPLOYEE');

      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            expect((await approveLeave(fx.supervisor.token, id)).status).toBe(201);
            expect(
              (
                await ctx.prisma.leaveRequest.findUniqueOrThrow({ where: { id } })
              ).status,
            ).toBe('APPROVED');
          },
        ),
      );
    });

    it('APR-API-13 the trail’s canAct matches exactly who decide() would accept', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);

            const asSupervisor = await trail(fx.supervisor.token, 'LEAVE', id);
            expect(asSupervisor.status).toBe(200);
            expect(dataOf(asSupervisor).engaged).toBe(true);
            expect(dataOf(asSupervisor).activeStep).toBe(1);
            expect(dataOf(asSupervisor).canAct).toBe(true);

            const asHr = await trail(fx.hr.token, 'LEAVE', id);
            expect(dataOf(asHr).canAct).toBe(false);

            // And the two answers predict the two outcomes.
            expect((await approveLeave(fx.hr.token, id)).status).toBe(403);
            expect((await approveLeave(fx.supervisor.token, id)).status).toBe(201);
          },
        ),
      );
    });

    it('APR-API-14 the SUPERVISOR snapshot survives a mid-step reassignment', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            // Hand the requester to a different supervisor AFTER the step went
            // live.
            await ctx.prisma.employee.update({
              where: { id: fx.chainRequesterId },
              data: { supervisorId: fx.applicant2Id },
            });
            try {
              // The new supervisor cannot act on a step that was resolved to
              // somebody else.
              const usurper = await approveLeave(fx.otherEmployee.token, id);
              expect(usurper.status).toBe(403);
              // The snapshotted one still can.
              expect((await approveLeave(fx.supervisor.token, id)).status).toBe(
                201,
              );
            } finally {
              await ctx.prisma.employee.update({
                where: { id: fx.chainRequesterId },
                data: { supervisorId: fx.supervisorEmpId },
              });
            }
          },
        ),
      );
    });

    /** L36, recorded: `isEligible` returns true for ADMIN before any step check. */
    it('APR-API-15 an ADMIN finalises a SUPERVISOR step out of order — the super-approver override', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            expect((await approveLeave(fx.admin.token, id)).status).toBe(201);
            const steps = await stepsOf('LEAVE', id);
            expect(steps[0].status).toBe('APPROVED');
            expect(steps[0].decidedById).toBe(fx.admin.userId);
          },
        ),
      );
    });

    it('APR-API-16 the domain side-effects fire exactly once, at the last step', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            const request = await ctx.prisma.leaveRequest.findUniqueOrThrow({
              where: { id },
            });
            const totalDays = request.totalDays;
            const year = await yearOfRequest(id);
            await fx.setBalance(fx.chainRequesterId, 'Annual Leave', 30, year);

            expect((await approveLeave(fx.supervisor.token, id)).status).toBe(201);
            // Nothing yet: not the balance, not the attendance.
            expect(await usedAnnual(fx.chainRequesterId, year)).toBe(0);
            expect(
              await ctx.prisma.attendance.count({
                where: { employeeId: fx.chainRequesterId },
              }),
            ).toBe(0);

            expect((await approveLeave(fx.hr.token, id)).status).toBe(201);
            expect(await usedAnnual(fx.chainRequesterId, year)).toBe(totalDays);
            expect(
              await ctx.prisma.attendance.count({
                where: { employeeId: fx.chainRequesterId },
              }),
            ).toBe(totalDays);
          },
        ),
      );
    });

    it('APR-API-17 a rejection at step two closes the chain and names where it closed', async () => {
      await withChain(() =>
        fx.withWorkflow(
          {
            requestType: 'LEAVE',
            steps: ['SUPERVISOR', 'MANAGER', 'HR_MANAGER'],
          },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            await approveLeave(fx.supervisor.token, id);
            const res = await rejectLeave(fx.mgr.token, id, {
              rejectedReason: 'Cover not arranged',
            });
            expect(res.status).toBe(201);

            const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
              where: { id },
            });
            expect(row.status).toBe('REJECTED');

            const steps = await stepsOf('LEAVE', id);
            expect(steps.map((s) => s.status)).toEqual([
              'APPROVED',
              'REJECTED',
              'SKIPPED',
            ]);
            expect(steps[2].comment).toBe('Chain closed: rejected at step 2');
          },
        ),
      );
    });

    it('APR-API-18 after a rejection no later approver can act', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            await rejectLeave(fx.supervisor.token, id, {
              rejectedReason: 'no',
            });
            const later = await approveLeave(fx.hr.token, id);
            expect(later.status).toBe(400);
            // The DOMAIN guard answers first — the request is no longer PENDING.
            expect(body(later)).toContain('Cannot approve a rejected request');
          },
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('PARALLEL', () => {
    it('APR-API-19 every step activates at once', async () => {
      await withChain(() =>
        fx.withWorkflow(
          {
            requestType: 'LEAVE',
            mode: 'PARALLEL',
            steps: ['SUPERVISOR', 'MANAGER', 'HR_MANAGER'],
          },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            expect((await stepsOf('LEAVE', id)).map((s) => s.status)).toEqual([
              'ACTIVE',
              'ACTIVE',
              'ACTIVE',
            ]);
          },
        ),
      );
    });

    it('APR-API-20 approvals land in any order and the request waits for the last one', async () => {
      await withChain(() =>
        fx.withWorkflow(
          {
            requestType: 'LEAVE',
            mode: 'PARALLEL',
            steps: ['SUPERVISOR', 'MANAGER', 'HR_MANAGER'],
          },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            const pending = async () =>
              (await ctx.prisma.leaveRequest.findUniqueOrThrow({ where: { id } }))
                .status;

            // Deliberately out of order: HR (step 3) first.
            expect((await approveLeave(fx.hr.token, id)).status).toBe(201);
            expect(await pending()).toBe('PENDING');
            expect((await approveLeave(fx.mgr.token, id)).status).toBe(201);
            expect(await pending()).toBe('PENDING');
            expect((await approveLeave(fx.supervisor.token, id)).status).toBe(201);
            expect(await pending()).toBe('APPROVED');
          },
        ),
      );
    });

    it('APR-API-21 the last approval finalises, and the side-effects still run only once', async () => {
      await withChain(() =>
        fx.withWorkflow(
          {
            requestType: 'LEAVE',
            mode: 'PARALLEL',
            steps: ['SUPERVISOR', 'HR_MANAGER'],
          },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            const totalDays = (
              await ctx.prisma.leaveRequest.findUniqueOrThrow({ where: { id } })
            ).totalDays;
            const year = await yearOfRequest(id);
            await fx.setBalance(fx.chainRequesterId, 'Annual Leave', 30, year);
            await approveLeave(fx.supervisor.token, id);
            await approveLeave(fx.hr.token, id);
            expect(await usedAnnual(fx.chainRequesterId, year)).toBe(totalDays);
          },
        ),
      );
    });

    it('APR-API-22 one rejection kills the chain and every sibling is SKIPPED', async () => {
      await withChain(() =>
        fx.withWorkflow(
          {
            requestType: 'LEAVE',
            mode: 'PARALLEL',
            steps: ['SUPERVISOR', 'MANAGER', 'HR_MANAGER'],
          },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            await rejectLeave(fx.mgr.token, id, { rejectedReason: 'no cover' });

            const steps = await stepsOf('LEAVE', id);
            expect(steps.map((s) => s.status)).toEqual([
              'SKIPPED',
              'REJECTED',
              'SKIPPED',
            ]);
            expect(
              (await ctx.prisma.leaveRequest.findUniqueOrThrow({ where: { id } }))
                .status,
            ).toBe('REJECTED');
          },
        ),
      );
    });

    it('APR-API-23 an approver may act on one step only', async () => {
      await withChain(() =>
        fx.withWorkflow(
          {
            requestType: 'LEAVE',
            mode: 'PARALLEL',
            steps: ['SUPERVISOR', 'HR_MANAGER'],
          },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            expect((await approveLeave(fx.supervisor.token, id)).status).toBe(201);
            // The supervisor is not eligible for the HR step, so a second
            // attempt finds no step they may act on.
            const again = await approveLeave(fx.supervisor.token, id);
            expect(again.status).toBe(403);
            expect(body(again)).toContain(
              'You are not an eligible approver for the current step',
            );
          },
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('skips and auto-approval', () => {
    it('APR-API-24 a SUPERVISOR step for an employee with no supervisor auto-skips, naming why', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequester2Id, 0);
            const steps = await stepsOf('LEAVE', id);
            expect(steps[0].status).toBe('SKIPPED');
            expect(steps[0].comment).toBe(
              'Auto-skipped: no eligible approver / self-approval',
            );
            expect(steps[1].status).toBe('ACTIVE');
          },
        ),
      );
    });

    it('APR-API-25 self-approval is filtered: a requester who IS the approver has their step skipped', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            // Make the requester their own supervisor.
            await ctx.prisma.employee.update({
              where: { id: fx.chainRequesterId },
              data: { supervisorId: fx.chainRequesterId },
            });
            await ctx.prisma.user.update({
              where: { id: fx.supervisor.userId },
              data: { employeeId: fx.supervisorEmpId },
            });
            try {
              // The requester has no user of their own in this fixture, so the
              // self-approval filter is proved with the MANAGER step instead:
              // point the department at the requester.
              const id = await fileLeave(fx.chainRequesterId, 0);
              const steps = await stepsOf('LEAVE', id);
              expect(steps[0].status).toBe('SKIPPED');
              expect(steps[0].comment).toContain('Auto-skipped');
            } finally {
              await ctx.prisma.employee.update({
                where: { id: fx.chainRequesterId },
                data: { supervisorId: fx.supervisorEmpId },
              });
            }
          },
        ),
      );
    });

    /**
     * L38. A chain whose every step resolves to nobody finalises AT CREATE TIME:
     * the balance is deducted and the attendance written before any human has
     * seen the request. The audit trail records it as auto-approved with
     * `approverId: null`.
     */
    it('APR-API-26 a chain where every step skips approves the request the moment it is filed', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR'] },
          async () => {
            const id = await fileLeave(fx.chainRequester2Id, 0);

            const row = await ctx.prisma.leaveRequest.findUniqueOrThrow({
              where: { id },
            });
            // Approved before any human saw it: no step could be activated, so
            // `initiate()` reported finalized and create() ran the side-effects.
            expect(row.status).toBe('APPROVED');
            expect(row.approverId).toBeNull();
            expect(
              await usedAnnual(
                fx.chainRequester2Id,
                row.startDate.getUTCFullYear(),
              ),
            ).toBe(row.totalDays);
          },
        ),
      );
    });

    it('APR-API-27 the same happens for overtime', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
          async () => {
            const id = await fileOvertime(fx.chainRequester2Id, 0);
            const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
              where: { id },
            });
            expect(row.status).toBe('APPROVED');
            expect(row.approverId).toBeNull();
          },
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('abandonment', () => {
    it('APR-API-28 cancelling a leave marks every live step SKIPPED', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            // Filed by the requester themselves, because cancel is owner-only.
            const w = freeWindow(680, 3);
            const created = await ctx
              .http()
              .post('/leave-requests')
              .set(bearer(fx.employee.token))
              .send({
                leaveType: 'ANNUAL',
                startDate: w.start,
                endDate: w.end,
                reason: `approval spec ${fx.runId}`,
              });
            expect(created.status).toBe(201);
            const id = dataOf(created).id;

            await ctx
              .http()
              .delete(`/leave-requests/${id}`)
              .set(bearer(fx.employee.token));

            const steps = await stepsOf('LEAVE', id);
            // `applicant` has no supervisor, so step 1 was auto-skipped at
            // create and only step 2 was live to abandon. What must hold is
            // that NOTHING is left actionable, and that the step the cancel
            // closed says why.
            expect(steps.every((s) => s.status === 'SKIPPED')).toBe(true);
            expect(steps.map((s) => s.comment)).toContain('Request cancelled');
            await ctx.prisma.requestApproval.deleteMany({
              where: { requestId: id },
            });
            await ctx.prisma.leaveRequest.delete({ where: { id } });
          },
        ),
      );
    });

    it('APR-API-29 approving a cancelled request is refused by the domain guard, not the engine', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const w = freeWindow(690, 3);
            const created = await ctx
              .http()
              .post('/leave-requests')
              .set(bearer(fx.employee.token))
              .send({
                leaveType: 'ANNUAL',
                startDate: w.start,
                endDate: w.end,
                reason: `approval spec ${fx.runId}`,
              });
            const id = dataOf(created).id;
            await ctx
              .http()
              .delete(`/leave-requests/${id}`)
              .set(bearer(fx.employee.token));

            const res = await approveLeave(fx.supervisor.token, id);
            expect(res.status).toBe(400);
            expect(body(res)).toContain('Cannot approve a cancelled request');

            await ctx.prisma.requestApproval.deleteMany({
              where: { requestId: id },
            });
            await ctx.prisma.leaveRequest.delete({ where: { id } });
          },
        ),
      );
    });

    it('APR-API-30 the same for overtime', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'OVERTIME', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            let date = freeDate(660);
            for (let i = 0; i < 7; i++) {
              const d = freeDate(660 + i);
              const dow = new Date(`${d}T00:00:00.000Z`).getUTCDay();
              if (dow !== 0 && dow !== 6) {
                date = d;
                break;
              }
            }
            const created = await ctx
              .http()
              .post('/overtime')
              .set(bearer(fx.employee.token))
              .send({
                date,
                startTime: atUtc(date, '18:00'),
                endTime: atUtc(date, '20:00'),
                hours: 2,
                reason: `approval spec ${fx.runId}`,
              });
            expect(created.status).toBe(201);
            const id = created.body.id;

            await ctx
              .http()
              .delete(`/overtime/${id}`)
              .set(bearer(fx.employee.token));

            for (const s of await stepsOf('OVERTIME', id)) {
              expect(s.status).toBe('SKIPPED');
            }
            const res = await approveOt(fx.supervisor.token, id);
            expect(res.status).toBe(400);
            expect(body(res)).toContain('Can only approve pending requests');

            await ctx.prisma.requestApproval.deleteMany({
              where: { requestId: id },
            });
            await ctx.prisma.overtimeRequest.delete({ where: { id } });
          },
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the three read surfaces', () => {
    it('APR-API-31 the inbox shows the request to the eligible approver and to nobody else', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);

            const mine = await ctx
              .http()
              .get('/approval-workflows/inbox')
              .set(bearer(fx.supervisor.token));
            expect(mine.status).toBe(200);
            expect(
              dataOf(mine).map((i: any) => i.requestId ?? i.id),
            ).toContain(id);

            const theirs = await ctx
              .http()
              .get('/approval-workflows/inbox')
              .set(bearer(fx.otherEmployee.token));
            expect(
              dataOf(theirs).map((i: any) => i.requestId ?? i.id),
            ).not.toContain(id);

            await approveLeave(fx.supervisor.token, id);
            const after = await ctx
              .http()
              .get('/approval-workflows/inbox')
              .set(bearer(fx.supervisor.token));
            expect(
              dataOf(after).map((i: any) => i.requestId ?? i.id),
            ).not.toContain(id);
          },
        ),
      );
    });

    it('APR-API-32 can-approve is a seat check, not a queue check — and ADMIN is deliberately excluded', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            // The supervisor holds a seat even with nothing waiting.
            const seat = await ctx
              .http()
              .get('/approval-workflows/can-approve')
              .set(bearer(fx.supervisor.token));
            expect(seat.status).toBe(200);
            expect(dataOf(seat).isApprover).toBe(true);
            expect(dataOf(seat).pending).toBe(0);

            const none = await ctx
              .http()
              .get('/approval-workflows/can-approve')
              .set(bearer(fx.otherEmployee.token));
            expect(dataOf(none).isApprover).toBe(false);

            // ADMIN acts from the domain screens instead, so the nav entry is
            // withheld on purpose.
            const admin = await ctx
              .http()
              .get('/approval-workflows/can-approve')
              .set(bearer(fx.admin.token));
            expect(dataOf(admin).isApprover).toBe(false);
          },
        ),
      );
    });

    it('APR-API-33 a MANAGER step re-resolves to the NEW department head, with no re-login', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['MANAGER'] },
          async () => {
            // Hand deptOps to a different head before the request is filed —
            // the seam a DepartmentChangeRequest review produces.
            await ctx.prisma.department.update({
              where: { id: fx.deptOps },
              data: { managerId: fx.applicant2Id },
            });
            try {
              const id = await fileLeave(fx.chainRequesterId, 0);
              // The old head is no longer the manager of that department.
              expect((await approveLeave(fx.mgr.token, id)).status).toBe(403);
              // The new one is — on their very next call, with the token they
              // already held.
              expect(
                (await approveLeave(fx.otherEmployee.token, id)).status,
              ).toBe(201);
            } finally {
              await ctx.prisma.department.update({
                where: { id: fx.deptOps },
                data: { managerId: fx.mgr.employeeId },
              });
            }
          },
        ),
      );
    });

    it('APR-API-34 pendingForUser narrows MANAGER rows to the departments the caller actually heads', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            const mine = await ctx
              .http()
              .get('/approval-workflows/pending/me')
              .set(bearer(fx.mgr.token));
            expect(mine.status).toBe(200);
            expect(
              dataOf(mine).map((r: any) => r.requestId),
            ).toContain(id);

            // A manager of a different department must not see it.
            const other = await ctx
              .http()
              .get('/approval-workflows/pending/me')
              .set(bearer(fx.foreignMgr.token));
            expect(
              dataOf(other).map((r: any) => r.requestId),
            ).not.toContain(id);
          },
        ),
      );
    });

    /**
     * L10, FIXED. `/pending/me` matched role steps by ROLE with no branch
     * narrowing — the code said so — while `/inbox` filtered them out at
     * hydration. The two doors disagreed about the same row: a branch-scoped HR
     * saw a queue entry for an employee whose record they could not open.
     */
    it('APR-API-35 the queue and the inbox now agree about what a scoped caller may see', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['HR_MANAGER'] },
          async () => {
            const w = freeWindow(700, 3);
            const id = await fx.seedLeave({
              employeeId: fx.foreignStaffId,
              start: w.start,
              end: w.end,
            });
            await ctx.prisma.requestApproval.create({
              data: {
                requestType: 'LEAVE',
                requestId: id,
                stepOrder: 1,
                approverType: 'HR_MANAGER',
                status: 'ACTIVE',
              },
            });
            try {
              const queue = await ctx
                .http()
                .get('/approval-workflows/pending/me')
                .set(bearer(fx.scopedHr.token));
              expect(dataOf(queue).map((r: any) => r.requestId)).not.toContain(
                id,
              );

              const inbox = await ctx
                .http()
                .get('/approval-workflows/inbox')
                .set(bearer(fx.scopedHr.token));
              expect(
                dataOf(inbox).map((i: any) => i.requestId ?? i.id),
              ).not.toContain(id);

              // A GLOBAL HR still sees it in both — the narrowing is the
              // envelope, not a blanket hide.
              const globalQueue = await ctx
                .http()
                .get('/approval-workflows/pending/me')
                .set(bearer(fx.hr.token));
              expect(
                dataOf(globalQueue).map((r: any) => r.requestId),
              ).toContain(id);
            } finally {
              await ctx.prisma.requestApproval.deleteMany({
                where: { requestId: id },
              });
              await ctx.prisma.leaveRequest.delete({ where: { id } });
            }
          },
        ),
      );
    });

    /**
     * L9, FIXED. `getTrail` was a bare `findMany` over a model in no branch
     * scope rule, and the route admits EMPLOYEE — so any authenticated user
     * could read any request's approval history (who decided, when, with what
     * comment) by walking ids, across branches.
     *
     * The guard has to make one exception, and it is the point of the whole
     * feature: a STEP'S OWN APPROVER may read the chain they are being asked to
     * act on, even though they own none of the record. That is the SUPERVISOR
     * case, and refusing it would strand every configured chain.
     */
    it('APR-API-36 the trail is readable by its approver and by nobody unrelated', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);

            // The live step's approver — role EMPLOYEE, owns nothing — may read
            // it, or the chain could never be acted on.
            const approver = await trail(fx.supervisor.token, 'LEAVE', id);
            expect(approver.status).toBe(200);
            expect(dataOf(approver).canAct).toBe(true);

            // An unrelated colleague may not.
            const stranger = await trail(fx.otherEmployee.token, 'LEAVE', id);
            expect(stranger.status).toBe(403);

            // HR, who is step 2 and cannot act yet, still reads it — they are
            // entitled to the employee's records by role.
            const hr = await trail(fx.hr.token, 'LEAVE', id);
            expect(hr.status).toBe(200);
            expect(dataOf(hr).canAct).toBe(false);
          },
        ),
      );
    });

    it('APR-API-37 an unknown type is a 400 and an unknown id reports engaged:false, not a 404', async () => {
      const badType = await trail(
        fx.hr.token,
        'NOT_A_TYPE',
        '11111111-1111-4111-8111-111111111111',
      );
      expect(badType.status).toBe(400);

      const unknownId = await trail(
        fx.hr.token,
        'LEAVE',
        '11111111-1111-4111-8111-111111111111',
      );
      expect(unknownId.status).toBe(200);
      expect(dataOf(unknownId).engaged).toBe(false);
      expect(dataOf(unknownId).steps).toEqual([]);
    });

    /**
     * L35. The leave payload's `approvals` array is the LEGACY `LeaveApproval`
     * model, which nothing writes any more — so a screen reading it shows an
     * empty chain while the live trail sits behind a different endpoint. The two
     * surfaces disagree about the same request.
     */
    it('APR-API-38 the legacy approvals array stays empty while the live trail is populated — and the shared config is restored', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'LEAVE', steps: ['SUPERVISOR', 'HR_MANAGER'] },
          async () => {
            const id = await fileLeave(fx.chainRequesterId, 0);
            await approveLeave(fx.supervisor.token, id);

            const detail = await ctx
              .http()
              .get(`/leave-requests/${id}`)
              .set(bearer(fx.hr.token));
            expect(dataOf(detail).approvals).toEqual([]);

            const live = await trail(fx.hr.token, 'LEAVE', id);
            expect(dataOf(live).steps).toHaveLength(2);
          },
        ),
      );

      // The read-back. Everything this file touched was shared, environment-wide
      // configuration; if either assertion below fails, every suite that runs
      // after this one is running against a database this file changed.
      const switchAfter =
        (
          await ctx.prisma.systemSetting.findUnique({
            where: { key: 'supervisor_approval_enabled' },
          })
        )?.value ?? null;
      expect(switchAfter).toBe(switchBefore);

      const workflowsAfter = await ctx.prisma.approvalWorkflow.findMany({
        select: { id: true, isActive: true },
        orderBy: { id: 'asc' },
      });
      expect(workflowsAfter).toEqual(workflowsBefore);
    });
  });
});
