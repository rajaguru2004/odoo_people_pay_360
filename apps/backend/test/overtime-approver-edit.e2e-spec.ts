import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupLeaveOvertimeFixtures,
  LeaveOtFixtures,
  freeDate,
  dayOfWeekUtc,
  atUtc,
} from './utils/leave-overtime-fixtures';
import { bearer, withSetting, withSettings } from './utils/settings';

/**
 * An approver correcting an overtime request while approving it, end to end.
 *
 * ── What the lower layers already own, and is NOT re-derived here ───────────
 *
 *   - `overtime-approver-edit.spec.ts` owns the guard ORDER, the audit payload
 *     shape and the ordering of the write against `decide()`, all against
 *     mocks. This file never re-asserts those against a mock's call log.
 *   - `overtime-calc.util.spec.ts` owns the tier arithmetic and the boundary
 *     clamp; `overtime-request.e2e-spec.ts` owns submission and the caps as
 *     filed. In scope here: what a CORRECTION does to a row that already exists.
 *
 * ── What e2e uniquely adds ──────────────────────────────────────────────────
 *
 * The real approval chain over real `RequestApproval` rows — which is the only
 * place two of these behaviours are observable at all:
 *
 *   1. A Step-1 SUPERVISOR's correction has to SURVIVE to Step 2. `decide()`
 *      records the step and returns with the request still PENDING, never
 *      reaching `finalizeOvertimeApproval()`, so an edit written there would be
 *      lost — and lost silently, since the response for step 1 looks identical
 *      either way. Only reading the row back as the next approver shows it.
 *   2. `siteAllowance` has to survive the recompute that approval performs.
 *      `finalizeOvertimeApproval()` overwrites every derived column from the
 *      policy; nothing derives a site allowance, so it lives or dies on being
 *      absent from that payload.
 *
 * Plus the real settings gates, the real caps re-accumulating over real rows,
 * and the real eligibility test the engine applies to a role=EMPLOYEE
 * supervisor.
 *
 * ── The hazard this file inherits ───────────────────────────────────────────
 *
 * Overtime's scarce resource is an employee-MONTH: `maxHoursPerMonth` sums
 * `PENDING + APPROVED`, so a row left behind changes the NEXT case's cap
 * arithmetic and the failure reads like a broken rule. `afterEach` deletes
 * every request belonging to this file's actors.
 *
 * Date block 800–899 (see the fixtures header).
 *
 * ── Actors this file OWNS for writes ────────────────────────────────────────
 *
 *   chainRequester (supervised by `supervisor`) · otStaff (the no-chain arm)
 */
describe('Overtime — approver review and edit at approval (e2e)', () => {
  let ctx: E2EContext;
  let fx: LeaveOtFixtures;

  const body = (res: any) => JSON.stringify(res.body);

  const approve = (token: string, id: string, payload: any = {}) =>
    ctx.http().post(`/overtime/${id}/approve`).set(bearer(token)).send(payload);
  const editPreview = (token: string, id: string, payload: any) =>
    ctx
      .http()
      .post(`/overtime/${id}/edit-preview`)
      .set(bearer(token))
      .send(payload);
  const reject = (token: string, id: string, reason: string) =>
    ctx
      .http()
      .post(`/overtime/${id}/reject`)
      .set(bearer(token))
      .send({ rejectedReason: reason });
  const detail = (token: string, id: string) =>
    ctx.http().get(`/overtime/${id}`).set(bearer(token));
  const inbox = (token: string) =>
    ctx.http().get('/approval-workflows/inbox').set(bearer(token));

  const rowOf = (id: string) =>
    ctx.prisma.overtimeRequest.findUniqueOrThrow({ where: { id } });

  /** A Mon–Fri date in this file's block — a WEEKDAY in branchMain. */
  const weekday = (offset: number) => {
    for (let i = 0; i < 8; i++) {
      const iso = freeDate(800 + offset + i);
      const dow = dayOfWeekUtc(iso);
      if (dow !== 0 && dow !== 6) return iso;
    }
    /* istanbul ignore next — a week always contains a weekday. */
    throw new Error('approver-edit spec: no weekday found');
  };

  /**
   * Files a request through the API so `initiate()` really runs and a trail
   * exists.
   *
   * 19:00–20:00 → 1h REGULAR, before the 22:00 late threshold. The START is
   * 19:00 rather than 18:00 so a correction can cross that threshold and still
   * land inside the 4h daily cap: from 18:00 the only windows that reach 22:00
   * are 4h+, and every case below would refuse for the cap instead of proving
   * what it is about. `OT-EDIT-30` owns the cap.
   */
  const file = async (
    employeeId: string,
    offset: number,
    over: Record<string, unknown> = {},
  ) => {
    const date = weekday(offset);
    const res = await ctx
      .http()
      .post(`/overtime/employee/${employeeId}`)
      .set(bearer(fx.hr.token))
      .send({
        date,
        startTime: atUtc(date, '19:00'),
        endTime: atUtc(date, '20:00'),
        hours: 1,
        reason: `approver-edit spec ${fx.runId}`,
        ...over,
      });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, date };
  };

  /** Everything in the chain cases happens with the master switch ON. */
  const withChain = <T>(fn: () => Promise<T>) =>
    withSetting(ctx, 'supervisor_approval_enabled', 'true', fn);

  /** The feature's own two gates, both on. */
  const withEditOn = <T>(fn: () => Promise<T>) =>
    withSettings(
      ctx,
      {
        overtime_approver_edit_enabled: 'true',
        overtime_site_allowance_enabled: 'true',
        overtime_site_allowance_max: '0',
      },
      fn,
    );

  let owned: string[] = [];

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupLeaveOvertimeFixtures(ctx);
    owned = [fx.chainRequesterId, fx.otStaffId];
  }, 120000);

  afterEach(async () => {
    const ids = (
      await ctx.prisma.overtimeRequest.findMany({
        where: { employeeId: { in: owned } },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (ids.length) {
      await ctx.prisma.requestApproval.deleteMany({
        where: { requestId: { in: ids } },
      });
    }
    await ctx.prisma.overtimeRequest.deleteMany({
      where: { employeeId: { in: owned } },
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the correction survives the chain', () => {
    it('OT-EDIT-01 a Step-1 SUPERVISOR correction is visible to Step 2', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR', 'HR_MANAGER'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 0);

              const res = await approve(fx.supervisor.token, id, {
                endTime: atUtc(date, '22:30'),
                approverNote: 'Gate log shows 22:30',
              });
              expect(res.status).toBe(201);

              // Still PENDING: this was an intermediate step.
              const mid = await rowOf(id);
              expect(mid.status).toBe('PENDING');
              // The correction is on the row, NOT deferred to finalize.
              expect(mid.endTime.toISOString()).toBe(atUtc(date, '22:30'));
              expect(mid.approverNote).toBe('Gate log shows 22:30');
              expect(mid.originalEndTime?.toISOString()).toBe(
                atUtc(date, '20:00'),
              );

              // And the next approver's inbox shows the corrected window.
              const box = await inbox(fx.hr.token);
              expect(box.status).toBe(200);
              const item = box.body.data.find((i: any) => i.requestId === id);
              expect(item).toBeDefined();
              expect(new Date(item.request.endTime).toISOString()).toBe(
                atUtc(date, '22:30'),
              );
            },
          ),
        ),
      );
    });

    it('OT-EDIT-02 the corrected window drives the final classification and pay', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR', 'HR_MANAGER'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 10);
              const before = await rowOf(id);
              expect(before.otType).toBe('REGULAR');
              expect(Number(before.hours)).toBe(1);

              await approve(fx.supervisor.token, id, {
                endTime: atUtc(date, '22:30'),
              });
              expect((await approve(fx.hr.token, id)).status).toBe(201);

              const after = await rowOf(id);
              expect(after.status).toBe('APPROVED');
              // 19:00–22:30 = 3.5h, split at the 22:00 late threshold.
              expect(Number(after.hours)).toBe(3.5);
              expect(Number(after.regularHours)).toBe(3);
              expect(Number(after.lateHours)).toBe(0.5);
              expect(after.otType).toBe('LATE');
              // The buckets must still sum to the payable total.
              expect(
                Number(after.regularHours) +
                  Number(after.lateHours) +
                  Number(after.doubleHours) +
                  Number(after.doubleLateHours),
              ).toBe(Number(after.hours));
            },
          ),
        ),
      );
    });

    it('OT-EDIT-03 a later approver may correct again; the FILED window is still the original', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR', 'HR_MANAGER'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 20);

              await approve(fx.supervisor.token, id, {
                endTime: atUtc(date, '21:00'),
              });
              await approve(fx.hr.token, id, { endTime: atUtc(date, '22:30') });

              const after = await rowOf(id);
              expect(after.status).toBe('APPROVED');
              expect(after.endTime.toISOString()).toBe(atUtc(date, '22:30'));
              // Not 21:00 — the snapshot is taken on the FIRST edit only.
              expect(after.originalEndTime?.toISOString()).toBe(
                atUtc(date, '20:00'),
              );

              const entries = await ctx.prisma.auditLog.findMany({
                where: { action: 'OVERTIME_APPROVER_EDIT', resourceId: id },
              });
              expect(entries).toHaveLength(2);
            },
          ),
        ),
      );
    });

    it('OT-EDIT-04 a correction made before a REJECT stays on the rejected row', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR', 'HR_MANAGER'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 30);

              await approve(fx.supervisor.token, id, {
                endTime: atUtc(date, '22:30'),
                siteAllowance: 25,
              });
              expect((await reject(fx.hr.token, id, 'not authorised')).status).toBe(
                201,
              );

              const after = await rowOf(id);
              expect(after.status).toBe('REJECTED');
              // The record of what was reviewed is not rolled back.
              expect(after.endTime.toISOString()).toBe(atUtc(date, '22:30'));
              expect(Number(after.siteAllowance)).toBe(25);
            },
          ),
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('site allowance', () => {
    it('OT-EDIT-10 survives the recompute that approval performs', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id } = await file(fx.chainRequesterId, 40);

              const res = await approve(fx.supervisor.token, id, {
                siteAllowance: 25.5,
                siteAllowanceNote: 'Offshore rig — night access',
              });
              expect(res.status).toBe(201);

              const after = await rowOf(id);
              expect(after.status).toBe('APPROVED');
              expect(Number(after.siteAllowance)).toBe(25.5);
              expect(after.siteAllowanceNote).toBe('Offshore rig — night access');
            },
          ),
        ),
      );
    });

    it('OT-EDIT-11 is refused while the switch is off, and the refusal says so', async () => {
      await withChain(() =>
        withSettings(
          ctx,
          {
            overtime_approver_edit_enabled: 'true',
            overtime_site_allowance_enabled: 'false',
          },
          () =>
            fx.withWorkflow(
              { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
              async () => {
                const { id } = await file(fx.chainRequesterId, 50);

                const res = await approve(fx.supervisor.token, id, {
                  siteAllowance: 25,
                });
                expect(res.status).toBe(400);
                expect(body(res)).toMatch(/Site allowance is disabled/);

                // Refused entirely: the decision did not go through either.
                expect((await rowOf(id)).status).toBe('PENDING');
              },
            ),
        ),
      );
    });

    it('OT-EDIT-12 is refused above the ceiling, and 0 means no ceiling', async () => {
      await withChain(() =>
        fx.withWorkflow(
          { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
          async () => {
            const { id } = await file(fx.chainRequesterId, 60);

            await withSettings(
              ctx,
              {
                overtime_approver_edit_enabled: 'true',
                overtime_site_allowance_enabled: 'true',
                overtime_site_allowance_max: '20',
              },
              async () => {
                const res = await approve(fx.supervisor.token, id, {
                  siteAllowance: 25,
                });
                expect(res.status).toBe(400);
                expect(body(res)).toMatch(/exceeds the maximum of 20/);
              },
            );

            await withEditOn(async () => {
              const ok = await approve(fx.supervisor.token, id, {
                siteAllowance: 25,
              });
              expect(ok.status).toBe(201);
              expect(Number((await rowOf(id)).siteAllowance)).toBe(25);
            });
          },
        ),
      );
    });

    it('OT-EDIT-13 refuses a negative amount at the DTO boundary', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id } = await file(fx.chainRequesterId, 70);
              const res = await approve(fx.supervisor.token, id, {
                siteAllowance: -5,
              });
              expect(res.status).toBe(400);
              expect((await rowOf(id)).status).toBe('PENDING');
            },
          ),
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('food allowance override', () => {
    it('OT-EDIT-20 an explicit 0 suppresses an allowance the policy would pay', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 80);

              // Control first: the corrected window alone earns the allowance.
              const preview = await editPreview(fx.supervisor.token, id, {
                endTime: atUtc(date, '22:30'),
              });
              expect(preview.status).toBe(201);
              expect(Number(preview.body.foodAllowance)).toBeGreaterThan(0);

              await approve(fx.supervisor.token, id, {
                endTime: atUtc(date, '22:30'),
                foodAllowance: 0,
              });

              const after = await rowOf(id);
              expect(after.status).toBe('APPROVED');
              expect(Number(after.foodAllowance)).toBe(0);
              expect(Number(after.foodAllowanceOverride)).toBe(0);
            },
          ),
        ),
      );
    });

    it('OT-EDIT-21 with no override the policy still decides at approval', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 90);

              await approve(fx.supervisor.token, id, {
                endTime: atUtc(date, '22:30'),
              });

              const after = await rowOf(id);
              expect(after.foodAllowanceOverride).toBeNull();
              expect(Number(after.foodAllowance)).toBeGreaterThan(0);
            },
          ),
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the corrected window is held to the submission rules', () => {
    it('OT-EDIT-30 refuses a correction that breaches the daily cap', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withPolicyRules(fx.policyTightCaps, {}, () =>
            fx.withWorkflow(
              { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
              async () => {
                const { id, date } = await file(fx.chainRequesterId, 100);

                // 19:00 → 23:59 is 4.98h against the Company Default 4h day cap.
                const res = await approve(fx.supervisor.token, id, {
                  endTime: atUtc(date, '23:59'),
                });
                expect(res.status).toBe(400);
                expect(body(res)).toMatch(/Daily overtime limit exceeded/);
                expect((await rowOf(id)).status).toBe('PENDING');
              },
            ),
          ),
        ),
      );
    });

    it('OT-EDIT-31 refuses a correction that starts inside working hours', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 110);

              const res = await approve(fx.supervisor.token, id, {
                startTime: atUtc(date, '10:00'),
                endTime: atUtc(date, '13:00'),
              });
              expect(res.status).toBe(400);
              expect(body(res)).toMatch(/outside of regular work hours/i);
            },
          ),
        ),
      );
    });

    it('OT-EDIT-32 a correction excludes the row under edit from the monthly cap', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 120);

              // Shrinking the window can never breach a cap the same row is
              // already inside — unless the sum double-counts it.
              const res = await approve(fx.supervisor.token, id, {
                endTime: atUtc(date, '19:30'),
              });
              expect(res.status).toBe(201);
              expect(Number((await rowOf(id)).hours)).toBe(0.5);
            },
          ),
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('who may correct', () => {
    it('OT-EDIT-40 refuses an approver who is not on the active step', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR', 'HR_MANAGER'] },
            async () => {
              const { id } = await file(fx.chainRequesterId, 130);

              // HR is step 2; step 1 is still ACTIVE.
              const res = await approve(fx.hr.token, id, { siteAllowance: 25 });
              expect(res.status).toBe(403);
              expect(Number((await rowOf(id)).siteAllowance)).toBe(0);
            },
          ),
        ),
      );
    });

    it('OT-EDIT-41 refuses an unrelated employee outright', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id } = await file(fx.chainRequesterId, 140);

              const res = await approve(fx.employee.token, id, {
                siteAllowance: 25,
              });
              expect([403, 404]).toContain(res.status);
              expect((await rowOf(id)).status).toBe('PENDING');
            },
          ),
        ),
      );
    });

    it('OT-EDIT-42 with no chain, HR may correct and a plain EMPLOYEE may not', async () => {
      await withSetting(ctx, 'supervisor_approval_enabled', 'false', () =>
        withEditOn(async () => {
          const a = await file(fx.otStaffId, 150);
          const denied = await approve(fx.employee.token, a.id, {
            siteAllowance: 25,
          });
          expect([403, 404]).toContain(denied.status);

          const ok = await approve(fx.hr.token, a.id, { siteAllowance: 25 });
          expect(ok.status).toBe(201);
          const after = await rowOf(a.id);
          expect(after.status).toBe('APPROVED');
          expect(Number(after.siteAllowance)).toBe(25);
        }),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('gates and concurrency', () => {
    it('OT-EDIT-50 with the kill switch off an edit is refused but a plain approve is not', async () => {
      await withChain(() =>
        withSettings(
          ctx,
          {
            overtime_approver_edit_enabled: 'false',
            overtime_site_allowance_enabled: 'true',
          },
          () =>
            fx.withWorkflow(
              { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
              async () => {
                const { id, date } = await file(fx.chainRequesterId, 160);

                const refused = await approve(fx.supervisor.token, id, {
                  endTime: atUtc(date, '22:30'),
                });
                expect(refused.status).toBe(400);
                expect(body(refused)).toMatch(/disabled/i);

                // The bodyless decision is untouched by the switch.
                const ok = await approve(fx.supervisor.token, id);
                expect(ok.status).toBe(201);
                expect((await rowOf(id)).status).toBe('APPROVED');
              },
            ),
        ),
      );
    });

    it('OT-EDIT-51 a stale expectedUpdatedAt is a 409, a fresh one is accepted', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id } = await file(fx.chainRequesterId, 170);
              const seen = (await rowOf(id)).updatedAt.toISOString();

              const stale = await approve(fx.supervisor.token, id, {
                siteAllowance: 25,
                expectedUpdatedAt: new Date(
                  new Date(seen).getTime() - 60_000,
                ).toISOString(),
              });
              expect(stale.status).toBe(409);
              expect(Number((await rowOf(id)).siteAllowance)).toBe(0);

              const fresh = await approve(fx.supervisor.token, id, {
                siteAllowance: 25,
                expectedUpdatedAt: seen,
              });
              expect(fresh.status).toBe(201);
            },
          ),
        ),
      );
    });

    it('OT-EDIT-52 refuses a correction on a request that is no longer pending', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id } = await file(fx.chainRequesterId, 180);
              expect((await approve(fx.supervisor.token, id)).status).toBe(201);

              const res = await approve(fx.supervisor.token, id, {
                siteAllowance: 25,
              });
              expect(res.status).toBe(400);
              expect(body(res)).toMatch(/pending/i);
            },
          ),
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('edit-preview', () => {
    it('OT-EDIT-60 returns the corrected breakdown and rates and writes nothing', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 190);
              const before = await rowOf(id);

              const res = await editPreview(fx.supervisor.token, id, {
                endTime: atUtc(date, '22:30'),
                siteAllowance: 25,
              });
              expect(res.status).toBe(201);
              expect(res.body.hours).toBe(3.5);
              expect(res.body.regularHours).toBe(3);
              expect(res.body.lateHours).toBe(0.5);
              expect(res.body.otType).toBe('LATE');
              expect(res.body.siteAllowance).toBe(25);
              expect(res.body.regularRate).toBeGreaterThan(0);
              expect(res.body.lateRate).toBeGreaterThan(0);

              const after = await rowOf(id);
              expect(after.updatedAt.toISOString()).toBe(
                before.updatedAt.toISOString(),
              );
              expect(Number(after.hours)).toBe(1);
              expect(Number(after.siteAllowance)).toBe(0);
            },
          ),
        ),
      );
    });

    it('OT-EDIT-61 the preview agrees with what approving then persists', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 200);

              const preview = await editPreview(fx.supervisor.token, id, {
                endTime: atUtc(date, '22:30'),
              });
              expect(preview.status).toBe(201);

              await approve(fx.supervisor.token, id, {
                endTime: atUtc(date, '22:30'),
              });
              const after = await rowOf(id);

              // The whole point of a server-side preview: the approver is shown
              // the figure that gets frozen, not an estimate of it.
              expect(Number(after.hours)).toBe(preview.body.hours);
              expect(Number(after.regularHours)).toBe(preview.body.regularHours);
              expect(Number(after.lateHours)).toBe(preview.body.lateHours);
              expect(after.otType).toBe(preview.body.otType);
              expect(Number(after.foodAllowance)).toBe(
                preview.body.foodAllowance,
              );
            },
          ),
        ),
      );
    });

    it('OT-EDIT-62 refuses a preview to someone who could not make the edit', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR', 'HR_MANAGER'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 210);
              const res = await editPreview(fx.hr.token, id, {
                endTime: atUtc(date, '22:30'),
              });
              expect(res.status).toBe(403);
            },
          ),
        ),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('what the approver is shown', () => {
    it('OT-EDIT-70 the detail door carries the window, the allowances and the rates', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 220);
              await approve(fx.supervisor.token, id, { siteAllowance: 25 });

              // A chain participant may read the detail even owning none of the
              // record — that exemption is what makes the review screen work.
              const res = await detail(fx.supervisor.token, id);
              expect(res.status).toBe(200);
              expect(new Date(res.body.startTime).toISOString()).toBe(
                atUtc(date, '19:00'),
              );
              expect(new Date(res.body.endTime).toISOString()).toBe(
                atUtc(date, '20:00'),
              );
              expect(Number(res.body.siteAllowance)).toBe(25);
              expect(res.body.preview).toBeTruthy();
              expect(Number(res.body.preview.siteAllowance)).toBe(25);
              expect(res.body.preview.regularRate).toBeGreaterThan(0);
            },
          ),
        ),
      );
    });

    it('OT-EDIT-71 the inbox carries the window and the allowances, not just the hours', async () => {
      await withChain(() =>
        withEditOn(() =>
          fx.withWorkflow(
            { requestType: 'OVERTIME', steps: ['SUPERVISOR'] },
            async () => {
              const { id, date } = await file(fx.chainRequesterId, 230);

              const box = await inbox(fx.supervisor.token);
              expect(box.status).toBe(200);
              const item = box.body.data.find((i: any) => i.requestId === id);
              expect(item).toBeDefined();
              expect(new Date(item.request.startTime).toISOString()).toBe(
                atUtc(date, '19:00'),
              );
              expect(new Date(item.request.endTime).toISOString()).toBe(
                atUtc(date, '20:00'),
              );
              expect(item.request).toHaveProperty('foodAllowance');
              expect(item.request).toHaveProperty('siteAllowance');
            },
          ),
        ),
      );
    });
  });
});
