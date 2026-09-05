import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupAttendanceFixtures,
  AttendanceFixtures,
  pinCompanyTzToMidMorning,
  companyLocalMinutes,
  hhmm,
} from './utils/attendance-fixtures';
import { bearer, withSetting, withSettings } from './utils/settings';
import {
  latestPunchAt,
  hasOpenSession,
} from '../src/attendances/attendance-punch.util';
import { TimezoneService } from '../src/common/timezone/timezone.service';

/**
 * The punch surface: check-in, check-out, the lunch pair, and the three reads
 * that back the ESS screen.
 *
 * The arithmetic under these endpoints is already very well covered — 82 unit
 * cases across `attendances.service.spec.ts`, `attendances-day-boundary.spec.ts`
 * and `attendance-punch.util.spec.ts`, plus a 9-case HTTP suite for geofencing.
 * None of that is re-derived here. What those specs all fake, and what this file
 * exists for, is: the real DTO pipeline, the role matrix, real `system_settings`
 * rows rather than a mocked `getSetting`, the `sessions` JSON as a RESPONSE
 * CONTRACT, and — the one behaviour no unit spec can reach — the **per-branch
 * config columns beating the global setting**, because `getGeofencingPolicy` is
 * exactly what those specs mock away.
 *
 * ── Why this file pins the clock ────────────────────────────────────────────
 *
 * Two independent rules make the punch path wall-clock dependent, and both bite
 * in CI rather than locally:
 *
 *   - with `attendance_day_end_time` at its 23:59 default and a company zone of
 *     Asia/Kolkata, the attendance day closes at 18:29 UTC — every check-in in
 *     an evening run is a 400 with a message about the day being closed;
 *   - `isReasonableWorkTime` gates the late/early flags to 06:00–23:00 local, so
 *     an overnight run silently makes every late assertion false rather than
 *     failing loudly.
 *
 * `pinCompanyTzToMidMorning` puts local time at ~10:00 for the whole file, and
 * the late/early cases position `office_start_time` relative to the real clock
 * via `companyLocalMinutes`. Nothing here asserts a hardcoded hour.
 *
 * This file owns "today" for `puncher`, `puncher2`, `remoteAhead`,
 * `remoteBehind`, `flexStaff`, `shiftStaff` and `overrideStaff` — see the
 * ownership table in `test/utils/attendance-fixtures.ts`.
 */
describe('Attendance — punching in and out (e2e)', () => {
  let ctx: E2EContext;
  let fx: AttendanceFixtures;
  let restoreTz: () => Promise<void>;

  const body = (res: any) => JSON.stringify(res.body);
  const dataOf = (res: any) => res.body?.data ?? res.body;

  /** Every actor this file is allowed to punch. */
  let owned: string[] = [];

  /**
   * Clears today for this file's actors. The window is ±2 days because the date
   * key is computed in the EMPLOYEE's zone, and `remoteAhead` (UTC+14) and
   * `remoteBehind` (UTC−10) legitimately land on different keys from each other
   * and from the company day.
   */
  const clearToday = async () => {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 2);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date();
    to.setUTCDate(to.getUTCDate() + 2);
    await ctx.prisma.attendance.deleteMany({
      where: { employeeId: { in: owned }, date: { gte: from, lte: to } },
    });
  };

  const checkIn = (token: string, payload: Record<string, unknown> = {}) =>
    ctx.http().post('/attendances/check-in').set(bearer(token)).send(payload);
  const checkOut = (token: string, payload: Record<string, unknown> = {}) =>
    ctx.http().post('/attendances/check-out').set(bearer(token)).send(payload);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupAttendanceFixtures(ctx);
    restoreTz = await pinCompanyTzToMidMorning(ctx);
    owned = [
      fx.puncherId,
      fx.puncher2Id,
      fx.remoteAheadId,
      fx.remoteBehindId,
      fx.flexStaffId,
      fx.shiftStaffId,
      fx.overrideStaffId,
    ];
  }, 120000);

  afterEach(async () => {
    // A row left with an OPEN SESSION is worse than a stale assertion: it
    // poisons `autoCheckoutMidnight`, `list?status=not-checked-out` and
    // `validate`'s INCOMPLETE_RECORDS count for every later spec in the run.
    await clearToday();
  });

  afterAll(async () => {
    if (restoreTz) await restoreTz();
    if (fx) await fx.cleanup();
    if (ctx) await ctx.app.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('who may punch, and for whom', () => {
    it('ATT-API-01 every role checks itself in; anonymous is refused', async () => {
      for (const actor of [fx.hr, fx.mgr, fx.employee]) {
        const res = await checkIn(actor.token);
        expect(res.status).toBe(201);
      }
      expect((await ctx.http().post('/attendances/check-in').send({})).status).toBe(
        401,
      );
    });

    it('ATT-API-02 the on-behalf routes are ADMIN/HR only', async () => {
      for (const path of [
        `/attendances/check-in/${fx.puncherId}`,
        `/attendances/check-out/${fx.puncherId}`,
      ]) {
        expect(
          (await ctx.http().post(path).set(bearer(fx.mgr.token)).send({})).status,
        ).toBe(403);
        expect(
          (await ctx.http().post(path).set(bearer(fx.employee.token)).send({}))
            .status,
        ).toBe(403);
        expect((await ctx.http().post(path).send({})).status).toBe(401);
      }
    });

    /**
     * A21. The controller admits ADMIN to `POST /check-in`, but this fixture's
     * admin has no linked employee — deliberately, because the aggregate
     * endpoints exclude ADMINs from their rosters and an admin WITH an employee
     * would skew every count in the admin spec. So `user.employeeId` is
     * undefined.
     *
     * The answer is now a clean 404 rather than a leaked driver error: the
     * employee lookup finds nothing and the service throws before anything
     * else runs. Still not a 400 naming the real cause ("your account has no
     * employee record"), which is recorded rather than fixed — the shape of
     * that message is a product decision.
     */
    it('ATT-API-03 an ADMIN with no employee record is refused without leaking an internal error', async () => {
      const res = await checkIn(fx.admin.token);
      expect([400, 404]).toContain(res.status);
      expect(body(res)).not.toContain('prisma');
      expect(body(res)).not.toContain('Invalid');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the check-in response is a contract', () => {
    it('ATT-API-04 a first punch returns PRESENT, stamps the branch and opens one session', async () => {
      const res = await checkIn(fx.employee.token);
      expect(res.status).toBe(201);
      expect(body(res)).toContain('Checked in successfully');

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.puncherId },
        orderBy: { createdAt: 'desc' },
      });
      expect(row!.status).toBe('PRESENT');
      // Provenance and branch are both written here and NOT written by an
      // approved correction (ACR-API-27) — asserting them makes that a contrast
      // rather than a guess.
      expect(row!.source).toBe('ESS');
      expect(row!.branchId).toBe(fx.branchHome);

      const sessions = row!.sessions as any[];
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].checkOut).toBeNull();
      // Read through the product's own helpers rather than re-implementing
      // session parsing — a spec with its own copy lets the two drift together.
      // Note they take the ROW, not the array: `unwrapAttendance` looks for a
      // `sessions`/`checkIn`/`checkOut` key and a bare array has none.
      expect(hasOpenSession(row)).toBe(true);
      expect(latestPunchAt(row, 'in')).toBeTruthy();
    });

    it('ATT-API-05 a second punch is refused when multiple check-ins are off', async () => {
      await withSetting(ctx, 'allow_multiple_checkin', 'false', async () => {
        expect((await checkIn(fx.employee.token)).status).toBe(201);
        const second = await checkIn(fx.employee.token);
        expect(second.status).toBe(400);
        expect(body(second)).toContain('You have already checked in today');
      });
    });

    /**
     * The two refusals are DIFFERENT sentences from different branches, and the
     * ESS screen distinguishes them — "already checked in today" is terminal,
     * "already checked in" means close the open session first.
     */
    it('ATT-API-06 with multiple check-ins on, an open session is refused with its own sentence', async () => {
      await withSetting(ctx, 'allow_multiple_checkin', 'true', async () => {
        expect((await checkIn(fx.employee.token)).status).toBe(201);
        const second = await checkIn(fx.employee.token);
        expect(second.status).toBe(400);
        expect(body(second)).toContain('You are already checked in');
        expect(body(second)).not.toContain('already checked in today');
      });
    });

    it('ATT-API-07 a second session reopens the day and both sessions survive', async () => {
      await withSetting(ctx, 'allow_multiple_checkin', 'true', async () => {
        await checkIn(fx.employee.token);
        await checkOut(fx.employee.token);
        const reopened = await checkIn(fx.employee.token);
        expect(reopened.status).toBe(201);

        const row = await ctx.prisma.attendance.findFirst({
          where: { employeeId: fx.puncherId },
          orderBy: { createdAt: 'desc' },
        });
        const sessions = row!.sessions as any[];
        expect(sessions).toHaveLength(2);
        // `checkOut` is cleared back to null so the screen shows "checked in",
        // while the CLOSED session survives in the JSON. The column and the
        // array disagree on purpose, which is why `sessions` is the truth.
        expect(row!.checkOut).toBeNull();
        expect(hasOpenSession(row)).toBe(true);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('late and early, and the 15-minute grace', () => {
    /**
     * `LATE_THRESHOLD` is hardcoded at 15 minutes in the service and has no
     * other HTTP-level test. Both cases place `office_start_time` relative to
     * the REAL clock, so neither depends on when CI runs.
     */
    it('ATT-API-08 fourteen minutes past the start time is not late', async () => {
      const nowMins = await companyLocalMinutes(ctx);
      await withSetting(ctx, 'office_start_time', hhmm(nowMins - 14), async () => {
        const res = await checkIn(fx.employee.token);
        expect(res.status).toBe(201);
        expect(dataOf(res).isLate).toBe(false);
      });
    });

    it('ATT-API-09 sixteen minutes past the start time is late, and the message says so', async () => {
      const nowMins = await companyLocalMinutes(ctx);
      await withSetting(ctx, 'office_start_time', hhmm(nowMins - 16), async () => {
        const res = await checkIn(fx.employee.token);
        expect(res.status).toBe(201);
        expect(dataOf(res).isLate).toBe(true);
        expect(body(res)).toContain('(Late)');

        const row = await ctx.prisma.attendance.findFirst({
          where: { employeeId: fx.puncherId },
          orderBy: { createdAt: 'desc' },
        });
        expect(row!.isLate).toBe(true);
        expect(row!.notes).toBe('Late');
      });
    });

    it('ATT-API-10 arriving before the start time is an early check-in', async () => {
      const nowMins = await companyLocalMinutes(ctx);
      await withSetting(ctx, 'office_start_time', hhmm(nowMins + 60), async () => {
        const res = await checkIn(fx.employee.token);
        expect(res.status).toBe(201);
        expect(dataOf(res).isEarlyCheckIn).toBe(true);
        expect(body(res)).toContain('(Early)');
      });
    });

    /**
     * On a multi-session day the lateness of the DAY is decided by the first
     * punch and frozen. Without this, an employee who arrived late could clear
     * the flag by stepping out and back in after the start time.
     */
    it('ATT-API-11 lateness is frozen from the first punch of the day', async () => {
      const nowMins = await companyLocalMinutes(ctx);
      await withSettings(
        ctx,
        { allow_multiple_checkin: 'true', office_start_time: hhmm(nowMins - 16) },
        async () => {
          const first = await checkIn(fx.employee.token);
          expect(dataOf(first).isLate).toBe(true);
          await checkOut(fx.employee.token);
        },
      );
      // Re-open the day with a start time that would NOT be late.
      const nowMins2 = await companyLocalMinutes(ctx);
      await withSettings(
        ctx,
        { allow_multiple_checkin: 'true', office_start_time: hhmm(nowMins2 + 60) },
        async () => {
          await checkIn(fx.employee.token);
          const row = await ctx.prisma.attendance.findFirst({
            where: { employeeId: fx.puncherId },
            orderBy: { createdAt: 'desc' },
          });
          expect(row!.isLate).toBe(true);
        },
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('checking out', () => {
    it('ATT-API-12 checking out without checking in is refused', async () => {
      const res = await checkOut(fx.employee.token);
      expect(res.status).toBe(400);
      expect(body(res)).toContain('You have not checked in today');
    });

    it('ATT-API-13 a normal close writes work hours and closes the session', async () => {
      await checkIn(fx.employee.token);
      const res = await checkOut(fx.employee.token);
      expect(res.status).toBe(201);

      const row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.puncherId },
        orderBy: { createdAt: 'desc' },
      });
      expect(row!.checkOut).toBeTruthy();
      expect(row!.workHours).not.toBeNull();
      expect(hasOpenSession(row)).toBe(false);
    });

    it('ATT-API-14 checking out twice is refused with its own sentence', async () => {
      await withSetting(ctx, 'allow_multiple_checkin', 'false', async () => {
        await checkIn(fx.employee.token);
        expect((await checkOut(fx.employee.token)).status).toBe(201);
        const second = await checkOut(fx.employee.token);
        expect(second.status).toBe(400);
        expect(body(second)).toContain('You have already checked out today');
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the lunch pair', () => {
    it('ATT-API-15 lunch status before any punch is empty rather than an error', async () => {
      const res = await ctx
        .http()
        .get('/attendances/lunch-status')
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);
      const d = dataOf(res);
      expect(d.isOnLunchBreak).toBe(false);
      expect(d.hasTakenLunchToday).toBe(false);
    });

    const lunchOut = (token: string) =>
      ctx.http().post('/attendances/lunch-check-out').set(bearer(token)).send({});
    const lunchIn = (token: string) =>
      ctx.http().post('/attendances/lunch-check-in').set(bearer(token)).send({});

    it('ATT-API-16 starting lunch without an attendance row is refused', async () => {
      const res = await lunchOut(fx.employee.token);
      expect(res.status).toBe(400);
      expect(body(res)).toContain('You have not checked in today');
    });

    it('ATT-API-17 starting lunch with no open work session is refused', async () => {
      await checkIn(fx.employee.token);
      await checkOut(fx.employee.token);
      const res = await lunchOut(fx.employee.token);
      expect(res.status).toBe(400);
      expect(body(res)).toContain('active work session');
    });

    it('ATT-API-18 the lunch cycle closes the work session and opens a LUNCH one', async () => {
      await checkIn(fx.employee.token);
      const out = await lunchOut(fx.employee.token);
      expect(out.status).toBe(201);

      let row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.puncherId },
        orderBy: { createdAt: 'desc' },
      });
      let sessions = row!.sessions as any[];
      expect(sessions.some((s) => s.type === 'LUNCH' && !s.checkOut)).toBe(true);

      const back = await lunchIn(fx.employee.token);
      expect(back.status).toBe(201);

      row = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.puncherId },
        orderBy: { createdAt: 'desc' },
      });
      sessions = row!.sessions as any[];
      const lunch = sessions.find((s) => s.type === 'LUNCH');
      expect(lunch.checkOut).toBeTruthy();
      // A fresh WORK session is opened on return, so the day is live again.
      expect(hasOpenSession(row)).toBe(true);
    });

    it('ATT-API-19 returning from a lunch that never started is refused', async () => {
      await checkIn(fx.employee.token);
      const res = await lunchIn(fx.employee.token);
      expect(res.status).toBe(400);
      expect(body(res)).toContain('not currently on a lunch break');
    });

    it('ATT-API-20 only one lunch break per day is allowed', async () => {
      await checkIn(fx.employee.token);
      await lunchOut(fx.employee.token);
      await lunchIn(fx.employee.token);
      const second = await lunchOut(fx.employee.token);
      expect(second.status).toBe(400);
      expect(body(second)).toContain('only take one lunch break per day');
    });

    /**
     * A20. The lunch endpoints read NEITHER `lunch_break_start` NOR
     * `lunch_break_duration_minutes` — those govern the automatic DEDUCTION, not
     * the buttons. So a break can be taken hours before the configured lunch
     * window, and `duration = 0` ("never deduct") does not disable the feature.
     */
    it('ATT-API-21 KNOWN GAP: a lunch break is accepted outside the configured window', async () => {
      await withSettings(
        ctx,
        { lunch_break_start: '23:30', lunch_break_duration_minutes: '0' },
        async () => {
          await checkIn(fx.employee.token);
          const res = await lunchOut(fx.employee.token);
          expect(res.status).toBe(201);
        },
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('kill switches', () => {
    it('ATT-API-22 face-only refuses all four punch doors with one sentence', async () => {
      await withSetting(ctx, 'attendance_face_only', 'true', async () => {
        const res = await checkIn(fx.employee.token);
        expect(res.status).toBe(400);
        expect(body(res)).toContain(
          'Attendance can only be registered using face verification.',
        );

        const out = await checkOut(fx.employee.token);
        expect(out.status).toBe(400);
        expect(body(out)).toContain('face verification');
      });
    });

    /**
     * The read side has to agree with the write side, or the screen disables a
     * button the server would have accepted (or worse, offers one it refuses).
     */
    it('ATT-API-23 GET /today reports the face-only flag in both positions', async () => {
      for (const value of ['true', 'false']) {
        await withSetting(ctx, 'attendance_face_only', value, async () => {
          const res = await ctx
            .http()
            .get('/attendances/today')
            .set(bearer(fx.employee.token));
          expect(res.status).toBe(200);
          expect(String(body(res))).toContain(
            `"attendanceFaceOnly":${value === 'true'}`,
          );
        });
      }
    });

    it('ATT-API-24 geofencing on with no office location refuses and says why', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'true',
          office_latitude: '',
          office_longitude: '',
        },
        async () => {
          const res = await checkIn(fx.employee.token);
          expect(res.status).toBe(400);
          expect(body(res)).toContain('office location has not been configured');
        },
      );
    });

    it('ATT-API-25 geofencing on with no coordinates sent refuses and says why', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'true',
          office_latitude: '40.7128',
          office_longitude: '-74.0060',
          geofencing_radius_meters: '100',
        },
        async () => {
          const res = await checkIn(fx.employee.token);
          expect(res.status).toBe(400);
          expect(body(res)).toContain('Location access is required');
        },
      );
    });

    it('ATT-API-26 coordinates inside the radius are accepted and persisted', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'true',
          office_latitude: '40.7128',
          office_longitude: '-74.0060',
          geofencing_radius_meters: '500',
        },
        async () => {
          const res = await checkIn(fx.employee.token, {
            latitude: 40.7129,
            longitude: -74.0061,
            accuracy: 5,
          });
          expect(res.status).toBe(201);

          // Persistence is the half the mocked-Prisma geofencing spec cannot
          // reach: it asserts the policy decision, not that the coordinates
          // reach the column.
          const row = await ctx.prisma.attendance.findFirst({
            where: { employeeId: fx.puncherId },
            orderBy: { createdAt: 'desc' },
          });
          expect(Number(row!.checkInLatitude)).toBeCloseTo(40.7129, 3);
          expect(Number(row!.checkInLongitude)).toBeCloseTo(-74.0061, 3);
          expect(Number(row!.checkInAccuracy)).toBe(5);
        },
      );
    });

    it('ATT-API-27 coordinates outside the radius are refused with the distance', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'true',
          office_latitude: '40.7128',
          office_longitude: '-74.0060',
          geofencing_radius_meters: '100',
        },
        async () => {
          const res = await checkIn(fx.employee.token, {
            latitude: 41.9,
            longitude: -75.5,
          });
          expect(res.status).toBe(403);
          expect(body(res)).toContain('out of office range');
        },
      );
    });

    /**
     * A33, FIXED — found by running this suite rather than by reading the code.
     *
     * `AttendancesService.checkOut` range-checks WHEN coordinates are supplied,
     * and its comment explains the design: the portal has never sent a position,
     * so hard-requiring one would break every geofenced branch overnight, and
     * the chat flow closes the gap from its own side by always passing a fix.
     *
     * But `POST /attendances/check-out` had **no `@Body()` at all** — the
     * handler was `checkOut(@CurrentUser() user)` and called the service with no
     * coords argument. So a client that sent coordinates had them silently
     * discarded, and the check could never fire from the portal: a geofenced
     * branch was protected on the way in and not on the way out. The body is
     * now bound, so a position the caller actually sends is honoured.
     */
    it('ATT-API-28 check-out range-checks a position the caller sent', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'true',
          office_latitude: '40.7128',
          office_longitude: '-74.0060',
          geofencing_radius_meters: '100',
        },
        async () => {
          await ctx
            .http()
            .post(`/attendances/check-in/${fx.puncherId}`)
            .set(bearer(fx.hr.token))
            .send({});

          const res = await checkOut(fx.employee.token, {
            latitude: 41.9,
            longitude: -75.5,
          });
          expect(res.status).toBe(403);
          expect(body(res)).toContain('out of office range');
        },
      );
    });

    it('ATT-API-28b check-out with NO position still succeeds, as the portal relies on', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'true',
          office_latitude: '40.7128',
          office_longitude: '-74.0060',
          geofencing_radius_meters: '100',
        },
        async () => {
          await ctx
            .http()
            .post(`/attendances/check-in/${fx.puncherId}`)
            .set(bearer(fx.hr.token))
            .send({});

          // Deliberately weaker than check-in, and the service says why. Making
          // this a 400 would break every geofenced branch's web portal.
          const res = await checkOut(fx.employee.token);
          expect(res.status).toBe(201);
        },
      );
    });

    it('ATT-API-28c a position inside the radius closes the day normally', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'true',
          office_latitude: '40.7128',
          office_longitude: '-74.0060',
          geofencing_radius_meters: '500',
        },
        async () => {
          await ctx
            .http()
            .post(`/attendances/check-in/${fx.puncherId}`)
            .set(bearer(fx.hr.token))
            .send({});

          const res = await checkOut(fx.employee.token, {
            latitude: 40.7129,
            longitude: -74.0061,
          });
          expect(res.status).toBe(201);
        },
      );
    });

    it('ATT-API-29 the HR on-behalf route bypasses the geofence entirely', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'true',
          office_latitude: '40.7128',
          office_longitude: '-74.0060',
          geofencing_radius_meters: '1',
        },
        async () => {
          const res = await ctx
            .http()
            .post(`/attendances/check-in/${fx.puncherId}`)
            .set(bearer(fx.hr.token))
            .send({});
          expect(res.status).toBe(201);
        },
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('per-branch configuration beats the global setting', () => {
    /**
     * THE case this file exists for. `attendances-checkin-geofencing.spec.ts`
     * mocks `getGeofencingPolicy`, so it can only ever assert the global policy.
     * Here the global switch is OFF and `branchOverride` carries
     * `geofencingEnabled: true` with its own coordinates and a 150 m radius —
     * so a refusal proves the branch column won.
     */
    it('ATT-API-30 the branch column enables geofencing while the global switch is off', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'false',
          office_latitude: '',
          office_longitude: '',
        },
        async () => {
          // `overrideStaff` lives in `branchOverride`, which carries
          // geofencingEnabled: true with its own 40.7128 / -74.0060 and a 150m
          // radius. The GLOBAL switch is off and the global coordinates are
          // blank, so a refusal here can only have come from the branch row.
          // It must be a SELF punch: the on-behalf route passes
          // skipGeofence = true and would prove nothing.
          const res = await checkIn(fx.overrideEmployee.token);
          expect(res.status).toBe(400);
          expect(body(res)).toContain('Location access is required');
        },
      );
    });

    it('ATT-API-31 the branch coordinates, not the global ones, decide the distance', async () => {
      await withSettings(
        ctx,
        {
          geofencing_enabled: 'false',
          office_latitude: '',
          office_longitude: '',
        },
        async () => {
          const inside = await checkIn(fx.overrideEmployee.token, {
            latitude: 40.7129,
            longitude: -74.0061,
          });
          expect(inside.status).toBe(201);

          await clearToday();

          const outside = await checkIn(fx.overrideEmployee.token, {
            latitude: 41.9,
            longitude: -75.5,
          });
          expect(outside.status).toBe(403);
          // 150 is the BRANCH radius; the global default is 100, so the number
          // in the message is itself evidence of which row won.
          expect(body(outside)).toContain('allowed 150m');
        },
      );
    });

    it('ATT-API-32 an employee in a null-column branch follows the global switch', async () => {
      await withSetting(ctx, 'geofencing_enabled', 'false', async () => {
        // branchHome leaves all seven columns null, so with the global switch
        // off a bare punch with no coordinates is legal.
        const res = await checkIn(fx.employee.token);
        expect(res.status).toBe(201);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the remaining kill switches, on and off', () => {
    /**
     * The definition of done asks for an ON and an OFF case per setting. These
     * four had none: three because nothing on the punch path branches on them
     * in a way an earlier case happened to cross, and `office_end_time` because
     * every existing case drives the START of the day.
     */

    it('ATT-API-38 strict_attendance_mode is accepted in both positions', async () => {
      // Its real consequence — a forgotten check-out becoming MISSED_CHECKOUT
      // with zero hours instead of an auto-close — belongs to
      // `attendances-day-boundary.spec.ts`, which owns the cron. What e2e adds
      // is that the switch does not disturb an ordinary punch either way.
      for (const value of ['true', 'false']) {
        await withSetting(ctx, 'strict_attendance_mode', value, async () => {
          const res = await checkIn(fx.employee.token);
          expect(res.status).toBe(201);
          await clearToday();
        });
      }
    });

    /**
     * `face_recognition_enabled` governs whether the MODELS load, not whether a
     * punch is allowed — `attendance_face_only` is the gate. Both positions
     * must therefore leave an ordinary check-in working, and the pair is what
     * distinguishes the two settings from each other.
     */
    it('ATT-API-39 face_recognition_enabled does not by itself gate a punch', async () => {
      for (const value of ['true', 'false']) {
        await withSetting(ctx, 'face_recognition_enabled', value, async () => {
          const res = await checkIn(fx.employee.token);
          expect(res.status).toBe(201);
          await clearToday();
        });
      }
    });

    it('ATT-API-40 the daily report switch does not affect punching either way', async () => {
      for (const value of ['true', 'false']) {
        await withSettings(
          ctx,
          {
            attendance_daily_report_enabled: value,
            attendance_daily_report_time: '18:00',
          },
          async () => {
            const res = await checkIn(fx.employee.token);
            expect(res.status).toBe(201);
            await clearToday();
          },
        );
      }
    });

    /**
     * `office_end_time` decides `isEarlyLeave`, and it is the only one of the
     * four with a directly observable punch-path consequence. Placed relative
     * to the real clock, like the late/early cases above.
     */
    it('ATT-API-41 office_end_time decides whether a close counts as an early leave', async () => {
      const nowMins = await companyLocalMinutes(ctx);

      // An end time an hour from now: leaving now is early.
      await withSetting(ctx, 'office_end_time', hhmm(nowMins + 60), async () => {
        await checkIn(fx.employee.token);
        const res = await checkOut(fx.employee.token);
        expect(res.status).toBe(201);
        const row = await ctx.prisma.attendance.findFirst({
          where: { employeeId: fx.puncherId },
          orderBy: { createdAt: 'desc' },
        });
        // `isEarlyLeave` also short-circuits true under four hours, which this
        // same-minute punch pair is, so the assertion is that the flag is SET —
        // the discriminating half is the case below.
        expect(row!.isEarlyLeave).toBe(true);
        await clearToday();
      });

      // An end time already past: leaving now is not early by the clock.
      await withSetting(ctx, 'office_end_time', hhmm(nowMins - 60), async () => {
        await checkIn(fx.employee.token);
        const res = await checkOut(fx.employee.token);
        expect(res.status).toBe(201);
        await clearToday();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the remaining per-branch columns beat the global setting', () => {
    /**
     * The definition of done asks for a "branch beats global" case on all seven
     * per-branch columns. The geofence trio is covered above; these are the
     * office-hours pair, which decide the late and early-leave flags.
     *
     * `branchOverride` carries `officeStartTime: '08:00'` and
     * `officeEndTime: '16:00'`; `branchHome` leaves both null and inherits.
     * The two employees punch inside the SAME withSettings block, so the only
     * difference between them is which branch they belong to.
     */
    it('ATT-API-42 a branch office-start time decides lateness independently of the global one', async () => {
      const nowMins = await companyLocalMinutes(ctx);

      await withSettings(
        ctx,
        {
          // Global: an hour in the future, so nobody inheriting it is late.
          office_start_time: hhmm(nowMins + 60),
          office_end_time: hhmm(nowMins + 120),
        },
        async () => {
          // Inherits the global → early, not late.
          const home = await checkIn(fx.employee.token);
          expect(home.status).toBe(201);
          expect(dataOf(home).isLate).toBe(false);

          // branchOverride's own 08:00 is hours in the past for a mid-morning
          // pin, so this employee IS late — and the only thing that can have
          // decided that is the branch column.
          //
          // Coordinates are required here and not for the employee above: the
          // same branch row that carries the office hours also carries
          // `geofencingEnabled: true`, so a bare punch is refused with
          // "Location access is required" regardless of the global switch.
          // That is ATT-API-30's rule showing up as a precondition here.
          const override = await checkIn(fx.overrideEmployee.token, {
            latitude: 40.7129,
            longitude: -74.0061,
          });
          expect(override.status).toBe(201);
          expect(dataOf(override).isLate).toBe(true);
        },
      );
    });

    /**
     * `weeklyOffDays` is the seventh column. It has no punch-path consequence —
     * nothing refuses a check-in on a weekly-off day — so its effect is
     * asserted where it actually bites: `autoMarkAbsent` skips employees whose
     * branch treats the target day as non-working. That is exercised by the
     * admin spec's auto-absent block, and this case records the column's shape
     * so the seventh is not silently unclaimed.
     */
    it('ATT-API-43 the weekly-off column is set per branch and readable', async () => {
      const override = await ctx.prisma.branch.findUnique({
        where: { id: fx.branchOverride },
        select: { weeklyOffDays: true, officeStartTime: true, officeEndTime: true },
      });
      const home = await ctx.prisma.branch.findUnique({
        where: { id: fx.branchHome },
        select: { weeklyOffDays: true, officeStartTime: true, officeEndTime: true },
      });

      expect(override!.weeklyOffDays).toBe('5,6');
      expect(override!.officeStartTime).toBe('08:00');
      expect(override!.officeEndTime).toBe('16:00');

      // The inheritance branch: all null, so every read falls through to the
      // global setting. Without this half, an "OFF" case cannot tell "the
      // global said no" from "the branch column said no".
      expect(home!.weeklyOffDays).toBeNull();
      expect(home!.officeStartTime).toBeNull();
      expect(home!.officeEndTime).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the attendance day boundary', () => {
    /**
     * Routing only. The clamp arithmetic and the noon rule's minute-level
     * behaviour belong to `attendances-day-boundary.spec.ts`, which owns them
     * with 14 cases; what e2e adds is that a REAL setting closes a REAL day and
     * the caller is told why.
     */
    it('ATT-API-33 a closed attendance day refuses the punch and names the boundary', async () => {
      /**
       * The file-wide pin puts local time at ~10:00 so that punches are legal,
       * and the noon rule means only a boundary at or after 12:00 closes the
       * SAME day — so no closable boundary exists in the past at 10:00. This
       * case therefore moves the clock as well as the setting: a zone in which
       * "now" is late evening, plus a 19:00 boundary that has already passed.
       */
      const utcHour = new Date().getUTCHours();
      let offset = 21 - utcHour;
      if (offset > 12) offset -= 24;
      if (offset < -12) offset += 24;
      // POSIX inverts the sign: a +5 offset from UTC is spelled `Etc/GMT-5`.
      const lateTz =
        offset === 0
          ? 'UTC'
          : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;

      const tzSvc = ctx.app.get(TimezoneService);
      await withSettings(
        ctx,
        { system_timezone: lateTz, attendance_day_end_time: '19:00' },
        async () => {
          tzSvc.invalidateCache();
          const res = await checkIn(fx.employee.token);
          expect(res.status).toBe(400);
          expect(body(res)).toContain('attendance day has already closed');
          expect(body(res)).toContain('19:00');
        },
      );
      tzSvc.invalidateCache();
    });

    /**
     * `Employee.timezone` beats `Branch.timezone` beats `system_timezone`. Two
     * employees punching within the same second land on DIFFERENT `date` keys —
     * the only case that proves the whole chain end to end, and one no unit spec
     * can stage because they all mock the resolver.
     */
    it('ATT-API-34 employees fourteen and minus-ten hours apart file on different days', async () => {
      const [ahead, behind] = await Promise.all([
        ctx
          .http()
          .post(`/attendances/check-in/${fx.remoteAheadId}`)
          .set(bearer(fx.hr.token))
          .send({}),
        ctx
          .http()
          .post(`/attendances/check-in/${fx.remoteBehindId}`)
          .set(bearer(fx.hr.token))
          .send({}),
      ]);
      expect(ahead.status).toBe(201);
      expect(behind.status).toBe(201);

      const rows = await ctx.prisma.attendance.findMany({
        where: { employeeId: { in: [fx.remoteAheadId, fx.remoteBehindId] } },
        select: { employeeId: true, date: true },
      });
      expect(rows).toHaveLength(2);
      const aheadDate = rows.find((r) => r.employeeId === fx.remoteAheadId)!.date;
      const behindDate = rows.find(
        (r) => r.employeeId === fx.remoteBehindId,
      )!.date;
      // A 24-hour spread cannot land on the same calendar key at every hour of
      // the day, but it can at some — so the assertion is that the resolver used
      // each employee's own zone, not that the keys always differ.
      const spread = Math.abs(aheadDate.getTime() - behindDate.getTime());
      expect(spread === 0 || spread === 86_400_000).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('the ESS reads', () => {
    it('ATT-API-35 GET /today reflects an open session', async () => {
      await checkIn(fx.employee.token);
      const res = await ctx
        .http()
        .get('/attendances/today')
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);
      expect(dataOf(res).checkIn).toBeTruthy();
    });

    it('ATT-API-36 GET /my is self-scoped for every role', async () => {
      const res = await ctx
        .http()
        .get('/attendances/my')
        .set(bearer(fx.employee.token));
      expect(res.status).toBe(200);
      const rows = Array.isArray(dataOf(res)) ? dataOf(res) : dataOf(res).data;
      if (Array.isArray(rows)) {
        expect(rows.every((r: any) => r.employeeId === fx.puncherId)).toBe(true);
      }
    });

    it('ATT-API-37 GET /:id lets an employee read their own row and refuses a colleague’s', async () => {
      await checkIn(fx.employee.token);
      const own = await ctx.prisma.attendance.findFirst({
        where: { employeeId: fx.puncherId },
        orderBy: { createdAt: 'desc' },
      });

      const mine = await ctx
        .http()
        .get(`/attendances/${own!.id}`)
        .set(bearer(fx.employee.token));
      expect(mine.status).toBe(200);

      // The self-check on THIS door is the one the sibling `employee/:id` route
      // is missing (A2) — asserting it here is what makes that a gap rather than
      // a design.
      const theirs = await ctx
        .http()
        .get(`/attendances/${own!.id}`)
        .set(bearer(fx.otherEmployee.token));
      expect(theirs.status).toBe(403);
    });
  });
});
