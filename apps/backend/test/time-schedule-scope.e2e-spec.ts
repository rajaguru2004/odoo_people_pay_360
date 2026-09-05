import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupScheduleFixtures,
  ScheduleFixtures,
  RESERVED,
  freeDate,
  atUtc,
} from './utils/schedule-fixtures';
import { bearer } from './utils/settings';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { CalendarController } from '../src/calendar/calendar.controller';

/**
 * Time & Schedules — who may reach which endpoint, and whose rows they see.
 *
 * This is the security half of the module and the reason the phase exists. The
 * plan's §3.1 role matrix is the ORACLE: it was written by hand from the
 * requirement, not read off the implementation, and the cells it marked in bold
 * were the ones the code got wrong. Each was written here first as a PIN plus an
 * `it.failing` twin and collapsed once WP-5 landed, which is what makes a case
 * marked `FIXED (Tn)` evidence rather than an assertion of something that was
 * always true.
 *
 * The shape of the wrongness is worth keeping on the record, because four
 * findings shared it. `branch-scope.map.ts` scopes `WorkSchedule` as a
 * `relation` model, so the Prisma `$use` middleware AND-composes a branch
 * predicate into reads — but only for the actions in `BRANCH_READ_ACTIONS`, and
 * `findUnique` is not one of them. Single-row `update` and `delete` are never
 * auto-scoped for relation models either, and `calendar.service.ts` did not
 * import `assertInBranch` at all. So every LIST was correctly scoped and every
 * BY-ID door was wide open — the most dangerous possible combination, because
 * the list view proves the scoping "works" while the ids it hands out are keys
 * to the whole company. The by-id doors now carry the guard explicitly; the
 * lists are left to the middleware, and SCOPE-API-09/10 assert both halves.
 *
 * A refusal here is 404, never 403: a scoped caller must not be able to learn
 * that another branch's schedule exists from the shape of the refusal. That is
 * the rule `assertInBranch` already implements for the rest of the app.
 */
describe('Time & Schedules — scope and authorization (e2e)', () => {
  let ctx: E2EContext;
  let fx: ScheduleFixtures;

  const body = (res: any) => JSON.stringify(res.body);

  /** This spec owns `freeDate(90..149)` — see the allocation in WP-1's header. */
  const DATE_BASE = 90;
  let dateSeq = 0;
  const nextDate = () => freeDate(DATE_BASE + dateSeq++);

  const created: string[] = [];

  /** Create a schedule directly, bypassing HTTP — the arrange step, not the act. */
  const seedSchedule = async (employeeId: string, date: string) => {
    const row = await ctx.prisma.workSchedule.create({
      data: {
        employeeId,
        date: new Date(`${date}T00:00:00.000Z`),
        shiftType: 'FULL_DAY',
        startTime: new Date(atUtc(date, '09:00')),
        endTime: new Date(atUtc(date, '18:00')),
        isWorkDay: true,
      },
    });
    created.push(row.id);
    return row.id;
  };

  const validPayload = (employeeId: string, date: string) => ({
    employeeId,
    date,
    shiftType: 'FULL_DAY',
    startTime: atUtc(date, '09:00'),
    endTime: atUtc(date, '18:00'),
  });

  /**
   * The nine endpoints, as (method, path, sample query/body). Used by the
   * anonymous sweep and the `@Roles` audit so neither can silently miss one that
   * gets added later.
   */
  const ENDPOINTS: Array<{
    label: string;
    method: 'get' | 'post' | 'put' | 'delete';
    path: () => string;
    query?: () => Record<string, unknown>;
    payload?: () => Record<string, unknown>;
  }> = [
    {
      label: 'GET my-calendar',
      method: 'get',
      path: () => '/calendar/my-calendar',
      query: () => ({ startDate: '2026-03-01', endDate: '2026-03-31' }),
    },
    {
      label: 'GET overview',
      method: 'get',
      path: () => '/calendar/overview',
      query: () => ({ startDate: '2026-03-01', endDate: '2026-03-31' }),
    },
    {
      label: 'GET stats',
      method: 'get',
      path: () => '/calendar/stats',
      query: () => ({ month: 3, year: 2026 }),
    },
    {
      label: 'POST schedules',
      method: 'post',
      path: () => '/calendar/schedules',
      payload: () => validPayload(fx.staffAId, nextDate()),
    },
    {
      label: 'GET schedules/:id',
      method: 'get',
      path: () => `/calendar/schedules/${fx.scheduleBId}`,
    },
    {
      label: 'PUT schedules/:id',
      method: 'put',
      path: () => `/calendar/schedules/${fx.scheduleBId}`,
      payload: () => ({ notes: 'x' }),
    },
    {
      label: 'DELETE schedules/:id',
      method: 'delete',
      path: () => `/calendar/schedules/${fx.scheduleBId}`,
    },
    {
      label: 'POST schedules/bulk',
      method: 'post',
      path: () => '/calendar/schedules/bulk',
      payload: () => ({ schedules: [validPayload(fx.staffAId, nextDate())] }),
    },
    {
      label: 'GET conflicts/check',
      method: 'get',
      path: () => '/calendar/schedules/conflicts/check',
      query: () => ({
        employeeId: fx.staffAId,
        startDate: '2026-03-01',
        endDate: '2026-03-31',
      }),
    },
    // Both of these were reachable without a row in this table, which is the
    // failure SCOPE-API-02 exists to catch. `coverage-stats` shipped unlisted
    // and left the property assertion red (10 handlers against 9 rows); the
    // Schedules hub added an eleventh. Registered now, so both also get their
    // 401 case from SCOPE-API-01.
    {
      label: 'GET coverage-stats',
      method: 'get',
      path: () => '/calendar/coverage-stats',
      query: () => ({ startDate: '2026-03-01', endDate: '2026-03-31' }),
    },
    {
      label: 'GET hub-summary',
      method: 'get',
      path: () => '/calendar/hub-summary',
      query: () => ({ period: 'week' }),
    },
  ];

  /** Fire an endpoint as `token` (or anonymously when omitted). */
  const call = (
    ep: (typeof ENDPOINTS)[number],
    token?: string,
  ): Promise<any> => {
    let req = ctx.http()[ep.method](ep.path());
    if (token) req = req.set(bearer(token));
    if (ep.query) req = req.query(ep.query());
    if (ep.payload) req = req.send(ep.payload());
    return req;
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupScheduleFixtures(ctx);
  }, 120000);

  afterEach(async () => {
    if (created.length === 0) return;
    await ctx.prisma.workSchedule.deleteMany({
      where: { id: { in: created.splice(0) } },
    });
  });

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Authentication and the guard configuration itself
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCOPE-API-01..03 — authentication', () => {
    it.each(ENDPOINTS.map((e) => [e.label, e] as const))(
      'SCOPE-API-01 %s is 401 without a token',
      async (_label, ep) => {
        const res = await call(ep);
        expect(res.status).toBe(401);
      },
    );

    it('SCOPE-API-02 D5: every handler carries its own @Roles', async () => {
      // `RolesGuard` FAIL-OPENS: `if (!requiredRoles) return true`
      // (`roles.guard.ts:16-18`). A handler added without the decorator is
      // therefore reachable by every authenticated user, including EMPLOYEE,
      // and nothing about the code looks wrong at the call site. This asserts
      // the property rather than any one endpoint, so a tenth endpoint added
      // without `@Roles` fails here on the day it is written.
      const proto = CalendarController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      const handlers = Object.getOwnPropertyNames(proto).filter(
        (name) => name !== 'constructor' && typeof proto[name] === 'function',
      );

      expect(handlers).toHaveLength(ENDPOINTS.length);
      for (const name of handlers) {
        const roles = Reflect.getMetadata(ROLES_KEY, proto[name]) as
          | string[]
          | undefined;
        expect(roles && roles.length > 0).toBe(true);
      }
    });

    it('SCOPE-API-03 an expired or forged token is refused', async () => {
      const res = await ctx
        .http()
        .get('/calendar/overview')
        .query({ startDate: '2026-03-01', endDate: '2026-03-31' })
        .set(bearer('not.a.jwt'));

      expect(res.status).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Role gates (the cells §3.1 gets RIGHT — the regression net)
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCOPE-API-04..08 — role gates', () => {
    const WRITE_ENDPOINTS = ENDPOINTS.filter((e) =>
      [
        'POST schedules',
        'PUT schedules/:id',
        'DELETE schedules/:id',
        'POST schedules/bulk',
      ].includes(e.label),
    );

    it.each(WRITE_ENDPOINTS.map((e) => [e.label, e] as const))(
      'SCOPE-API-04 %s is 403 for EMPLOYEE',
      async (_label, ep) => {
        const res = await call(ep, fx.employee.token);
        expect(res.status).toBe(403);
      },
    );

    it.each(WRITE_ENDPOINTS.map((e) => [e.label, e] as const))(
      'SCOPE-API-05 %s is 403 for MANAGER',
      async (_label, ep) => {
        // A manager runs a department, not the roster. Scheduling is an HR act.
        const res = await call(ep, fx.manager.token);
        expect(res.status).toBe(403);
      },
    );

    it('SCOPE-API-06 conflicts/check is HR-only', async () => {
      const ep = ENDPOINTS.find((e) => e.label === 'GET conflicts/check')!;

      expect((await call(ep, fx.employee.token)).status).toBe(403);
      expect((await call(ep, fx.manager.token)).status).toBe(403);
      expect((await call(ep, fx.hr.token)).status).toBe(200);
      expect((await call(ep, fx.admin.token)).status).toBe(200);
    });

    it('SCOPE-API-07 overview is refused for EMPLOYEE and allowed for the other three', async () => {
      const ep = ENDPOINTS.find((e) => e.label === 'GET overview')!;

      expect((await call(ep, fx.employee.token)).status).toBe(403);
      expect((await call(ep, fx.manager.token)).status).toBe(200);
      expect((await call(ep, fx.hr.token)).status).toBe(200);
      expect((await call(ep, fx.admin.token)).status).toBe(200);
    });

    it('SCOPE-API-08 my-calendar and stats are open to every employee-linked role', async () => {
      // Everyone owns a calendar. This is the cell that makes
      // `/dashboard/my-calendar` correctly `guarded: false` in `routes.ts`.
      //
      // `fx.admin` is excluded deliberately and is NOT an oversight — see
      // SCOPE-API-08b, which is the finding this case was split to expose.
      for (const label of ['GET my-calendar', 'GET stats']) {
        const ep = ENDPOINTS.find((e) => e.label === label)!;
        for (const actor of [fx.hr, fx.manager, fx.employee]) {
          const res = await call(ep, actor.token);
          expect([label, res.status]).toEqual([label, 200]);
        }
      }
    });

    it('SCOPE-API-08b FIXED (T25): a user with no employee record gets an empty calendar, not a 500', async () => {
      // `User.employeeId` is OPTIONAL in the schema, and an ADMIN account that
      // administers the system without being a member of staff is the ordinary
      // reason for it — `org-fixtures.ts` builds its admin the same way, so the
      // configuration is already in the test suite as well as reachable in
      // production.
      //
      // Both routes passed `user.employeeId` straight into a Prisma filter.
      // Undefined in a required filter position is rejected by the client, so
      // the caller got a 500 on two routes their own `@Roles` list grants them.
      //
      // "You have no staff record, so you have no roster" is the honest answer
      // and keeps the route usable; a 400 would also have been defensible, a 500
      // was not. Not in the plan's T1-T24 register — found by walking the role
      // matrix with an actor the plan's fixture list did not anticipate.
      const calendar = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({ startDate: '2026-01-01', endDate: '2026-12-31' })
        .set(bearer(fx.admin.token));
      const stats = await ctx
        .http()
        .get('/calendar/stats')
        .query({ month: 6, year: 2026 })
        .set(bearer(fx.admin.token));

      expect(calendar.status).toBe(200);
      expect(calendar.body.data).toEqual([]);
      expect(stats.status).toBe(200);
      expect(stats.body.data).toEqual({
        workDays: 0,
        leaveDays: 0,
        overtimeHours: 0,
        holidays: 0,
      });
    });

    it('SCOPE-API-08c FIXED (T15): no refusal body carries a filesystem path or source excerpt', async () => {
      // The disclosure SCH-API-33 pins on a malformed id, reached here by a
      // completely different route with a completely different trigger. Two
      // independent triggers made it a property of `AllExceptionsFilter`
      // forwarding Prisma's rendered error text, NOT of the missing
      // `ParseUUIDPipe` — so a fix that only added the pipe would have closed
      // one door and left the disclosure live on every other route.
      //
      // Asserted against a route that can still 500 for other reasons, so the
      // property is "no internal error ever leaks", not "this one input is
      // handled".
      const malformed = await ctx
        .http()
        .get('/calendar/schedules/not-a-uuid')
        .set(bearer(fx.admin.token));
      const badRange = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({ startDate: 'yesterday', endDate: 'tomorrow' })
        .set(bearer(fx.employee.token));

      for (const res of [malformed, badRange]) {
        expect(body(res)).not.toContain('/home/');
        expect(body(res)).not.toContain('calendar.service.ts');
        expect(body(res)).not.toContain('prisma.');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Branch scoping — lists are scoped, by-id doors are not (T1, T2)
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCOPE-API-09..16 — branch scoping', () => {
    it('SCOPE-API-09 a scoped HR reads only their own branch from overview', async () => {
      // The half that WORKS. `getOverviewCalendar` uses `findMany`, which IS in
      // `BRANCH_READ_ACTIONS`, so the Prisma middleware scopes it. Asserted
      // first because it is what makes the by-id findings below surprising: the
      // module looks scoped from every list.
      const dateA = nextDate();
      await seedSchedule(fx.staffAId, dateA);

      const res = await ctx
        .http()
        .get('/calendar/overview')
        .query({ startDate: '2026-01-01', endDate: '2026-12-31' })
        .set(bearer(fx.scopedHr.token));

      expect(res.status).toBe(200);
      const employeeIds = res.body.data.schedules.map((s: any) => s.employeeId);
      expect(employeeIds).toContain(fx.staffAId);
      // `staffB` lives in branch B and owns `scheduleBId`, which exists for the
      // whole run — its absence here is the assertion.
      expect(employeeIds).not.toContain(fx.staffBId);
    });

    it('SCOPE-API-10 a global HR reads both branches from overview', async () => {
      // The complement: without this, SCOPE-API-09 would pass against an
      // overview that returned nothing at all.
      const res = await ctx
        .http()
        .get('/calendar/overview')
        .query({ startDate: '2026-01-01', endDate: '2026-12-31' })
        .set(bearer(fx.hr.token));

      expect(res.status).toBe(200);
      const employeeIds = res.body.data.schedules.map((s: any) => s.employeeId);
      expect(employeeIds).toContain(fx.staffBId);
    });

    it('SCOPE-API-11 FIXED (T1): a scoped HR cannot READ another branch schedule by id', async () => {
      // 404 and not 403: the refusal must not confirm the row exists.
      const res = await ctx
        .http()
        .get(`/calendar/schedules/${fx.scheduleBId}`)
        .set(bearer(fx.scopedHr.token));

      expect(res.status).toBe(404);
      expect(body(res)).not.toContain(fx.staffBId);
    });

    it('SCOPE-API-12 FIXED (T1): a scoped HR cannot EDIT another branch schedule by id', async () => {
      const res = await ctx
        .http()
        .put(`/calendar/schedules/${fx.scheduleBId}`)
        .set(bearer(fx.scopedHr.token))
        .send({ notes: 'edited across a branch boundary' });

      expect(res.status).toBe(404);
      const row = await ctx.prisma.workSchedule.findUnique({
        where: { id: fx.scheduleBId },
      });
      expect(row?.notes).not.toBe('edited across a branch boundary');
    });

    it('SCOPE-API-13 FIXED (T1): a scoped HR cannot DELETE another branch schedule, and the row survives', async () => {
      // The most severe of the three doors, and the one that cannot be undone by
      // the person it happened to. Asserting the row still exists matters as
      // much as the status: a fix that answered 404 AFTER deleting would pass a
      // status-only check.
      const disposable = await seedSchedule(fx.staffBId, nextDate());

      const res = await ctx
        .http()
        .delete(`/calendar/schedules/${disposable}`)
        .set(bearer(fx.scopedHr.token));

      expect(res.status).toBe(404);
      expect(
        await ctx.prisma.workSchedule.findUnique({ where: { id: disposable } }),
      ).not.toBeNull();
    });

    it('SCOPE-API-14 FIXED (T2): a scoped HR cannot CREATE a schedule for another branch', async () => {
      // `createSchedule` resolved the employee with `findUnique` — which the
      // branch middleware does not scope — and never consulted the boundary on
      // the way in either. 404 to match the read doors: the refusal must not
      // confirm the employee exists.
      const res = await ctx
        .http()
        .post('/calendar/schedules')
        .set(bearer(fx.scopedHr.token))
        .send(validPayload(fx.staffBId, nextDate()));
      if (res.body?.data?.id) created.push(res.body.data.id);

      expect(res.status).toBe(404);
    });

    it('SCOPE-API-15 FIXED (T2): both create doors refuse, and the reason names the real cause', async () => {
      // The finding was never the two statuses on their own — it was that they
      // DISAGREED. `bulkCreate` resolves employees with `findMany`, which is
      // auto-scoped, so an out-of-branch employee was simply absent from its map
      // and the row failed as "Employee not found". The single door said 201.
      // One request succeeded, the identical request through the batch endpoint
      // reported the employee did not exist, and neither answer was the true
      // one, which is "not yours".
      const single = await ctx
        .http()
        .post('/calendar/schedules')
        .set(bearer(fx.scopedHr.token))
        .send(validPayload(fx.staffBId, nextDate()));
      if (single.body?.data?.id) created.push(single.body.data.id);

      const bulk = await ctx
        .http()
        .post('/calendar/schedules/bulk')
        .set(bearer(fx.scopedHr.token))
        .send({ schedules: [validPayload(fx.staffBId, nextDate())] });

      expect(single.status).toBe(404);
      expect(bulk.body.data.failed).toBe(1);
      // "Employee not found" is a lie to a caller who can see that employee in
      // their own directory; the row is refused because it is out of scope.
      expect(bulk.body.data.errors[0].error).toBe(
        'Employee is outside your branch access',
      );
    });

    it('SCOPE-API-15c the honest bulk reason is reserved for employees that really do exist', async () => {
      // The distinction the new message depends on: an id that exists in another
      // branch and an id that exists nowhere must not read the same, or the
      // message trades one inaccuracy for another.
      const bulk = await ctx
        .http()
        .post('/calendar/schedules/bulk')
        .set(bearer(fx.scopedHr.token))
        .send({
          schedules: [
            validPayload('00000000-0000-4000-8000-000000000000', nextDate()),
          ],
        });

      expect(bulk.body.data.errors[0].error).toBe('Employee not found');
    });

    it('SCOPE-API-16 D2: a schedule follows its employee to a new branch', async () => {
      // Decision, not defect. `WorkSchedule` has no `branchId` of its own — the
      // row is scoped through `employee.branchId` — so moving an employee
      // retroactively re-scopes their whole schedule history. Worth asserting
      // because it is surprising and because a future `branchId` column on the
      // model would silently change it.
      const date = nextDate();
      const id = await seedSchedule(fx.staffOtherDeptId, date);

      const visibleBefore = await ctx
        .http()
        .get('/calendar/overview')
        .query({ startDate: date, endDate: date })
        .set(bearer(fx.scopedHr.token));
      expect(
        visibleBefore.body.data.schedules.some((s: any) => s.id === id),
      ).toBe(true);

      await ctx.prisma.employee.update({
        where: { id: fx.staffOtherDeptId },
        data: { branchId: fx.branchB },
      });
      try {
        const visibleAfter = await ctx
          .http()
          .get('/calendar/overview')
          .query({ startDate: date, endDate: date })
          .set(bearer(fx.scopedHr.token));

        // The row did not move and was not rewritten; the branch-A HR simply
        // stops being able to see it.
        expect(
          visibleAfter.body.data.schedules.some((s: any) => s.id === id),
        ).toBe(false);
        expect(
          await ctx.prisma.workSchedule.findUnique({ where: { id } }),
        ).not.toBeNull();
      } finally {
        await ctx.prisma.employee.update({
          where: { id: fx.staffOtherDeptId },
          data: { branchId: fx.branchA },
        });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Object-level authorization — IDOR and the manager's reach (T3, T4)
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCOPE-API-17..24 — object-level authorization', () => {
    it('SCOPE-API-17 an employee reads their OWN schedule by id', async () => {
      // The cell that must keep working after T3 is fixed. `fx.employee` is the
      // account attached to `staffA`.
      const id = await seedSchedule(fx.staffAId, nextDate());

      const res = await ctx
        .http()
        .get(`/calendar/schedules/${id}`)
        .set(bearer(fx.employee.token));

      expect(res.status).toBe(200);
      expect(res.body.data.employee.id).toBe(fx.staffAId);
    });

    it('SCOPE-API-18 FIXED (T3): an employee reading a COLLEAGUE schedule by id is refused', async () => {
      // `@Roles` admits EMPLOYEE and the service did no ownership check, so any
      // employee who could guess or capture an id read the row — and the payload
      // carries the colleague's email address and department, not just times.
      //
      // 403 rather than 404 here, mirroring `assertReadAccess` in the visa
      // module: within one branch the row's existence is not the secret, its
      // contents are, and an employee who followed a stale link deserves an
      // answer they can act on. The cross-branch case (SCOPE-API-11) stays 404.
      const id = await seedSchedule(fx.staffOtherDeptId, nextDate());

      const res = await ctx
        .http()
        .get(`/calendar/schedules/${id}`)
        .set(bearer(fx.employee.token));

      expect(res.status).toBe(403);
      expect(body(res)).not.toContain('@test.local');
    });

    it('SCOPE-API-19 an employee cannot read another employee calendar via the override', async () => {
      // The `employeeId` query parameter is honoured only for the three
      // privileged roles (`calendar.controller.ts:65`); for EMPLOYEE it is
      // ignored and the caller gets their own calendar. This one the code gets
      // right, and it is the reason T3 is a by-id problem rather than a
      // wholesale one.
      const otherDate = nextDate();
      await seedSchedule(fx.staffOtherDeptId, otherDate);

      const res = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({
          startDate: otherDate,
          endDate: otherDate,
          employeeId: fx.staffOtherDeptId,
        })
        .set(bearer(fx.employee.token));

      expect(res.status).toBe(200);
      // Their own calendar is empty on that date; the colleague's is not.
      expect(res.body.data).toEqual([]);
    });

    it('SCOPE-API-20 a manager reads an in-department employee calendar', async () => {
      // `manager` heads `deptA`, which is where `staffA` sits. The cell that
      // must survive the T4 fix.
      const date = nextDate();
      await seedSchedule(fx.staffAId, date);

      const res = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({ startDate: date, endDate: date, employeeId: fx.staffAId })
        .set(bearer(fx.manager.token));

      expect(res.status).toBe(200);
      expect(res.body.data.some((e: any) => e.type === 'work')).toBe(true);
    });

    it('SCOPE-API-21 FIXED (T4): a manager reading an OUT-of-department calendar is 404', async () => {
      // `staffOtherDept` is headed by `otherManager`. There was no
      // `managedDepartmentIds` check on this route at all, so department
      // headship conferred nothing and any manager could read any calendar.
      //
      // 404 rather than 403 so a manager cannot enumerate the company by
      // probing department membership.
      const date = nextDate();
      await seedSchedule(fx.staffOtherDeptId, date);

      const res = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({
          startDate: date,
          endDate: date,
          employeeId: fx.staffOtherDeptId,
        })
        .set(bearer(fx.manager.token));

      expect(res.status).toBe(404);
    });

    it('SCOPE-API-22 FIXED (T4): leave and overtime reasons are no longer reachable cross-department', async () => {
      // Why T4 was worth more than a tidy-up. The merged calendar payload copies
      // `leave.reason` and `overtime.reason` into `description`
      // (`calendar.service.ts:87,111`). A leave reason is frequently medical or
      // personal, and this route used to hand it to any manager in the company.
      //
      // The assertion is the refusal AND the absence of the text, because a fix
      // that returned 200-with-nothing would satisfy a status check while still
      // being one serialisation change away from leaking again.
      const res = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({
          startDate: RESERVED.leaveStart,
          endDate: RESERVED.leaveEnd,
          employeeId: fx.staffOnLeaveId,
        })
        .set(bearer(fx.otherManager.token));

      expect(res.status).toBe(404);
      expect(body(res)).not.toContain('schedule fixture approved leave');
    });

    it('SCOPE-API-23 FIXED (T4): an out-of-branch calendar request is refused, not silently emptied', async () => {
      // Before the fix this answered 200 with an empty event list, because the
      // `findMany` calls underneath ARE auto-scoped. The refusal was therefore
      // silent: on screen it read as "this person has nothing scheduled" rather
      // than "you may not look", which is the more dangerous of the two because
      // nobody files a bug about it.
      const res = await ctx
        .http()
        .get('/calendar/my-calendar')
        .query({
          startDate: RESERVED.branchBShift,
          endDate: RESERVED.branchBShift,
          employeeId: fx.staffBId,
        })
        .set(bearer(fx.scopedHr.token));

      expect(res.status).toBe(404);
    });

    it('SCOPE-API-24 stats reports the caller, and refuses to be asked about anyone else', async () => {
      // `getStats` passed `user.employeeId` and silently IGNORED any
      // `employeeId` in the query, which is safe but mute: a caller could send
      // one, get a 200, and reasonably believe they were reading that person's
      // figures when they were reading their own.
      //
      // With a DTO on the query, `forbidNonWhitelisted` turns that into an
      // explicit refusal. That is the stronger property — the parameter is not
      // merely ignored, it is not accepted — and it means a future "let HR view
      // someone else's stats" change has to face the scope question deliberately
      // rather than by re-using a parameter the endpoint already tolerated.
      const date = nextDate();
      await seedSchedule(fx.staffOtherDeptId, date);
      const [year, month] = date.split('-').map(Number);

      const probing = await ctx
        .http()
        .get('/calendar/stats')
        .query({ month, year, employeeId: fx.staffOtherDeptId })
        .set(bearer(fx.employee.token));
      const own = await ctx
        .http()
        .get('/calendar/stats')
        .query({ month, year })
        .set(bearer(fx.employee.token));

      expect(probing.status).toBe(400);
      // And the caller's own figures are unaffected: `fx.employee` is `staffA`,
      // who has nothing that month.
      expect(own.status).toBe(200);
      expect(own.body.data.workDays).toBe(0);
      expect(body(own)).not.toContain(fx.staffOtherDeptId);
    });
  });
});
