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
 * Overtime requests, end to end.
 *
 * ── What the lower layers already own, and is NOT re-derived here ───────────
 *
 *   - `overtime-calc.util.spec.ts` owns the tier-split arithmetic, the
 *     day-boundary clamp and the food-allowance threshold. This file asserts
 *     only that the persisted buckets SUM to `hours` and that the day-type
 *     routing picked the right tier — never the multiplication itself.
 *   - `overtime.service.spec.ts` owns the classification rules against mocks.
 *   - `overtime-policy.crud.spec.ts` and its three siblings own policy
 *     create/update/setDefault/setActive/remove and the clash rules. This file
 *     CONSUMES policies; it does not re-derive their CRUD.
 *   - `daily-wage-overtime.e2e-spec.ts` owns the rate arithmetic and the
 *     payslip. In scope here: the tier split, `foodAllowance`, `dayType` and
 *     the `overtimePolicyId` snapshot AS STORED ON THE ROW.
 *
 * ── What e2e uniquely adds ──────────────────────────────────────────────────
 *
 * The real policy-resolution chain against real rows (Employee Override →
 * Employment Type → Company Default → legacy globals), real branch-aware
 * holiday and weekly-off lookups, the real caps accumulating across real
 * requests, and the recompute that happens at approval.
 *
 * ── The hazard this file exists to neutralise ───────────────────────────────
 *
 * **Overtime's scarce resource is an employee-MONTH, not a date.**
 * `maxHoursPerMonth` and `maxHoursPerYear` sum `PENDING + APPROVED`, so a row a
 * previous case left behind silently changes the next case's cap arithmetic —
 * and the failure reads exactly like a broken rule rather than like dirty
 * state. `afterEach` therefore deletes every `OvertimeRequest` belonging to this
 * file's actors, so each case starts from zero hours.
 *
 * ── A correction that shapes every cap case ─────────────────────────────────
 *
 * Caps, rates and thresholds do NOT come from system settings for a normally
 * assigned employee: `OvertimePolicyService.onModuleInit` seeds a "Company
 * Default" policy from the globals at first boot, and `mergeRulesOverGlobal`
 * takes `rules.maxHoursPerDay` OVER the live setting. So every cap case drives
 * a fixture-owned policy through `withPolicyRules`, and `OT-API-17` pins the
 * fact itself. Only `overtime_enabled`, `overtime_allow_employee_submit`,
 * `overtime_require_reason` and `office_start_time` are still live globals.
 *
 * ── Actors this file OWNS for writes ────────────────────────────────────────
 *
 *   otStaff · otCapped · otIneligible · otIgnore · otBoundary · otTypeStaff ·
 *   altStaff (the per-branch day-type contrast) · applicant (self-service)
 */
describe('Overtime — registering, capping and deciding (e2e)', () => {
  let ctx: E2EContext;
  let fx: LeaveOtFixtures;

  const body = (res: any) => JSON.stringify(res.body);

  /** Thin request helpers. */
  const create = (token: string, payload: Record<string, unknown>) =>
    ctx.http().post('/overtime').set(bearer(token)).send(payload);
  const createFor = (
    token: string,
    employeeId: string,
    payload: Record<string, unknown>,
  ) =>
    ctx
      .http()
      .post(`/overtime/employee/${employeeId}`)
      .set(bearer(token))
      .send(payload);
  const approve = (token: string, id: string) =>
    ctx.http().post(`/overtime/${id}/approve`).set(bearer(token)).send({});
  const reject = (token: string, id: string, payload: any) =>
    ctx.http().post(`/overtime/${id}/reject`).set(bearer(token)).send(payload);
  const cancel = (token: string, id: string) =>
    ctx.http().delete(`/overtime/${id}`).set(bearer(token));

  /**
   * `n` working days (Mon–Fri, so working in branchMain which rests Sun+Sat),
   * all inside ONE calendar month, starting at or after the given offset.
   *
   * The single-month constraint is what makes the monthly-cap cases mean
   * anything: two dates that straddle a month boundary reset the counter and the
   * case passes for the wrong reason.
   */
  const workdaysInOneMonth = (offset: number, n: number): string[] => {
    for (let base = 0; base < 60; base++) {
      const out: string[] = [];
      let month: string | null = null;
      for (let i = 0; out.length < n && i < 40; i++) {
        const iso = freeDate(350 + offset + base + i);
        const dow = dayOfWeekUtc(iso);
        if (dow === 0 || dow === 6) continue;
        const m = iso.slice(0, 7);
        if (month === null) month = m;
        if (m !== month) break;
        out.push(iso);
      }
      if (out.length === n) return out;
    }
    /* istanbul ignore next — every month has at least five weekdays. */
    throw new Error('overtime spec: could not allocate a single-month run');
  };

  /** One Mon–Fri date: a WEEKDAY in branchMain. */
  const weekday = (offset: number) => workdaysInOneMonth(offset, 1)[0];

  /** One Saturday: a REST day in branchMain, an ordinary working day in branchAlt. */
  const saturday = (offset: number) => {
    for (let i = 0; i < 8; i++) {
      const iso = freeDate(350 + offset + i);
      if (dayOfWeekUtc(iso) === 6) return iso;
    }
    /* istanbul ignore next */
    throw new Error('overtime spec: no Saturday found');
  };

  const shift = (
    date: string,
    from: string,
    to: string,
    hours: number,
    over: Record<string, unknown> = {},
  ) => ({
    date,
    startTime: atUtc(date, from),
    endTime: atUtc(date, to),
    hours,
    reason: `overtime spec ${fx.runId}`,
    ...over,
  });

  let owned: string[] = [];

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupLeaveOvertimeFixtures(ctx);
    owned = [
      fx.otStaffId,
      fx.otCappedId,
      fx.otIneligibleId,
      fx.otIgnoreId,
      fx.otBoundaryId,
      fx.otTypeStaffId,
      fx.altStaffId,
      fx.applicantId,
      fx.finStaffId,
    ];
  }, 120000);

  afterEach(async () => {
    // See the file header: an employee-month is the scarce resource, and a
    // leftover row changes the NEXT case's cap arithmetic rather than its own.
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
  describe('who may register, and for whom', () => {
    it.each([
      ['GET /overtime', () => '/overtime'],
      ['GET /overtime/pending', () => '/overtime/pending'],
    ])('OT-API-01 %s admits ADMIN, HR and MANAGER and refuses EMPLOYEE', async (
      _label,
      path,
    ) => {
      for (const actor of [fx.admin, fx.hr, fx.mgr]) {
        const res = await ctx.http().get(path()).set(bearer(actor.token));
        expect(res.status).toBe(200);
      }
      expect(
        (await ctx.http().get(path()).set(bearer(fx.employee.token))).status,
      ).toBe(403);
      expect((await ctx.http().get(path())).status).toBe(401);
    });

    it.each([
      [
        'GET /overtime/employee/:id/hours/:m/:y',
        (fxx: LeaveOtFixtures) =>
          `/overtime/employee/${fxx.otStaffId}/hours/6/2027`,
      ],
      [
        'GET /overtime/report/:m/:y',
        () => '/overtime/report/6/2027',
      ],
    ])('OT-API-01b %s is ADMIN and HR only', async (_label, path) => {
      for (const actor of [fx.admin, fx.hr]) {
        const res = await ctx.http().get(path(fx)).set(bearer(actor.token));
        expect(res.status).toBe(200);
      }
      for (const actor of [fx.mgr, fx.employee]) {
        const res = await ctx.http().get(path(fx)).set(bearer(actor.token));
        expect(res.status).toBe(403);
      }
    });

    it('OT-API-02 every role registers its own overtime; anonymous is refused', async () => {
      const dates = workdaysInOneMonth(0, 3);
      const actors = [fx.hr, fx.mgr, fx.employee];
      for (let i = 0; i < actors.length; i++) {
        const res = await create(
          actors[i].token,
          shift(dates[i], '18:00', '20:00', 2),
        );
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('PENDING');
      }
      const anon = await ctx
        .http()
        .post('/overtime')
        .send(shift(dates[0], '18:00', '20:00', 2));
      expect(anon.status).toBe(401);

      await ctx.prisma.overtimeRequest.deleteMany({
        where: { reason: { contains: fx.runId } },
      });
    });

    it('OT-API-03 registering on behalf is ADMIN and HR only', async () => {
      const dates = workdaysInOneMonth(0, 2);
      const ok = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(dates[0], '18:00', '20:00', 2),
      );
      expect(ok.status).toBe(201);
      expect(ok.body.employeeId).toBe(fx.otStaffId);

      for (const actor of [fx.mgr, fx.employee]) {
        const res = await createFor(
          actor.token,
          fx.otStaffId,
          shift(dates[1], '18:00', '20:00', 2),
        );
        expect(res.status).toBe(403);
      }
    });

    /**
     * L28. `user.employeeId` is undefined for an ADMIN with no linked employee,
     * and `POST /overtime` passes it straight to
     * `employee.findUnique({ where: { id: undefined } })`. The same class as
     * attendance A21, which was fixed there and not here.
     */
    it('OT-API-04 an ADMIN with no linked employee is refused by name, without leaking internals', async () => {
      // L28, FIXED. The undefined id reached
      // `findUnique({ where: { id: undefined } })` and answered 500 with the
      // Prisma invocation AND the absolute path of the source file in the body.
      // Leave's equivalent door always answered a clean 400; this one now does
      // too.
      const res = await create(
        fx.admin.token,
        shift(weekday(0), '18:00', '20:00', 2),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Employee ID is required');
      expect(body(res)).not.toContain('prisma');
      expect(body(res)).not.toContain('overtime.service.ts');
    });

    it('OT-API-05 an unknown employee id answers 404 Employee not found', async () => {
      const res = await createFor(
        fx.hr.token,
        '11111111-1111-4111-8111-111111111111',
        shift(weekday(0), '18:00', '20:00', 2),
      );
      expect(res.status).toBe(404);
      expect(body(res)).toContain('Employee not found');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the kill switches, both ways', () => {
    it('OT-API-06 overtime_enabled gates both create doors', async () => {
      const dates = workdaysInOneMonth(0, 2);
      await withSetting(ctx, 'overtime_enabled', 'false', async () => {
        const self = await create(
          fx.employee.token,
          shift(dates[0], '18:00', '20:00', 2),
        );
        expect(self.status).toBe(400);
        expect(body(self)).toContain('Overtime feature is disabled');

        const onBehalf = await createFor(
          fx.hr.token,
          fx.otStaffId,
          shift(dates[0], '18:00', '20:00', 2),
        );
        expect(onBehalf.status).toBe(400);
      });

      await withSetting(ctx, 'overtime_enabled', 'true', async () => {
        const res = await createFor(
          fx.hr.token,
          fx.otStaffId,
          shift(dates[1], '18:00', '20:00', 2),
        );
        expect(res.status).toBe(201);
      });
    });

    it('OT-API-07 disabling employee submission stops the EMPLOYEE while HR-on-behalf still works', async () => {
      const dates = workdaysInOneMonth(0, 2);
      await withSetting(
        ctx,
        'overtime_allow_employee_submit',
        'false',
        async () => {
          const denied = await create(
            fx.employee.token,
            shift(dates[0], '18:00', '20:00', 2),
          );
          expect(denied.status).toBe(403);
          expect(body(denied)).toContain(
            'Employee submission of overtime is disabled by administrator',
          );

          // The gate is on the ACTOR's role, not on the employee being booked.
          const onBehalf = await createFor(
            fx.hr.token,
            fx.otStaffId,
            shift(dates[1], '18:00', '20:00', 2),
          );
          expect(onBehalf.status).toBe(201);
        },
      );
    });

    it('OT-API-08 overtime_require_reason is enforced when on and stores an empty string when off', async () => {
      const dates = workdaysInOneMonth(0, 2);
      await withSetting(ctx, 'overtime_require_reason', 'true', async () => {
        const res = await createFor(fx.hr.token, fx.otStaffId, {
          ...shift(dates[0], '18:00', '20:00', 2),
          reason: undefined,
        });
        expect(res.status).toBe(400);
        expect(body(res)).toContain('Reason for overtime is required');
      });

      await withSetting(ctx, 'overtime_require_reason', 'false', async () => {
        const res = await createFor(fx.hr.token, fx.otStaffId, {
          ...shift(dates[1], '18:00', '20:00', 2),
          reason: undefined,
        });
        expect(res.status).toBe(201);
        const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
          where: { id: res.body.id },
        });
        expect(row.reason).toBe('');
      });
    });

    it('OT-API-09 a whitespace-only reason counts as blank', async () => {
      const res = await createFor(fx.hr.token, fx.otStaffId, {
        ...shift(weekday(0), '18:00', '20:00', 2),
        reason: '   ',
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Reason for overtime is required');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the policy resolution chain', () => {
    it('OT-API-10 an employee with no override resolves to the Company Default and the row snapshots it', async () => {
      const res = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(weekday(0), '18:00', '20:00', 2),
      );
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { overtimePolicy: true },
      });
      expect(row.overtimePolicyId).toBeTruthy();
      expect(row.overtimePolicy!.isDefault).toBe(true);
    });

    it('OT-API-11 an employment type resolves through the EMPLOYMENT_TYPE tier', async () => {
      const res = await createFor(
        fx.hr.token,
        fx.otTypeStaffId,
        shift(weekday(0), '18:00', '20:00', 2),
      );
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.overtimePolicyId).toBe(fx.policyByType);
    });

    it('OT-API-12 an employee override beats the employment-type policy', async () => {
      // Give the employment-type employee an override too; the override must win.
      await ctx.prisma.employee.update({
        where: { id: fx.otTypeStaffId },
        data: { overtimePolicyId: fx.policyBoundary },
      });
      try {
        const res = await createFor(
          fx.hr.token,
          fx.otTypeStaffId,
          shift(weekday(0), '18:00', '20:00', 2),
        );
        expect(res.status).toBe(201);
        const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
          where: { id: res.body.id },
        });
        expect(row.overtimePolicyId).toBe(fx.policyBoundary);
        expect(row.overtimePolicyId).not.toBe(fx.policyByType);
      } finally {
        await ctx.prisma.employee.update({
          where: { id: fx.otTypeStaffId },
          data: { overtimePolicyId: null },
        });
      }
    });

    it('OT-API-13 deactivating the override falls back down the chain on the very next request, with no re-login', async () => {
      const dates = workdaysInOneMonth(0, 2);
      const before = await createFor(
        fx.hr.token,
        fx.otBoundaryId,
        shift(dates[0], '18:00', '20:00', 2),
      );
      expect(
        (
          await ctx.prisma.overtimeRequest.findUniqueOrThrow({
            where: { id: before.body.id },
          })
        ).overtimePolicyId,
      ).toBe(fx.policyBoundary);

      await ctx.prisma.overtimePolicy.update({
        where: { id: fx.policyBoundary },
        data: { isActive: false },
      });
      try {
        const after = await createFor(
          fx.hr.token,
          fx.otBoundaryId,
          shift(dates[1], '18:00', '20:00', 2),
        );
        expect(after.status).toBe(201);
        const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
          where: { id: after.body.id },
          include: { overtimePolicy: true },
        });
        expect(row.overtimePolicyId).not.toBe(fx.policyBoundary);
        expect(row.overtimePolicy!.isDefault).toBe(true);
      } finally {
        await ctx.prisma.overtimePolicy.update({
          where: { id: fx.policyBoundary },
          data: { isActive: true },
        });
      }
    });

    it('OT-API-14 an ineligible policy refuses the request with the exact sentence', async () => {
      const res = await createFor(
        fx.hr.token,
        fx.otIneligibleId,
        shift(weekday(0), '18:00', '20:00', 2),
      );
      expect(res.status).toBe(403);
      expect(body(res)).toContain(
        'This employee is not eligible for overtime under their assigned policy',
      );
    });

    /**
     * L26. Eligibility is re-checked at approval
     * (`overtime.service.ts:481`), so a policy change between submission and
     * approval STRANDS the request: it can never be approved, and the only exit
     * left is a rejection someone has to justify. Recorded as behaviour, because
     * the re-check itself is deliberate — it stops an ineligible employee's
     * hours slipping into payroll — and the gap is the absence of a path back.
     */
    it('OT-API-15 a policy made ineligible after submission strands the request permanently', async () => {
      const created = await createFor(
        fx.hr.token,
        fx.otIgnoreId,
        shift(weekday(0), '18:00', '20:00', 2),
      );
      expect(created.status).toBe(201);

      await fx.withPolicyRules(
        fx.policyIgnoreHoliday,
        { eligible: false },
        async () => {
          const res = await approve(fx.hr.token, created.body.id);
          expect(res.status).toBe(403);
          expect(body(res)).toContain(
            'This employee is no longer eligible for overtime under their assigned policy',
          );
          const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
            where: { id: created.body.id },
          });
          expect(row.status).toBe('PENDING');
        },
      );

      // And once the policy is eligible again the same request approves — so the
      // block is the policy state, not the row.
      const recovered = await approve(fx.hr.token, created.body.id);
      expect(recovered.status).toBe(201);
    });

    it('OT-API-16 the resolve endpoint reports the same policy the request used', async () => {
      const res = await createFor(
        fx.hr.token,
        fx.otTypeStaffId,
        shift(weekday(0), '18:00', '20:00', 2),
      );
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      const resolved = await ctx
        .http()
        .get(`/overtime-policies/resolve/${fx.otTypeStaffId}`)
        .set(bearer(fx.hr.token));
      expect(resolved.status).toBe(200);
      const data = resolved.body?.data ?? resolved.body;
      expect(data.effectivePolicyId).toBe(row.overtimePolicyId);
      expect(data.source).toBe('EMPLOYMENT_TYPE');
    });

    /**
     * The fact-correction case. `mergeRulesOverGlobal` takes the policy's
     * `maxHoursPerDay` over the live setting, so moving the GLOBAL changes
     * nothing for anyone whose policy specifies it — which is everyone, because
     * `onModuleInit` seeds Company Default from the globals at first boot. Any
     * test that tried to move a cap with `withSetting` would silently assert
     * nothing.
     */
    it('OT-API-17 moving the global cap does not move the cap for a policied employee', async () => {
      const date = weekday(0);
      await withSetting(ctx, 'overtime_max_hours_per_day', '1', async () => {
        const res = await createFor(
          fx.hr.token,
          fx.otStaffId,
          shift(date, '18:00', '20:00', 2),
        );
        // 2h against a "global cap" of 1h — accepted, because the policy's own
        // value (4) is what the engine reads.
        expect(res.status).toBe(201);
      });

      // The policy value, moved through the policy, DOES bite.
      await ctx.prisma.overtimeRequest.deleteMany({
        where: { employeeId: fx.otCappedId },
      });
      const capped = await fx.withPolicyRules(
        fx.policyTightCaps,
        { maxHoursPerDay: 1 },
        async () =>
          createFor(fx.hr.token, fx.otCappedId, shift(date, '18:00', '20:00', 2)),
      );
      expect(capped.status).toBe(400);
      expect(body(capped)).toContain('Daily overtime limit exceeded (1h)');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('time and hours validation', () => {
    it('OT-API-18 fewer than half an hour is refused by the DTO', async () => {
      const date = weekday(0);
      const res = await createFor(fx.hr.token, fx.otStaffId, {
        ...shift(date, '18:00', '18:15', 0.25),
      });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('hours');
    });

    /**
     * The tolerance is written as `Math.abs(calculated - dto.hours) > 0.1`, but
     * `Math.abs(2 - 2.1)` is 0.10000000000000009 in IEEE-754 — so a discrepancy
     * of EXACTLY the documented tolerance is refused. The usable window is
     * strictly below 0.1, not up to and including it. Pinned rather than
     * corrected: the behaviour is defensible, the documented promise is not.
     */
    it('OT-API-19 the ±0.1h tolerance excludes exactly 0.1, and 0.11 is refused with both numbers', async () => {
      const dates = workdaysInOneMonth(0, 3);
      const inside = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(dates[0], '18:00', '20:00', 2.05),
      );
      expect(inside.status).toBe(201);

      const atTolerance = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(dates[1], '18:00', '20:00', 2.1),
      );
      expect(atTolerance.status).toBe(400);
      expect(body(atTolerance)).toContain('Hours do not match');

      const refused = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(dates[2], '18:00', '20:00', 2.11),
      );
      expect(refused.status).toBe(400);
      expect(body(refused)).toContain(
        'Hours do not match. Calculated: 2.00h, Entered: 2.11h',
      );
    });

    it('OT-API-20 an end at or before the start rolls forward a day rather than being refused', async () => {
      // 19:00 → 03:00 on a REST day, so the 12h double cap applies and the
      // work-hours rule is waived: what is under test is the roll-forward, not
      // the caps.
      const date = saturday(0);
      const res = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(date, '19:00', '03:00', 8),
      );
      expect(res.status).toBe(201);
      expect(body(res)).not.toContain('End time must be after start time');
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      const spanDays =
        (row.endTime.getTime() - new Date(atUtc(date, '19:00')).getTime()) /
        86400000;
      expect(spanDays).toBeGreaterThan(0.3); // the end landed on the next day
    });

    it('OT-API-21 an identical start and end becomes a 24-hour window and is then refused by the daily cap', async () => {
      const date = weekday(0);
      const res = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(date, '18:00', '18:00', 24),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Daily overtime limit exceeded');
      expect(body(res)).toContain('Registered: 24h');
    });

    /**
     * L16. `date` and `startTime` are never checked against each other. The cap,
     * the month/year counters and `dayType` all come from `date`; the paid split
     * comes from `startTime`/`endTime`. So hours can be booked into one month
     * and one day-type premium while actually being worked in another.
     */
    it('OT-API-22 the date and the times may disagree, and each rule reads a different one', async () => {
      const dates = workdaysInOneMonth(0, 2);
      const claimedDate = dates[0];
      const workedDate = dates[1];
      const res = await createFor(fx.hr.token, fx.otStaffId, {
        date: claimedDate,
        startTime: atUtc(workedDate, '18:00'),
        endTime: atUtc(workedDate, '20:00'),
        hours: 2,
        reason: `overtime spec ${fx.runId}`,
      });
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.date.toISOString().slice(0, 10)).toBe(claimedDate);
      expect(row.startTime.toISOString().slice(0, 10)).toBe(workedDate);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('day classification, which is per branch', () => {
    it('OT-API-23 an ordinary weekday is WEEKDAY / REGULAR', async () => {
      const res = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(weekday(0), '18:00', '20:00', 2),
      );
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.dayType).toBe('WEEKDAY');
      expect(row.otType).toBe('REGULAR');
    });

    it('OT-API-24 the same Saturday is a rest day in one branch and a working day in the other', async () => {
      const date = saturday(0);
      const inMain = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(date, '18:00', '20:00', 2),
      );
      const inAlt = await createFor(
        fx.hr.token,
        fx.altStaffId,
        shift(date, '18:00', '20:00', 2),
      );
      expect(inMain.status).toBe(201);
      expect(inAlt.status).toBe(201);

      const mainRow = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: inMain.body.id },
      });
      const altRow = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: inAlt.body.id },
      });
      // branchMain rests Sun+Sat; branchAlt rests Thu+Fri. Nothing but the
      // employee's branch differs between the two calls.
      expect(mainRow.dayType).toBe('SUNDAY');
      expect(altRow.dayType).toBe('WEEKDAY');
    });

    it('OT-API-25 a branch holiday and a company-wide holiday both classify as HOLIDAY', async () => {
      const branchRes = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(fx.mainHolidayDate, '18:00', '20:00', 2),
      );
      expect(branchRes.status).toBe(201);
      expect(
        (
          await ctx.prisma.overtimeRequest.findUniqueOrThrow({
            where: { id: branchRes.body.id },
          })
        ).dayType,
      ).toBe('HOLIDAY');

      // The company-wide row has branchId null, so it must reach BOTH branches.
      for (const employeeId of [fx.otStaffId, fx.altStaffId]) {
        await ctx.prisma.overtimeRequest.deleteMany({ where: { employeeId } });
        const res = await createFor(
          fx.hr.token,
          employeeId,
          shift(fx.companyHolidayDate, '18:00', '20:00', 2),
        );
        expect(res.status).toBe(201);
        expect(
          (
            await ctx.prisma.overtimeRequest.findUniqueOrThrow({
              where: { id: res.body.id },
            })
          ).dayType,
        ).toBe('HOLIDAY');
      }
    });

    it('OT-API-26 a date that is both a holiday and a rest day resolves to HOLIDAY', async () => {
      // altStaff rests Thu+Fri, and the company holiday reaches every branch.
      const dow = dayOfWeekUtc(fx.companyHolidayDate);
      if (![4, 5].includes(dow)) {
        // The fixture picks this date by scanning for a free one, so it cannot
        // be pinned to a weekday without taking a date out of circulation for
        // every later run. Assert the precedence on branchMain instead, where
        // the branch holiday's weekday IS controlled.
        expect(dayOfWeekUtc(fx.mainHolidayDate)).toBe(3);
        return;
      }
      const res = await createFor(
        fx.hr.token,
        fx.altStaffId,
        shift(fx.companyHolidayDate, '18:00', '20:00', 2),
      );
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.dayType).toBe('HOLIDAY'); // not 'SUNDAY'
    });

    it('OT-API-27 a policy that ignores holidays collapses the same date to a weekday', async () => {
      const res = await createFor(
        fx.hr.token,
        fx.otIgnoreId,
        shift(fx.mainHolidayDate, '18:00', '20:00', 2),
      );
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.dayType).toBe('WEEKDAY');
      expect(row.otType).toBe('REGULAR');
      expect(Number(row.doubleHours)).toBe(0);
    });

    it('OT-API-28 with double OT disabled a rest day falls back to the weekday cap and tier', async () => {
      const date = saturday(0);
      const res = await fx.withPolicyRules(
        fx.policyTightCaps,
        { doubleOtEnabled: false },
        async () =>
          createFor(fx.hr.token, fx.otCappedId, shift(date, '18:00', '21:00', 3)),
      );
      // The double-day cap (4) would have allowed three hours; the weekday cap
      // (2) does not.
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Daily overtime limit exceeded (2h)');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('caps', () => {
    it('OT-API-29 the daily cap accepts exactly the cap and refuses half an hour more (±)', async () => {
      const dates = workdaysInOneMonth(0, 2);
      const exact = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(dates[0], '18:00', '20:00', 2),
      );
      expect(exact.status).toBe(201);

      const over = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(dates[1], '18:00', '20:30', 2.5),
      );
      expect(over.status).toBe(400);
      expect(body(over)).toContain(
        'Daily overtime limit exceeded (2h). Registered: 2.5h',
      );
    });

    it('OT-API-30 a rest day uses the double-day cap instead', async () => {
      const date = saturday(0);
      const res = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(date, '18:00', '21:00', 3),
      );
      // Three hours: refused by the weekday cap of 2, allowed by the rest-day
      // cap of 4.
      expect(res.status).toBe(201);
    });

    it('OT-API-31 the monthly cap counts PENDING as well as APPROVED', async () => {
      const dates = workdaysInOneMonth(0, 4);
      for (const d of dates.slice(0, 3)) {
        const res = await createFor(
          fx.hr.token,
          fx.otCappedId,
          shift(d, '18:00', '20:00', 2),
        );
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('PENDING');
      }
      const over = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(dates[3], '18:00', '20:00', 2),
      );
      expect(over.status).toBe(400);
      expect(body(over)).toContain('Monthly overtime limit exceeded (6h)');
      expect(body(over)).toContain('Current: 6h');
    });

    it('OT-API-32 a rejected or cancelled request stops counting toward the month', async () => {
      const dates = workdaysInOneMonth(0, 4);
      const ids: string[] = [];
      for (const d of dates.slice(0, 3)) {
        const res = await createFor(
          fx.hr.token,
          fx.otCappedId,
          shift(d, '18:00', '20:00', 2),
        );
        ids.push(res.body.id);
      }
      const blocked = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(dates[3], '18:00', '20:00', 2),
      );
      expect(blocked.status).toBe(400);

      await reject(fx.hr.token, ids[0], { rejectedReason: 'not needed' });

      const nowFree = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(dates[3], '18:00', '20:00', 2),
      );
      expect(nowFree.status).toBe(201);
    });

    it('OT-API-33 exactly the monthly cap is accepted and half an hour over is not (±)', async () => {
      const dates = workdaysInOneMonth(0, 3);
      await createFor(fx.hr.token, fx.otCappedId, shift(dates[0], '18:00', '20:00', 2));
      await createFor(fx.hr.token, fx.otCappedId, shift(dates[1], '18:00', '20:00', 2));
      const exact = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(dates[2], '18:00', '20:00', 2),
      );
      expect(exact.status).toBe(201); // 6h, exactly the cap

      const dates2 = workdaysInOneMonth(0, 4);
      const over = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(dates2[3], '18:00', '18:30', 0.5),
      );
      expect(over.status).toBe(400);
      expect(body(over)).toContain('Monthly overtime limit exceeded (6h)');
    });

    it('OT-API-34 the yearly cap bites across two different months', async () => {
      const monthA = workdaysInOneMonth(0, 3);
      for (const d of monthA) {
        expect(
          (await createFor(fx.hr.token, fx.otCappedId, shift(d, '18:00', '20:00', 2)))
            .status,
        ).toBe(201);
      }
      // A different month, so the MONTHLY counter starts again — see OT-API-35.
      const monthB = workdaysInOneMonth(40, 3);
      expect(monthB[0].slice(0, 7)).not.toBe(monthA[0].slice(0, 7));
      expect(monthB[0].slice(0, 4)).toBe(monthA[0].slice(0, 4)); // same year

      expect(
        (
          await createFor(
            fx.hr.token,
            fx.otCappedId,
            shift(monthB[0], '18:00', '20:00', 2),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await createFor(
            fx.hr.token,
            fx.otCappedId,
            shift(monthB[1], '18:00', '20:00', 2),
          )
        ).status,
      ).toBe(201);

      // 10h now stand against a yearly cap of 10; the monthly counter is only at
      // 4 of 6, so it is the YEARLY rule that must refuse this one.
      const over = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(monthB[2], '18:00', '20:00', 2),
      );
      expect(over.status).toBe(400);
      expect(body(over)).toContain('Yearly overtime limit exceeded (10h)');
      expect(body(over)).not.toContain('Monthly overtime limit');
    });

    it('OT-API-35 a new month starts the monthly counter from zero', async () => {
      const monthA = workdaysInOneMonth(0, 3);
      for (const d of monthA) {
        await createFor(fx.hr.token, fx.otCappedId, shift(d, '18:00', '20:00', 2));
      }
      const monthB = workdaysInOneMonth(40, 1);
      expect(monthB[0].slice(0, 7)).not.toBe(monthA[0].slice(0, 7));
      const res = await createFor(
        fx.hr.token,
        fx.otCappedId,
        shift(monthB[0], '18:00', '20:00', 2),
      );
      expect(res.status).toBe(201);
    });

    /**
     * L17. The daily cap is checked against `dto.hours` (the elapsed window),
     * while the ROW stores the boundary-clamped total — and
     * `getMonthlyOvertimeHours` then sums the clamped value. So the daily rule
     * and the monthly rule run on different bases, and a request can consume
     * three hours of daily budget while consuming two of the month's.
     */
    it('OT-API-36 the daily cap is measured on the submitted hours while the row stores the clamped total', async () => {
      const date = weekday(0);
      const res = await createFor(
        fx.hr.token,
        fx.otBoundaryId,
        shift(date, '20:00', '23:00', 3),
      );
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      // The policy's dayEndBoundary is 22:00, so only two of the three hours are
      // payable — but three were what the cap was measured against.
      expect(Number(row.hours)).toBeLessThan(3);
      expect(Number(row.hours)).toBeCloseTo(2, 1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the outside-work-hours rule', () => {
    it('OT-API-37 a start inside regular work hours is refused with the window in the message', async () => {
      const res = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(weekday(0), '10:00', '12:00', 2),
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain(
        'Overtime hours must be outside of regular work hours',
      );
    });

    it('OT-API-38 a start exactly at the office start is refused and exactly at the shift end is accepted (±1 minute)', async () => {
      const dates = workdaysInOneMonth(0, 2);
      await withSettings(ctx, { office_start_time: '09:00' }, async () => {
        const atStart = await createFor(
          fx.hr.token,
          fx.otStaffId,
          shift(dates[0], '09:00', '11:00', 2),
        );
        expect(atStart.status).toBe(400);
        expect(body(atStart)).toContain('(09:00-17:00)');

        // One minute before the window opens.
        await ctx.prisma.overtimeRequest.deleteMany({
          where: { employeeId: fx.otStaffId },
        });
        const justBefore = await createFor(
          fx.hr.token,
          fx.otStaffId,
          shift(dates[0], '08:59', '10:59', 2),
        );
        expect(justBefore.status).toBe(201);

        // And exactly AT the shift end, which the rule treats as outside.
        const atEnd = await createFor(
          fx.hr.token,
          fx.otStaffId,
          shift(dates[1], '17:00', '19:00', 2),
        );
        expect(atEnd.status).toBe(201);
      });
    });

    it('OT-API-39 doubleOtAllowAnytime waives the rule on a rest day, and withdrawing it restores the rule', async () => {
      const date = saturday(0);
      const allowed = await fx.withPolicyRules(
        fx.policyTightCaps,
        { doubleOtAllowAnytime: true },
        async () =>
          createFor(fx.hr.token, fx.otCappedId, shift(date, '10:00', '12:00', 2)),
      );
      expect(allowed.status).toBe(201);

      await ctx.prisma.overtimeRequest.deleteMany({
        where: { employeeId: fx.otCappedId },
      });
      const refused = await fx.withPolicyRules(
        fx.policyTightCaps,
        { doubleOtAllowAnytime: false },
        async () =>
          createFor(fx.hr.token, fx.otCappedId, shift(date, '10:00', '12:00', 2)),
      );
      expect(refused.status).toBe(400);
      expect(body(refused)).toContain('outside of regular work hours');
    });

    /**
     * L30. The window's START comes from the GLOBAL `office_start_time` setting
     * while its END comes from the POLICY's `shiftEndTime`, so a per-policy
     * shift window is only half honoured: a policy cannot move the hour its own
     * employees may start claiming from.
     */
    it('OT-API-40 the window start is global while its end is per policy', async () => {
      const date = weekday(0);
      const res = await withSetting(
        ctx,
        'office_start_time',
        '07:00',
        async () =>
          fx.withPolicyRules(fx.policyTightCaps, { shiftEndTime: '19:00' }, () =>
            createFor(fx.hr.token, fx.otCappedId, shift(date, '18:00', '20:00', 2)),
          ),
      );
      expect(res.status).toBe(400);
      // Global start, policy end — the two halves of the window come from two
      // different places, and the message says so.
      expect(body(res)).toContain('(07:00-19:00)');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('one request per date', () => {
    it('OT-API-41 a second request on the same date is refused', async () => {
      const date = weekday(0);
      expect(
        (await createFor(fx.hr.token, fx.otStaffId, shift(date, '18:00', '20:00', 2)))
          .status,
      ).toBe(201);
      const dup = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(date, '20:00', '22:00', 2),
      );
      expect(dup.status).toBe(400);
      expect(body(dup)).toContain(
        'An overtime request already exists for this date',
      );
    });

    it('OT-API-42 cancelling or rejecting the first frees the date again', async () => {
      const date = weekday(0);
      const first = await create(
        fx.employee.token,
        shift(date, '18:00', '20:00', 2),
      );
      expect(first.status).toBe(201);
      expect((await cancel(fx.employee.token, first.body.id)).status).toBe(200);

      const second = await create(
        fx.employee.token,
        shift(date, '18:00', '20:00', 2),
      );
      expect(second.status).toBe(201);

      await reject(fx.hr.token, second.body.id, { rejectedReason: 'no' });
      const third = await create(
        fx.employee.token,
        shift(date, '18:00', '20:00', 2),
      );
      expect(third.status).toBe(201);
    });

    /**
     * L27. Like leave's overlap rule, "one per date" is read-then-write in
     * application code with nothing behind it: `OvertimeRequest` carries no
     * `@@unique([employeeId, date])`. Asserted as the absence of a constraint
     * rather than by racing two requests, because a race passes for the wrong
     * reason most of the time.
     */
    it('OT-API-43 nothing in the schema stops two rows on the same date', async () => {
      const date = weekday(0);
      await fx.seedOvertime({ employeeId: fx.otStaffId, date });
      await fx.seedOvertime({ employeeId: fx.otStaffId, date });
      expect(
        await ctx.prisma.overtimeRequest.count({
          where: {
            employeeId: fx.otStaffId,
            date: new Date(`${date}T00:00:00.000Z`),
          },
        }),
      ).toBe(2);

      const viaApi = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(date, '18:00', '20:00', 2),
      );
      expect(viaApi.status).toBe(400);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the tier split, the food allowance and the recompute at approval', () => {
    it('OT-API-44 a window crossing the late threshold splits into buckets that sum to hours', async () => {
      // Late threshold is 22:00 by default, so 21:00 → 23:00 straddles it.
      const res = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(weekday(0), '21:00', '23:00', 2),
      );
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      const sum =
        Number(row.regularHours) +
        Number(row.lateHours) +
        Number(row.doubleHours) +
        Number(row.doubleLateHours);
      expect(sum).toBeCloseTo(Number(row.hours), 2);
      expect(Number(row.regularHours)).toBeGreaterThan(0);
      expect(Number(row.lateHours)).toBeGreaterThan(0);
    });

    it('OT-API-45 a rest-day window fills the DOUBLE buckets and nothing else', async () => {
      const res = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(saturday(0), '18:00', '20:00', 2),
      );
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.dayType).toBe('SUNDAY');
      expect(String(row.otType)).toMatch(/^DOUBLE/);
      expect(Number(row.doubleHours) + Number(row.doubleLateHours)).toBeCloseTo(
        Number(row.hours),
        2,
      );
      expect(Number(row.regularHours)).toBe(0);
    });

    it('OT-API-46 the food allowance appears only once the window passes its threshold', async () => {
      const dates = workdaysInOneMonth(0, 2);
      const before = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(dates[0], '18:00', '20:00', 2),
      );
      expect(Number(before.body.foodAllowance ?? 0)).toBe(0);

      // The default threshold is 22:00; ending at 23:00 crosses it.
      const after = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(dates[1], '21:00', '23:00', 2),
      );
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: after.body.id },
      });
      expect(Number(row.foodAllowance)).toBeGreaterThan(0);
    });

    it('OT-API-47 doubleFoodAllowanceAnyTime pays on a rest day regardless of the hour', async () => {
      const date = saturday(0);
      const paid = await fx.withPolicyRules(
        fx.policyTightCaps,
        { doubleFoodAllowanceAnyTime: true },
        async () =>
          createFor(fx.hr.token, fx.otCappedId, shift(date, '10:00', '12:00', 2)),
      );
      expect(paid.status).toBe(201);
      expect(Number(paid.body.foodAllowance)).toBeGreaterThan(0);

      await ctx.prisma.overtimeRequest.deleteMany({
        where: { employeeId: fx.otCappedId },
      });
      const unpaid = await fx.withPolicyRules(
        fx.policyTightCaps,
        { doubleFoodAllowanceAnyTime: false },
        async () =>
          createFor(fx.hr.token, fx.otCappedId, shift(date, '10:00', '12:00', 2)),
      );
      expect(Number(unpaid.body.foodAllowance ?? 0)).toBe(0);
    });

    it('OT-API-48 the day-end boundary clamps what is payable', async () => {
      const date = weekday(0);
      const res = await createFor(
        fx.hr.token,
        fx.otBoundaryId,
        shift(date, '20:00', '23:00', 3),
      );
      expect(res.status).toBe(201);
      expect(Number(res.body.hours)).toBeLessThan(3);
    });

    it('OT-API-49 approval re-derives the whole breakdown from the policy as it stands THEN', async () => {
      const date = weekday(0);
      const created = await createFor(
        fx.hr.token,
        fx.otBoundaryId,
        shift(date, '20:00', '23:00', 3),
      );
      const atCreate = Number(created.body.hours);
      expect(atCreate).toBeLessThan(3); // clamped at the policy's 22:00

      // Lift the boundary, then approve: the stored hours must follow the LIVE
      // rules, not the ones the request was filed under.
      await fx.withPolicyRules(
        fx.policyBoundary,
        { dayEndBoundary: null },
        async () => {
          const res = await approve(fx.hr.token, created.body.id);
          expect(res.status).toBe(201);
        },
      );
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(row.status).toBe('APPROVED');
      expect(Number(row.hours)).toBeGreaterThan(atCreate);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the decision lifecycle', () => {
    const file = async (employeeId: string, offset = 0) => {
      const res = await createFor(
        fx.hr.token,
        employeeId,
        shift(weekday(offset), '18:00', '20:00', 2),
      );
      expect(res.status).toBe(201);
      return res.body.id as string;
    };

    it('OT-API-50 HR approves and the row carries approver, timestamp and a re-persisted breakdown', async () => {
      const id = await file(fx.otStaffId);
      const res = await approve(fx.hr.token, id);
      expect(res.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('APPROVED');
      expect(row.approverId).toBe(fx.hr.userId);
      expect(row.approvedAt).not.toBeNull();
      expect(Number(row.hours)).toBeCloseTo(2, 2);
    });

    it('OT-API-51 approving a non-pending request is refused', async () => {
      const id = await file(fx.otStaffId);
      await approve(fx.hr.token, id);
      const again = await approve(fx.hr.token, id);
      expect(again.status).toBe(400);
      expect(body(again)).toContain('Can only approve pending requests');
    });

    it('OT-API-52 rejection REQUIRES a reason, and stores the one it is given', async () => {
      const id = await file(fx.otStaffId);
      const noReason = await reject(fx.hr.token, id, {});
      expect(noReason.status).toBe(400);
      expect(body(noReason)).toContain('rejectedReason');

      const ok = await reject(fx.hr.token, id, {
        rejectedReason: 'Not authorised in advance',
      });
      expect(ok.status).toBe(201);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('REJECTED');
      expect(row.rejectedReason).toBe('Not authorised in advance');
    });

    it('OT-API-53 rejecting a non-pending request is refused', async () => {
      const id = await file(fx.otStaffId);
      await approve(fx.hr.token, id);
      const res = await reject(fx.hr.token, id, { rejectedReason: 'too late' });
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Can only reject pending requests');
    });

    it('OT-API-54 a MANAGER decides in their department and is refused outside it — with a different sentence per door', async () => {
      const mine = await file(fx.otStaffId);
      expect((await approve(fx.mgr.token, mine)).status).toBe(201);

      // finStaff shares branchMain, so this refusal is department scope or it is
      // nothing.
      const theirs = await fx.seedOvertime({
        employeeId: fx.finStaffId,
        date: weekday(8),
      });
      const deniedApprove = await approve(fx.mgr.token, theirs);
      expect(deniedApprove.status).toBe(403);
      expect(body(deniedApprove)).toContain(
        'You do not have permission to approve overtime outside your department.',
      );

      const deniedReject = await reject(fx.mgr.token, theirs, {
        rejectedReason: 'no',
      });
      expect(deniedReject.status).toBe(403);
      expect(body(deniedReject)).toContain(
        'You do not have permission to reject overtime outside your department.',
      );
    });

    /**
     * L25. Cancel compares the request's employee against the CALLER's own, so
     * ADMIN and HR are refused despite `@Roles` admitting them — meaning a
     * request HR filed on an employee's behalf cannot be withdrawn by HR.
     */
    it('OT-API-55 only the requester may cancel — ADMIN and HR cannot', async () => {
      const date = weekday(0);
      const own = await create(fx.employee.token, shift(date, '18:00', '20:00', 2));
      expect(own.status).toBe(201);

      for (const actor of [fx.admin, fx.hr]) {
        const res = await cancel(actor.token, own.body.id);
        expect(res.status).toBe(403);
        expect(body(res)).toContain(
          'You do not have permission to cancel this request',
        );
      }
      expect((await cancel(fx.employee.token, own.body.id)).status).toBe(200);
      const row = await ctx.prisma.overtimeRequest.findUniqueOrThrow({
        where: { id: own.body.id },
      });
      expect(row.status).toBe('CANCELLED');
    });

    it('OT-API-56 cancelling a non-pending request is refused', async () => {
      const date = weekday(0);
      const own = await create(fx.employee.token, shift(date, '18:00', '20:00', 2));
      await approve(fx.hr.token, own.body.id);
      const res = await cancel(fx.employee.token, own.body.id);
      expect(res.status).toBe(400);
      expect(body(res)).toContain('Can only cancel pending requests');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('reads, reports and empty states', () => {
    it('OT-API-57 the list filters by status, employee and month, narrows for a MANAGER and paginates', async () => {
      const dates = workdaysInOneMonth(0, 2);
      const mine = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(dates[0], '18:00', '20:00', 2),
      );
      await approve(fx.hr.token, mine.body.id);
      const theirs = await fx.seedOvertime({
        employeeId: fx.finStaffId,
        date: dates[1],
      });

      const byStatus = await ctx
        .http()
        .get('/overtime?status=APPROVED&limit=200')
        .set(bearer(fx.hr.token));
      expect(byStatus.status).toBe(200);
      const approvedIds = byStatus.body.data.map((r: any) => r.id);
      expect(approvedIds).toContain(mine.body.id);
      expect(approvedIds).not.toContain(theirs);

      const byEmployee = await ctx
        .http()
        .get(`/overtime?employeeId=${fx.otStaffId}&limit=200`)
        .set(bearer(fx.hr.token));
      expect(byEmployee.body.data.map((r: any) => r.id)).toEqual([mine.body.id]);

      const [y, m] = dates[0].split('-');
      const byMonth = await ctx
        .http()
        .get(`/overtime?month=${Number(m)}&year=${Number(y)}&limit=200`)
        .set(bearer(fx.hr.token));
      expect(byMonth.body.data.map((r: any) => r.id)).toContain(mine.body.id);

      // The MANAGER heads deptOps; finStaff is in deptFin, same branch.
      const scoped = await ctx
        .http()
        .get('/overtime?limit=200')
        .set(bearer(fx.mgr.token));
      const scopedIds = scoped.body.data.map((r: any) => r.id);
      expect(scopedIds).toContain(mine.body.id);
      expect(scopedIds).not.toContain(theirs);

      const paged = await ctx
        .http()
        .get('/overtime?page=1&limit=1')
        .set(bearer(fx.hr.token));
      expect(paged.body.data).toHaveLength(1);
    });

    it('OT-API-58 the by-employee door checks department scope — the one leave gets wrong — and the hours door returns a bare number', async () => {
      const date = workdaysInOneMonth(0, 1)[0];
      const created = await createFor(
        fx.hr.token,
        fx.otStaffId,
        shift(date, '18:00', '20:00', 2),
      );
      await approve(fx.hr.token, created.body.id);

      const inScope = await ctx
        .http()
        .get(`/overtime/employee/${fx.otStaffId}`)
        .set(bearer(fx.mgr.token));
      expect(inScope.status).toBe(200);

      const outOfScope = await ctx
        .http()
        .get(`/overtime/employee/${fx.finStaffId}`)
        .set(bearer(fx.mgr.token));
      expect(outOfScope.status).toBe(403);
      expect(body(outOfScope)).toContain(
        'You do not have permission to view employees outside your department.',
      );

      // L32: a bare number where every neighbouring door returns {success,data}.
      const [y, m] = date.split('-');
      const hours = await ctx
        .http()
        .get(
          `/overtime/employee/${fx.otStaffId}/hours/${Number(m)}/${Number(y)}`,
        )
        .set(bearer(fx.hr.token));
      expect(hours.status).toBe(200);
      expect(hours.body).not.toHaveProperty('success');
      // A Prisma Decimal serialised straight out of the controller, so the wire
      // value is the STRING "2" rather than the number every sibling door emits.
      expect(Number(hours.body)).toBeCloseTo(2, 2);
    });

    /**
     * L15, FIXED. `getMonthlyReport` called `findAll(month, year)` with no page
     * or limit, so it took the DEFAULT 20 rows and computed `totalRequests`,
     * `totalHours` and `byEmployee` from that page alone. Any month with more
     * than twenty overtime requests reported the wrong money.
     */
    it('OT-API-59 the monthly report covers the whole month, not the first page', async () => {
      const dates = workdaysInOneMonth(0, 1);
      const [y, m] = dates[0].split('-');
      const month = Number(m);
      const year = Number(y);

      // 21 APPROVED rows in one month — one past the old page size — seeded
      // directly so no cap interferes.
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const seeded: string[] = [];
      for (let d = 1; d <= 21 && d <= daysInMonth; d++) {
        const iso = `${y}-${m}-${String(d).padStart(2, '0')}`;
        seeded.push(
          await fx.seedOvertime({
            employeeId: fx.otStaffId,
            date: iso,
            hours: 1,
            status: 'APPROVED',
          }),
        );
      }
      expect(seeded.length).toBe(21);

      const res = await ctx
        .http()
        .get(`/overtime/report/${month}/${year}`)
        .set(bearer(fx.hr.token));
      expect(res.status).toBe(200);
      // The report is `{ month, year, summary, requests }` — not the
      // `{ success, data }` envelope the rest of the module uses.
      const summary = res.body.summary;
      expect(summary.totalRequests).toBe(21);
      expect(summary.approved).toBe(21);
      expect(summary.totalHours).toBe(21);
      expect(Object.keys(summary.byEmployee)).toContain(fx.otStaffId);
      expect(summary.byEmployee[fx.otStaffId].totalHours).toBe(21);
    });

    it('OT-API-60 empty states are envelopes, never NaN and never 404 — and a malformed employeeId is not handled', async () => {
      const pending = await ctx
        .http()
        .get('/overtime/pending')
        .set(bearer(fx.hr.token));
      expect(pending.status).toBe(200);
      expect(Array.isArray(pending.body.data ?? pending.body)).toBe(true);

      const mine = await ctx
        .http()
        .get('/overtime/my-requests')
        .set(bearer(fx.employee.token));
      expect(mine.status).toBe(200);
      expect(mine.body.data ?? mine.body).toEqual([]);

      const quietMonth = await ctx
        .http()
        .get('/overtime/report/1/2019')
        .set(bearer(fx.hr.token));
      const summary = quietMonth.body.summary;
      expect(summary.totalRequests).toBe(0);
      expect(summary.totalHours).toBe(0);
      expect(Number.isNaN(summary.totalHours)).toBe(false);

      // L29, FIXED. `?employeeId=` was unvalidated, so junk reached a
      // `@db.Uuid` column and answered 500 — carrying the Prisma invocation and
      // the absolute source path with it. A `ParseUUIDPipe` now stops it at the
      // door, the same way leave's create DTO does (LVE-API-06).
      const junk = await ctx
        .http()
        .get('/overtime?employeeId=not-a-uuid')
        .set(bearer(fx.hr.token));
      expect(junk.status).toBe(400);
      expect(body(junk)).not.toContain('prisma');
      expect(body(junk)).not.toContain('overtime.service.ts');
    });
  });
});
