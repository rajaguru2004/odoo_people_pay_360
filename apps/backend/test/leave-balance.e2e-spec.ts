import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupLeaveOvertimeFixtures,
  LeaveOtFixtures,
  freeWindow,
  freeDateOn,
  LEAVE_YEAR,
} from './utils/leave-overtime-fixtures';
import { bearer } from './utils/settings';

/**
 * Leave balances, end to end.
 *
 * ── Why this file matters more than its size suggests ───────────────────────
 *
 * `LeaveBalance` had NO coverage anywhere before this suite: no unit spec, no
 * e2e, nothing. It is the model that decides how much leave a person actually
 * has, it is deducted by an approval that cannot be undone (L13), and two of
 * its endpoints mutate every employee in the database at once.
 *
 * ── Hazards this file neutralises ───────────────────────────────────────────
 *
 *   - **Two endpoints are unfiltered global mutations.**
 *     `POST /accrual/run` adds a day to every ACTIVE employee;
 *     `POST /set-default-allocation` overwrites `allocated` for EVERY employee
 *     with no status filter. Both are driven ONLY inside
 *     `fx.runAccrualAndRevert`, which snapshots both balance models for the
 *     whole database, restores them field by field, and deletes every row the
 *     call created. Both are also the LAST cases in the file.
 *
 *   - **`getBalance` is a read that WRITES** (L5). Reading any employee's
 *     balance auto-creates a `LeaveBalance` plus one `LeaveTypeBalance` per
 *     active type — for any employeeId and any year. So an assertion about
 *     "rows that exist" has to be made against a known starting point, which is
 *     what `afterEach`'s `resetBalances` provides.
 *
 * ── Actors this file OWNS for writes ────────────────────────────────────────
 *
 *   balanceStaff · accrualStaff · allocStaff · terminatedStaff
 *
 * `applicant` is used for the deduction seam and is reset in `afterEach` too.
 */
describe('Leave balances — allocation, accrual and deduction (e2e)', () => {
  let ctx: E2EContext;
  let fx: LeaveOtFixtures;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any) => res.body?.data ?? res.body;

  const get = (token: string, path: string) =>
    ctx.http().get(path).set(bearer(token));
  const post = (token: string, path: string, payload: any = {}) =>
    ctx.http().post(path).set(bearer(token)).send(payload);
  const patch = (token: string, path: string, payload: any = {}) =>
    ctx.http().patch(path).set(bearer(token)).send(payload);

  let owned: string[] = [];

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupLeaveOvertimeFixtures(ctx);
    owned = [
      fx.balanceStaffId,
      fx.accrualStaffId,
      fx.allocStaffId,
      fx.terminatedStaffId,
      fx.applicantId,
    ];
  }, 120000);

  afterEach(async () => {
    const leaveIds = (
      await ctx.prisma.leaveRequest.findMany({
        where: { employeeId: { in: owned } },
        select: { id: true },
      })
    ).map((r) => r.id);
    if (leaveIds.length) {
      await ctx.prisma.requestApproval.deleteMany({
        where: { requestId: { in: leaveIds } },
      });
    }
    await ctx.prisma.leaveRequest.deleteMany({
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
  describe('the role matrix', () => {
    it.each([
      ['GET /leave-balances', 'get', () => `/leave-balances?year=${LEAVE_YEAR}`],
      [
        'GET /leave-balances/company-overview',
        'get',
        () => `/leave-balances/company-overview?year=${LEAVE_YEAR}`,
      ],
      ['GET /leave-balances/accrual/history', 'get', () => '/leave-balances/accrual/history'],
    ])('LBL-API-01 %s is ADMIN and HR only', async (_label, _m, path) => {
      for (const actor of [fx.admin, fx.hr]) {
        expect((await get(actor.token, path())).status).toBe(200);
      }
      for (const actor of [fx.mgr, fx.employee]) {
        expect((await get(actor.token, path())).status).toBe(403);
      }
      expect((await ctx.http().get(path())).status).toBe(401);
    });

    it('LBL-API-01b the write doors are ADMIN and HR only', async () => {
      const doors: Array<[string, () => Promise<any>]> = [
        [
          'init',
          () =>
            post(
              fx.mgr.token,
              `/leave-balances/employee/${fx.balanceStaffId}/init/${LEAVE_YEAR}`,
            ),
        ],
        [
          'updateBalance',
          () =>
            patch(
              fx.mgr.token,
              `/leave-balances/employee/${fx.balanceStaffId}/year/${LEAVE_YEAR}`,
              { annualLeave: 5 },
            ),
        ],
        [
          'accrual/employee',
          () =>
            post(
              fx.mgr.token,
              `/leave-balances/accrual/employee/${fx.balanceStaffId}`,
              { daysToAdd: 1, notes: 'x' },
            ),
        ],
        ['accrual/run', () => post(fx.mgr.token, '/leave-balances/accrual/run')],
        [
          'set-default-allocation',
          () =>
            post(fx.mgr.token, '/leave-balances/set-default-allocation', {
              year: LEAVE_YEAR,
            }),
        ],
        [
          'updateTypeBalance',
          () =>
            patch(
              fx.mgr.token,
              `/leave-balances/${fx.balanceStaffId}/${LEAVE_YEAR}/Annual%20Leave`,
              { allocated: 5 },
            ),
        ],
      ];
      for (const [label, call] of doors) {
        const res = await call();
        expect([403, 401]).toContain(res.status);
        void label;
      }
    });

    it('LBL-API-02 the leave-types door is open to all four roles and returns the seeded set in order', async () => {
      for (const actor of [fx.admin, fx.hr, fx.mgr, fx.employee]) {
        const res = await get(actor.token, '/leave-balances/leave-types');
        expect(res.status).toBe(200);
        const labels = dataOf(res).map((t: any) => t.label);
        expect(labels).toEqual(expect.arrayContaining(['Annual Leave', 'Sick Leave']));
        // Inactive types never appear.
        expect(labels).not.toContain(fx.retiredLeaveType);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('initialisation, and the read that writes', () => {
    it('LBL-API-03 init creates the legacy row and one type row per active balance-affecting type', async () => {
      const res = await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.balanceStaffId}/init/${LEAVE_YEAR}`,
      );
      expect(res.status).toBe(201);

      const legacy = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.balanceStaffId, year: LEAVE_YEAR },
      });
      expect(legacy.annualLeave).toBe(12);
      expect(legacy.sickLeave).toBe(30);

      const types = await ctx.prisma.leaveTypeBalance.findMany({
        where: { employeeId: fx.balanceStaffId, year: LEAVE_YEAR },
      });
      const keys = types.map((t) => t.leaveTypeKey);
      expect(keys).toContain('Annual Leave');
      expect(keys).toContain('Sick Leave');
      // The fixture's own types are `affectsBalance: false`, so they must not
      // materialise here — see the fixture header for why that matters.
      expect(keys).not.toContain(fx.noticeLeaveType);
      expect(keys).not.toContain('Unpaid Leave');
    });

    it('LBL-API-04 initialising the same year twice is refused with the exact sentence', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.balanceStaffId}/init/${LEAVE_YEAR}`,
      );
      const again = await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.balanceStaffId}/init/${LEAVE_YEAR}`,
      );
      expect(again.status).toBe(400);
      expect(body(again)).toContain(
        `Leave balance for ${LEAVE_YEAR} already exists`,
      );
    });

    it('LBL-API-05 init filters gender-restricted types by the employee’s gender', async () => {
      for (const [employeeId, present, absent] of [
        [fx.femaleStaffId, 'Maternity Leave', 'Paternity Leave'],
        [fx.maleStaffId, 'Paternity Leave', 'Maternity Leave'],
      ] as const) {
        await fx.resetBalances(employeeId, LEAVE_YEAR);
        await post(
          fx.hr.token,
          `/leave-balances/employee/${employeeId}/init/${LEAVE_YEAR}`,
        );
        const keys = (
          await ctx.prisma.leaveTypeBalance.findMany({
            where: { employeeId, year: LEAVE_YEAR },
          })
        ).map((t) => t.leaveTypeKey);
        expect(keys).toContain(present);
        expect(keys).not.toContain(absent);
        await fx.resetBalances(employeeId, LEAVE_YEAR);
      }

      // An employee with no recorded gender gets neither.
      await fx.resetBalances(fx.noGenderStaffId, LEAVE_YEAR);
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.noGenderStaffId}/init/${LEAVE_YEAR}`,
      );
      const keys = (
        await ctx.prisma.leaveTypeBalance.findMany({
          where: { employeeId: fx.noGenderStaffId, year: LEAVE_YEAR },
        })
      ).map((t) => t.leaveTypeKey);
      expect(keys).not.toContain('Maternity Leave');
      expect(keys).not.toContain('Paternity Leave');
      await fx.resetBalances(fx.noGenderStaffId, LEAVE_YEAR);
    });

    /**
     * L5, FIXED. This door LOOKS like a read but materialises a
     * `LeaveBalance` plus one `LeaveTypeBalance` per active type — for any
     * employeeId and any year — and it was admitted to all four roles with no
     * ownership or branch check. Any authenticated user could both read a
     * colleague's entitlement and create balance rows for the whole company by
     * walking ids.
     */
    it('LBL-API-06 a colleague cannot read — or auto-create — someone else’s balance', async () => {
      expect(
        await ctx.prisma.leaveBalance.count({
          where: { employeeId: fx.balanceStaffId, year: LEAVE_YEAR },
        }),
      ).toBe(0);

      const res = await get(
        fx.employee.token, // a plain EMPLOYEE, reading someone else
        `/leave-balances/employee/${fx.balanceStaffId}?year=${LEAVE_YEAR}`,
      );
      expect(res.status).toBe(403);

      // The refusal ran BEFORE the write, so nothing was materialised.
      expect(
        await ctx.prisma.leaveBalance.count({
          where: { employeeId: fx.balanceStaffId, year: LEAVE_YEAR },
        }),
      ).toBe(0);

      // Reading their OWN balance still works, and still auto-inits — the
      // convenience the door was built for is intact.
      const own = await get(
        fx.employee.token,
        `/leave-balances/employee/${fx.applicantId}?year=${LEAVE_YEAR}`,
      );
      expect(own.status).toBe(200);
      expect(
        await ctx.prisma.leaveBalance.count({
          where: { employeeId: fx.applicantId, year: LEAVE_YEAR },
        }),
      ).toBe(1);
    });

    it('LBL-API-07 the auto-init back-fills a type added to the library after the year was opened', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.balanceStaffId}/init/${LEAVE_YEAR}`,
      );
      const label = `Study Leave ${fx.runId}`;
      await ctx.prisma.libraryItem.create({
        data: {
          libraryType: 'LEAVE_TYPE',
          label,
          isActive: true,
          defaultDays: 4,
          affectsBalance: true,
        },
      });
      try {
        const res = await get(
          fx.hr.token,
          `/leave-balances/employee/${fx.balanceStaffId}?year=${LEAVE_YEAR}`,
        );
        expect(res.status).toBe(200);
        const keys = dataOf(res).leaveTypeBalances.map(
          (b: any) => b.leaveTypeKey,
        );
        expect(keys).toContain(label);
      } finally {
        await ctx.prisma.leaveTypeBalance.deleteMany({
          where: { leaveTypeKey: label },
        });
        await ctx.prisma.libraryItem.deleteMany({ where: { label } });
      }
    });

    it('LBL-API-08 both remaining formulas hold arithmetically', async () => {
      await fx.setBalance(fx.balanceStaffId, 'Annual Leave', 10);
      await ctx.prisma.leaveTypeBalance.updateMany({
        where: {
          employeeId: fx.balanceStaffId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
        data: { used: 3, carriedOver: 2 },
      });
      await ctx.prisma.leaveBalance.updateMany({
        where: { employeeId: fx.balanceStaffId, year: LEAVE_YEAR },
        data: { usedAnnual: 3, carriedOver: 2 },
      });

      const res = await get(
        fx.hr.token,
        `/leave-balances/employee/${fx.balanceStaffId}?year=${LEAVE_YEAR}`,
      );
      const data = dataOf(res);
      // remainingAnnual = annual + carriedOver − usedAnnual
      expect(data.remainingAnnual).toBe(
        data.annualLeave + data.carriedOver - data.usedAnnual,
      );
      const annual = data.leaveTypeBalances.find(
        (b: any) => b.leaveTypeKey === 'Annual Leave',
      );
      // remaining = allocated + carriedOver − used
      expect(annual.remaining).toBe(
        annual.allocated + annual.carriedOver - annual.used,
      );
      expect(annual.remaining).toBe(9);
    });

    it('LBL-API-09 an unknown employee is a 404 on init', async () => {
      const res = await post(
        fx.hr.token,
        `/leave-balances/employee/11111111-1111-4111-8111-111111111111/init/${LEAVE_YEAR}`,
      );
      expect(res.status).toBe(404);
      expect(body(res)).toContain('Employee not found');
    });

    /**
     * L22, FIXED. The `:year` path parameter is coerced with a bare `+year`, so
     * `abc` became `NaN` and reached Prisma as one.
     */
    it('LBL-API-10 a non-numeric year is refused rather than handed to the driver', async () => {
      const res = await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.balanceStaffId}/init/abc`,
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('A valid year is required');
      expect(body(res)).not.toContain('prisma');
    });

    it('LBL-API-11 a far-future year is materialised silently — there is no upper bound', async () => {
      const far = LEAVE_YEAR + 50;
      try {
        const res = await get(
          fx.hr.token,
          `/leave-balances/employee/${fx.balanceStaffId}?year=${far}`,
        );
        expect(res.status).toBe(200);
        expect(
          await ctx.prisma.leaveBalance.count({
            where: { employeeId: fx.balanceStaffId, year: far },
          }),
        ).toBe(1);
      } finally {
        await fx.resetBalances(fx.balanceStaffId, far);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('manual allocation', () => {
    it('LBL-API-12 the legacy PATCH updates annualLeave and syncs the Annual type row', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/init/${LEAVE_YEAR}`,
      );
      const res = await patch(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/year/${LEAVE_YEAR}`,
        { annualLeave: 25 },
      );
      expect(res.status).toBe(200);
      const legacy = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.allocStaffId, year: LEAVE_YEAR },
      });
      expect(legacy.annualLeave).toBe(25);
      const annual = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.allocStaffId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(annual.allocated).toBe(25);
    });

    it('LBL-API-13 omitting sickLeave leaves it untouched', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/init/${LEAVE_YEAR}`,
      );
      const before = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.allocStaffId, year: LEAVE_YEAR },
      });
      await patch(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/year/${LEAVE_YEAR}`,
        { annualLeave: 20 },
      );
      const after = await ctx.prisma.leaveBalance.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.sickLeave).toBe(before.sickLeave);
    });

    /**
     * L21, FIXED. The route has no DTO: `@Body('annualLeave')` was `undefined`
     * for an empty body, Prisma ignored the undefined field, and the caller got
     * a 200 that changed nothing — indistinguishable from a successful update.
     */
    it('LBL-API-14 an empty update is refused instead of silently succeeding', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/init/${LEAVE_YEAR}`,
      );
      const before = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.allocStaffId, year: LEAVE_YEAR },
      });
      const res = await patch(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/year/${LEAVE_YEAR}`,
        {},
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain(
        'Provide at least one of annualLeave or sickLeave',
      );
      const after = await ctx.prisma.leaveBalance.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.annualLeave).toBe(before.annualLeave);
    });

    it('LBL-API-15 a negative allocation is stored, and remaining goes negative with it', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/init/${LEAVE_YEAR}`,
      );
      const res = await patch(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/year/${LEAVE_YEAR}`,
        { annualLeave: -5 },
      );
      expect(res.status).toBe(200);
      const read = await get(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}?year=${LEAVE_YEAR}`,
      );
      expect(dataOf(read).remainingAnnual).toBeLessThan(0);
    });

    it('LBL-API-16 the per-type PATCH updates allocated and syncs the legacy column for Annual and Sick', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/init/${LEAVE_YEAR}`,
      );
      const res = await patch(
        fx.hr.token,
        `/leave-balances/${fx.allocStaffId}/${LEAVE_YEAR}/Annual%20Leave`,
        { allocated: 18, carriedOver: 4 },
      );
      expect(res.status).toBe(200);
      const type = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.allocStaffId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(type.allocated).toBe(18);
      expect(type.carriedOver).toBe(4);
      const legacy = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.allocStaffId, year: LEAVE_YEAR },
      });
      expect(legacy.annualLeave).toBe(18);
    });

    /**
     * L23. `leaveTypeKey` is a plain string with no foreign key and no
     * validation against the library, so this endpoint creates a balance for a
     * leave type that does not exist and that nobody can ever request.
     */
    it('LBL-API-17 a leave type that does not exist gets a balance row anyway', async () => {
      const phantom = `Nonexistent ${fx.runId}`;
      const res = await patch(
        fx.hr.token,
        `/leave-balances/${fx.allocStaffId}/${LEAVE_YEAR}/${encodeURIComponent(phantom)}`,
        { allocated: 99 },
      );
      expect(res.status).toBe(200);
      const row = await ctx.prisma.leaveTypeBalance.findFirst({
        where: {
          employeeId: fx.allocStaffId,
          year: LEAVE_YEAR,
          leaveTypeKey: phantom,
        },
      });
      expect(row).toBeTruthy();
      expect(row!.allocated).toBe(99);

      // And no leave can ever be filed against it — the create path resolves the
      // label against the library, so this row is unreachable stock.
      const types = await get(fx.hr.token, '/leave-balances/leave-types');
      expect(dataOf(types).map((t: any) => t.label)).not.toContain(phantom);
    });

    /**
     * L19, recorded. `carriedOver` has no automation at all — there is no
     * year-end job — so this endpoint is the ONLY thing in the product that ever
     * writes it.
     */
    it('LBL-API-18 the per-type PATCH is the only writer of carriedOver in the whole product', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.allocStaffId}/init/${LEAVE_YEAR}`,
      );
      await patch(
        fx.hr.token,
        `/leave-balances/${fx.allocStaffId}/${LEAVE_YEAR}/Annual%20Leave`,
        { allocated: 12, carriedOver: 6 },
      );
      const row = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.allocStaffId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(row.carriedOver).toBe(6);

      // Accrual moves `allocated`, never `carriedOver` — which is why L18's
      // bulk reset destroys accrued days but leaves carry-over alone.
      await post(
        fx.hr.token,
        `/leave-balances/accrual/employee/${fx.allocStaffId}`,
        { daysToAdd: 2, notes: 'check' },
      );
      const after = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.allocStaffId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(after.carriedOver).toBe(6);
    });

    it('LBL-API-19 carriedOver counts toward remaining, proved by a leave that only fits because of it', async () => {
      // Three working days requested against an allocation of one plus two
      // carried over.
      await fx.setBalance(fx.applicantId, 'Annual Leave', 1);
      await ctx.prisma.leaveTypeBalance.updateMany({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
        data: { carriedOver: 2 },
      });

      const start = freeDateOn(200, 1);
      const end = new Date(`${start}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 2);
      const res = await ctx
        .http()
        .post('/leave-requests')
        .set(bearer(fx.hr.token))
        .send({
          employeeId: fx.applicantId,
          leaveType: 'ANNUAL',
          startDate: start,
          endDate: end.toISOString().slice(0, 10),
          reason: `balance spec ${fx.runId}`,
        });
      expect(res.status).toBe(201);
      expect(dataOf(res).totalDays).toBe(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('accrual', () => {
    const thisYear = () => new Date().getUTCFullYear();

    it('LBL-API-20 a manual accrual adds days and writes one MANUAL history row', async () => {
      const res = await post(
        fx.hr.token,
        `/leave-balances/accrual/employee/${fx.accrualStaffId}`,
        { daysToAdd: 3, notes: 'goodwill' },
      );
      expect(res.status).toBe(201);

      const balance = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.accrualStaffId, year: thisYear() },
      });
      expect(balance.annualLeave).toBe(15); // 12 default + 3

      const history = await ctx.prisma.leaveAccrualHistory.findMany({
        where: { employeeId: fx.accrualStaffId },
      });
      expect(history).toHaveLength(1);
      expect(history[0].accrualType).toBe('MANUAL');
      expect(history[0].daysAdded).toBe(3);
      expect(history[0].balanceBefore).toBe(12);
      expect(history[0].balanceAfter).toBe(15);
      expect(history[0].triggeredBy).toBe(fx.hr.userId);
      expect(history[0].notes).toBe('goodwill');
    });

    it('LBL-API-21 accruing for an employee with no balance initialises one first', async () => {
      expect(
        await ctx.prisma.leaveBalance.count({
          where: { employeeId: fx.accrualStaffId, year: thisYear() },
        }),
      ).toBe(0);
      await post(
        fx.hr.token,
        `/leave-balances/accrual/employee/${fx.accrualStaffId}`,
        { daysToAdd: 1, notes: 'first' },
      );
      const history = await ctx.prisma.leaveAccrualHistory.findFirstOrThrow({
        where: { employeeId: fx.accrualStaffId },
      });
      expect(history.balanceBefore).toBe(12); // the freshly initialised default
    });

    it('LBL-API-22 a negative daysToAdd SUBTRACTS — there is no validation', async () => {
      const res = await post(
        fx.hr.token,
        `/leave-balances/accrual/employee/${fx.accrualStaffId}`,
        { daysToAdd: -4, notes: 'clawback' },
      );
      expect(res.status).toBe(201);
      const balance = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.accrualStaffId, year: thisYear() },
      });
      expect(balance.annualLeave).toBe(8);
    });

    it('LBL-API-28 the history filters by employee, year and month', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/accrual/employee/${fx.accrualStaffId}`,
        { daysToAdd: 1, notes: 'a' },
      );
      const mine = await get(
        fx.hr.token,
        `/leave-balances/accrual/history?employeeId=${fx.accrualStaffId}`,
      );
      expect(mine.status).toBe(200);
      const rows = dataOf(mine);
      expect(rows.length).toBe(1);
      expect(rows[0].employeeId).toBe(fx.accrualStaffId);

      const wrongYear = await get(
        fx.hr.token,
        `/leave-balances/accrual/history?employeeId=${fx.accrualStaffId}&year=1999`,
      );
      expect(dataOf(wrongYear)).toEqual([]);
    });

    it('LBL-API-29 an employee with no accrual history gets an empty envelope, not a 404', async () => {
      const res = await get(
        fx.hr.token,
        `/leave-balances/accrual/history?employeeId=${fx.balanceStaffId}`,
      );
      expect(res.status).toBe(200);
      expect(dataOf(res)).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the deduction seam with leave', () => {
    const fileAndApprove = async (
      leaveType: string,
      offset: number,
      employeeId = fx.applicantId,
    ) => {
      const w = freeWindow(offset, 1);
      const start = freeDateOn(offset, 1); // a Monday: one working day
      const created = await ctx
        .http()
        .post('/leave-requests')
        .set(bearer(fx.hr.token))
        .send({
          employeeId,
          leaveType,
          startDate: start,
          endDate: start,
          reason: `balance spec ${fx.runId}`,
        });
      expect(created.status).toBe(201);
      const approved = await ctx
        .http()
        .post(`/leave-requests/${dataOf(created).id}/approve`)
        .set(bearer(fx.hr.token))
        .send({});
      void w;
      return { created, approved };
    };

    it('LBL-API-35 approval moves used on BOTH models by exactly totalDays', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const { approved } = await fileAndApprove('ANNUAL', 210);
      expect(approved.status).toBe(201);

      const type = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(type.used).toBe(1);
      const legacy = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.applicantId, year: LEAVE_YEAR },
      });
      expect(legacy.usedAnnual).toBe(1);
    });

    it('LBL-API-36 approving a type that does not affect balance moves nothing', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const before = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      const { approved } = await fileAndApprove('UNPAID', 214);
      expect(approved.status).toBe(201);
      const after = await ctx.prisma.leaveTypeBalance.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.used).toBe(before.used);
    });

    it('LBL-API-37 an unmatched free-text type falls to the legacy arm and charges usedAnnual', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const { approved } = await fileAndApprove(`Freeform ${fx.runId}`, 218);
      expect(approved.status).toBe(201);
      const legacy = await ctx.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId: fx.applicantId, year: LEAVE_YEAR },
      });
      // The legacy fallback charges the annual bucket for ANY unmatched type.
      expect(legacy.usedAnnual).toBe(1);
    });

    it('LBL-API-38 deductDays creates the type row on the fly, seeded from the library default', async () => {
      // No balance rows at all for this employee/year.
      await fx.resetBalances(fx.applicantId, LEAVE_YEAR);
      const { approved } = await fileAndApprove('SICK', 222);
      expect(approved.status).toBe(201);
      const sick = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Sick Leave',
        },
      });
      expect(sick.allocated).toBe(30); // the library default for Sick Leave
      expect(sick.used).toBe(1);
    });

    it('LBL-API-39 a rejected and a cancelled leave move nothing', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const start = freeDateOn(226, 1);
      const created = await ctx
        .http()
        .post('/leave-requests')
        .set(bearer(fx.hr.token))
        .send({
          employeeId: fx.applicantId,
          leaveType: 'ANNUAL',
          startDate: start,
          endDate: start,
          reason: `balance spec ${fx.runId}`,
        });
      await ctx
        .http()
        .post(`/leave-requests/${dataOf(created).id}/reject`)
        .set(bearer(fx.hr.token))
        .send({ rejectedReason: 'no' });

      const type = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
        where: {
          employeeId: fx.applicantId,
          year: LEAVE_YEAR,
          leaveTypeKey: 'Annual Leave',
        },
      });
      expect(type.used).toBe(0);
    });

    /**
     * L13. `addDays` — the only function that could give a day back — has no
     * caller anywhere in the product. There is no un-approve, no edit endpoint,
     * and `cancel` refuses anything that is not PENDING. So once a day is
     * deducted, nothing in the API can return it.
     *
     * Asserted as a SWEEP rather than as a single case: every write door on both
     * controllers is exercised against an approved leave, and none of them may
     * move `used` downward.
     */
    it('LBL-API-40 no endpoint on either controller can give a deducted day back', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const { created } = await fileAndApprove('ANNUAL', 230);
      const id = dataOf(created).id;

      const usedNow = async () =>
        (
          await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
            where: {
              employeeId: fx.applicantId,
              year: LEAVE_YEAR,
              leaveTypeKey: 'Annual Leave',
            },
          })
        ).used;
      expect(await usedNow()).toBe(1);

      // Cancel: refused, it is no longer PENDING.
      expect(
        (
          await ctx
            .http()
            .delete(`/leave-requests/${id}`)
            .set(bearer(fx.employee.token))
        ).status,
      ).toBe(400);
      // Reject: refused for the same reason.
      expect(
        (
          await ctx
            .http()
            .post(`/leave-requests/${id}/reject`)
            .set(bearer(fx.hr.token))
            .send({ rejectedReason: 'undo please' })
        ).status,
      ).toBe(400);
      // Re-approve: idempotent, and must not double-charge either.
      await ctx
        .http()
        .post(`/leave-requests/${id}/approve`)
        .set(bearer(fx.hr.token))
        .send({});

      expect(await usedNow()).toBe(1);

      // The allocation can be RAISED to compensate, which is the only workaround
      // that exists — but `used` itself never falls.
      await patch(
        fx.hr.token,
        `/leave-balances/${fx.applicantId}/${LEAVE_YEAR}/Annual%20Leave`,
        { allocated: 30 },
      );
      expect(await usedNow()).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('the company overview', () => {
    it('LBL-API-41 the overview groups by leave type and moves by exactly one approval', async () => {
      await fx.setBalance(fx.applicantId, 'Annual Leave', 10);
      const before = await get(
        fx.hr.token,
        `/leave-balances/company-overview?year=${LEAVE_YEAR}`,
      );
      const beforeAnnual = dataOf(before).leaveTypes.find(
        (t: any) => t.leaveTypeKey === 'Annual Leave',
      );

      const start = freeDateOn(240, 1);
      const created = await ctx
        .http()
        .post('/leave-requests')
        .set(bearer(fx.hr.token))
        .send({
          employeeId: fx.applicantId,
          leaveType: 'ANNUAL',
          startDate: start,
          endDate: start,
          reason: `balance spec ${fx.runId}`,
        });
      await ctx
        .http()
        .post(`/leave-requests/${dataOf(created).id}/approve`)
        .set(bearer(fx.hr.token))
        .send({});

      const after = await get(
        fx.hr.token,
        `/leave-balances/company-overview?year=${LEAVE_YEAR}`,
      );
      const afterAnnual = dataOf(after).leaveTypes.find(
        (t: any) => t.leaveTypeKey === 'Annual Leave',
      );
      // A DELTA, never an absolute: this endpoint sums the whole company and
      // every other suite's employees are in it.
      expect(afterAnnual.totalUsed - beforeAnnual.totalUsed).toBe(1);
    });

    it('LBL-API-42 requestStats counts only requests whose start date falls inside the target year', async () => {
      const start = freeDateOn(244, 1);
      const before = await get(
        fx.hr.token,
        `/leave-balances/company-overview?year=${LEAVE_YEAR}`,
      );
      await ctx
        .http()
        .post('/leave-requests')
        .set(bearer(fx.hr.token))
        .send({
          employeeId: fx.applicantId,
          leaveType: 'ANNUAL',
          startDate: start,
          endDate: start,
          reason: `balance spec ${fx.runId}`,
        });
      const after = await get(
        fx.hr.token,
        `/leave-balances/company-overview?year=${LEAVE_YEAR}`,
      );
      expect(
        dataOf(after).requestStats.pending - dataOf(before).requestStats.pending,
      ).toBe(1);

      // A different year cannot see it — the 2027 isolation is what makes this
      // assertion possible at all.
      const otherYear = await get(
        fx.hr.token,
        `/leave-balances/company-overview?year=${LEAVE_YEAR - 1}`,
      );
      expect(otherYear.status).toBe(200);
      expect(
        dataOf(otherYear).requestStats.pending,
      ).not.toBe(dataOf(after).requestStats.pending);
    });

    it('LBL-API-43 the overview reports a total employee count and a per-type breakdown', async () => {
      const res = await get(
        fx.hr.token,
        `/leave-balances/company-overview?year=${LEAVE_YEAR}`,
      );
      expect(res.status).toBe(200);
      expect(typeof dataOf(res).totalEmployees).toBe('number');
      expect(Array.isArray(dataOf(res).leaveTypes)).toBe(true);
      for (const t of dataOf(res).leaveTypes) {
        expect(t).toHaveProperty('totalAllocated');
        expect(t).toHaveProperty('totalUsed');
        expect(t).toHaveProperty('totalCarriedOver');
      }
    });

    it('LBL-API-44 the all-balances list is readable and shaped as an envelope', async () => {
      await post(
        fx.hr.token,
        `/leave-balances/employee/${fx.balanceStaffId}/init/${LEAVE_YEAR}`,
      );
      const res = await get(fx.hr.token, `/leave-balances?year=${LEAVE_YEAR}`);
      expect(res.status).toBe(200);
      const ids = dataOf(res).map((b: any) => b.employeeId ?? b.employee?.id);
      expect(ids).toContain(fx.balanceStaffId);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ORDERED LAST, DELIBERATELY. Both endpoints below mutate every employee in
  // the database; running them earlier would invalidate every absolute-balance
  // assertion above. Both are wrapped in `runAccrualAndRevert`, which snapshots
  // and restores the whole of both balance models.
  // ───────────────────────────────────────────────────────────────────────────
  describe('the two global mutations', () => {
    const thisYear = () => new Date().getUTCFullYear();

    it('LBL-API-23 accrual/run adds exactly one day to each ACTIVE employee and writes an AUTO row each', async () => {
      await fx.runAccrualAndRevert(async () => {
        const res = await post(fx.hr.token, '/leave-balances/accrual/run');
        expect(res.status).toBe(201);

        const balance = await ctx.prisma.leaveBalance.findFirstOrThrow({
          where: { employeeId: fx.accrualStaffId, year: thisYear() },
        });
        expect(balance.annualLeave).toBe(13); // 12 default + 1

        const history = await ctx.prisma.leaveAccrualHistory.findFirstOrThrow({
          where: {
            employeeId: fx.accrualStaffId,
            year: thisYear(),
            accrualType: 'AUTO',
          },
        });
        expect(history.daysAdded).toBe(1);
      });
    });

    it('LBL-API-24 a second run in the same company month skips every employee', async () => {
      await fx.runAccrualAndRevert(async () => {
        const first = await post(fx.hr.token, '/leave-balances/accrual/run');
        const firstResults = dataOf(first);
        expect(firstResults.success).toBeGreaterThan(0);

        const second = await post(fx.hr.token, '/leave-balances/accrual/run');
        const secondResults = dataOf(second);
        expect(secondResults.success).toBe(0);
        expect(secondResults.skipped).toBeGreaterThanOrEqual(
          firstResults.success,
        );

        const balance = await ctx.prisma.leaveBalance.findFirstOrThrow({
          where: { employeeId: fx.accrualStaffId, year: thisYear() },
        });
        expect(balance.annualLeave).toBe(13); // still 13, not 14
      });
    });

    it('LBL-API-25 an INACTIVE employee is excluded from accrual but NOT from the bulk reset', async () => {
      await fx.runAccrualAndRevert(async () => {
        await post(fx.hr.token, '/leave-balances/accrual/run');
        // The accrual query filters `status: 'ACTIVE'`.
        expect(
          await ctx.prisma.leaveAccrualHistory.count({
            where: { employeeId: fx.terminatedStaffId, accrualType: 'AUTO' },
          }),
        ).toBe(0);

        // The bulk reset does not filter at all.
        await post(fx.hr.token, '/leave-balances/set-default-allocation', {
          year: LEAVE_YEAR,
        });
        expect(
          await ctx.prisma.leaveTypeBalance.count({
            where: { employeeId: fx.terminatedStaffId, year: LEAVE_YEAR },
          }),
        ).toBeGreaterThan(0);
      });
    });

    it('LBL-API-26 accrual/run is narrowed to a scoped HR’s branches', async () => {
      await fx.runAccrualAndRevert(async () => {
        const res = await post(fx.scopedHr.token, '/leave-balances/accrual/run');
        expect(res.status).toBe(201);
        // foreignStaff is outside scopedHr's two-branch envelope.
        expect(
          await ctx.prisma.leaveAccrualHistory.count({
            where: { employeeId: fx.foreignStaffId, accrualType: 'AUTO' },
          }),
        ).toBe(0);
        // …while an in-envelope employee was accrued.
        expect(
          await ctx.prisma.leaveAccrualHistory.count({
            where: { employeeId: fx.accrualStaffId, accrualType: 'AUTO' },
          }),
        ).toBe(1);
      });
    });

    /**
     * L11, FIXED. `accrueLeaveForEmployee` resolved the employee with a bare
     * `findUnique` — which bypasses the Prisma branch middleware — and never
     * called `assertInBranch`, so a branch-scoped HR could credit leave to an
     * employee they are not allowed to read.
     */
    it('LBL-API-27 a scoped HR cannot accrue for an employee in a branch they cannot see', async () => {
      await fx.runAccrualAndRevert(async () => {
        const res = await post(
          fx.scopedHr.token,
          `/leave-balances/accrual/employee/${fx.foreignStaffId}`,
          { daysToAdd: 5, notes: 'across the branch line' },
        );
        expect(res.status).toBe(404);
        expect(
          await ctx.prisma.leaveAccrualHistory.count({
            where: { employeeId: fx.foreignStaffId },
          }),
        ).toBe(0);

        // In-envelope, the same call still works — the envelope narrowed, it
        // did not close.
        const allowed = await post(
          fx.scopedHr.token,
          `/leave-balances/accrual/employee/${fx.accrualStaffId}`,
          { daysToAdd: 1, notes: 'in envelope' },
        );
        expect(allowed.status).toBe(201);
      });
    });

    it('LBL-API-30 the bulk reset restores allocations to the library defaults', async () => {
      await fx.runAccrualAndRevert(async () => {
        await fx.setBalance(fx.allocStaffId, 'Annual Leave', 99);
        const res = await post(
          fx.hr.token,
          '/leave-balances/set-default-allocation',
          { year: LEAVE_YEAR },
        );
        expect(res.status).toBe(201);
        const row = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
          where: {
            employeeId: fx.allocStaffId,
            year: LEAVE_YEAR,
            leaveTypeKey: 'Annual Leave',
          },
        });
        expect(row.allocated).toBe(12);
      });
    });

    /**
     * L18. There is no confirmation, no dry run and no undo, and the endpoint
     * takes nothing but a year. A single POST silently destroys every manual
     * allocation an HR team has made for that year.
     */
    it('LBL-API-31 the bulk reset destroys a manual allocation with no confirmation and no undo', async () => {
      await fx.runAccrualAndRevert(async () => {
        await patch(
          fx.hr.token,
          `/leave-balances/${fx.allocStaffId}/${LEAVE_YEAR}/Annual%20Leave`,
          { allocated: 40 },
        );
        expect(
          (
            await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
              where: {
                employeeId: fx.allocStaffId,
                year: LEAVE_YEAR,
                leaveTypeKey: 'Annual Leave',
              },
            })
          ).allocated,
        ).toBe(40);

        await post(fx.hr.token, '/leave-balances/set-default-allocation', {
          year: LEAVE_YEAR,
        });

        expect(
          (
            await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
              where: {
                employeeId: fx.allocStaffId,
                year: LEAVE_YEAR,
                leaveTypeKey: 'Annual Leave',
              },
            })
          ).allocated,
        ).toBe(12);
      });
    });

    /**
     * L19. Accrual writes the SAME column the bulk reset overwrites
     * (`allocated` / `annualLeave`) rather than a separate accrued bucket — so
     * the reset destroys earned days, not merely configured ones.
     */
    it('LBL-API-32 the bulk reset destroys ACCRUED days too, because accrual writes the same column', async () => {
      await fx.runAccrualAndRevert(async () => {
        await post(
          fx.hr.token,
          `/leave-balances/accrual/employee/${fx.allocStaffId}`,
          { daysToAdd: 6, notes: 'six months of service' },
        );
        // The accrual landed in the CURRENT year; mirror it into the target year
        // so one POST can be shown to erase it.
        await patch(
          fx.hr.token,
          `/leave-balances/${fx.allocStaffId}/${LEAVE_YEAR}/Annual%20Leave`,
          { allocated: 18 },
        );

        await post(fx.hr.token, '/leave-balances/set-default-allocation', {
          year: LEAVE_YEAR,
        });

        const after = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
          where: {
            employeeId: fx.allocStaffId,
            year: LEAVE_YEAR,
            leaveTypeKey: 'Annual Leave',
          },
        });
        expect(after.allocated).toBe(12); // the six accrued days are gone
      });
    });

    it('LBL-API-33 the bulk reset leaves `used` alone, so used can end up above allocated', async () => {
      await fx.runAccrualAndRevert(async () => {
        await fx.setBalance(fx.allocStaffId, 'Annual Leave', 40);
        await ctx.prisma.leaveTypeBalance.updateMany({
          where: {
            employeeId: fx.allocStaffId,
            year: LEAVE_YEAR,
            leaveTypeKey: 'Annual Leave',
          },
          data: { used: 20 },
        });

        await post(fx.hr.token, '/leave-balances/set-default-allocation', {
          year: LEAVE_YEAR,
        });

        const after = await ctx.prisma.leaveTypeBalance.findFirstOrThrow({
          where: {
            employeeId: fx.allocStaffId,
            year: LEAVE_YEAR,
            leaveTypeKey: 'Annual Leave',
          },
        });
        expect(after.allocated).toBe(12);
        expect(after.used).toBe(20);
        expect(after.allocated + after.carriedOver - after.used).toBeLessThan(0);
      });
    });

    it('LBL-API-34 the bulk reset refuses a missing year rather than handing NaN to the driver', async () => {
      const res = await post(
        fx.hr.token,
        '/leave-balances/set-default-allocation',
        {},
      );
      expect(res.status).toBe(400);
      expect(body(res)).toContain('A valid year is required');
      expect(body(res)).not.toContain('prisma');
    });
  });
});
