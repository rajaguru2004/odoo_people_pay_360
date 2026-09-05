import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupScheduleFixtures,
  ScheduleFixtures,
  RESERVED,
  freeDate,
  atUtc,
} from './utils/schedule-fixtures';
import { bearer } from './utils/settings';

/**
 * Time & Schedules — bulk schedule generation.
 *
 * `POST /calendar/schedules/bulk` is how a month of roster gets built: the
 * modal expands an employee multi-select × a date range × skipped weekdays into
 * a flat array and posts it in one request. The expansion happens entirely in
 * the CLIENT (`BulkScheduleModal.tsx`) — the server receives a plain list and
 * knows nothing about ranges or skip-days — so "the range was expanded
 * correctly" is a browser case and everything here is about what the server
 * does with the list it is handed.
 *
 * The defining property, and a deliberate product decision rather than a defect:
 * **bulk is not transactional.** Rows are attempted one at a time and the
 * response reports `success`, `failed` and one error object per failure. A
 * partial result IS the contract — a month's roster where one person is on leave
 * for two days should produce the other 20 days, not refuse the lot. BULK-API-05
 * asserts that explicitly so nobody "fixes" it into a transaction without
 * meeting the decision first.
 *
 * This spec owns `freeDate(150..209)` — 2026-07-29 to 2026-09-26.
 */
describe('Time & Schedules — bulk creation (e2e)', () => {
  let ctx: E2EContext;
  let fx: ScheduleFixtures;

  const body = (res: any) => JSON.stringify(res.body);

  const DATE_BASE = 150;
  let dateSeq = 0;
  const nextDate = () => freeDate(DATE_BASE + dateSeq++);

  /**
   * Bulk does not return the ids it created, so teardown works by date window
   * rather than by id: every row this spec can possibly have written for a
   * fixture employee falls inside its own `freeDate` block, plus the handful of
   * cases that deliberately aim outside it.
   */
  const WINDOW_START = new Date(`${freeDate(DATE_BASE)}T00:00:00.000Z`);
  const WINDOW_END = new Date(`${freeDate(DATE_BASE + 59)}T00:00:00.000Z`);
  let fixtureEmployeeIds: string[] = [];

  const item = (
    employeeId: string,
    date: string,
    over: Record<string, unknown> = {},
  ) => ({
    employeeId,
    date,
    shiftType: 'FULL_DAY',
    startTime: atUtc(date, '09:00'),
    endTime: atUtc(date, '18:00'),
    ...over,
  });

  const bulk = (schedules: unknown[], token?: string) =>
    ctx
      .http()
      .post('/calendar/schedules/bulk')
      .set(bearer(token ?? fx.admin.token))
      .send({ schedules });

  const rowsFor = (employeeId: string) =>
    ctx.prisma.workSchedule.findMany({
      where: { employeeId, date: { gte: WINDOW_START, lte: WINDOW_END } },
      orderBy: { date: 'asc' },
    });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupScheduleFixtures(ctx);
    fixtureEmployeeIds = [
      fx.staffAId,
      fx.staffNoContractId,
      fx.staffInactiveId,
      fx.staffOnLeaveId,
      fx.staffFlexibleId,
      fx.staffOtherDeptId,
      fx.staffBId,
    ];
  }, 120000);

  afterEach(async () => {
    await ctx.prisma.workSchedule.deleteMany({
      where: {
        employeeId: { in: fixtureEmployeeIds },
        date: { gte: WINDOW_START, lte: WINDOW_END },
      },
    });
  });

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // The generation itself
  // ══════════════════════════════════════════════════════════════════════════
  describe('BULK-API-01..06 — generation', () => {
    it('BULK-API-01 creates 3 employees × 5 days as exactly 15 rows', async () => {
      const employees = [
        fx.staffAId,
        fx.staffNoContractId,
        fx.staffOtherDeptId,
      ];
      const dates = [
        nextDate(),
        nextDate(),
        nextDate(),
        nextDate(),
        nextDate(),
      ];
      const payload = employees.flatMap((e) => dates.map((d) => item(e, d)));

      const res = await bulk(payload);

      expect(res.status).toBe(201);
      expect(res.body.data.success).toBe(15);
      expect(res.body.data.failed).toBe(0);
      expect(res.body.data.errors).toEqual([]);
      expect(res.body.message).toContain('15/15');
      // The counters agree with the database, not merely with themselves.
      for (const employeeId of employees) {
        expect(await rowsFor(employeeId)).toHaveLength(5);
      }
    });

    it('BULK-API-02 creates a single-item payload', async () => {
      const res = await bulk([item(fx.staffAId, nextDate())]);

      expect(res.status).toBe(201);
      expect(res.body.data.success).toBe(1);
      expect(await rowsFor(fx.staffAId)).toHaveLength(1);
    });

    it('BULK-API-03 writes the shift shape each type implies', async () => {
      const fixedDate = nextDate();
      const flexibleDate = nextDate();
      const res = await bulk([
        item(fx.staffAId, fixedDate, {
          shiftType: 'NIGHT',
          startTime: atUtc(fixedDate, '22:00'),
          endTime: atUtc(fixedDate, '23:59'),
        }),
        {
          employeeId: fx.staffAId,
          date: flexibleDate,
          shiftType: 'FLEXIBLE',
          requiredHours: 7.5,
        },
      ]);

      expect(res.body.data.success).toBe(2);
      const rows = await rowsFor(fx.staffAId);
      const night = rows.find((r) => r.shiftType === 'NIGHT');
      const flexible = rows.find((r) => r.shiftType === 'FLEXIBLE');

      expect(night?.requiredHours).toBeNull();
      expect(night?.startTime).not.toBeNull();
      expect(flexible?.startTime).toBeNull();
      expect(flexible?.endTime).toBeNull();
      expect(Number(flexible?.requiredHours)).toBe(7.5);
    });

    it('BULK-API-04 refuses a FLEXIBLE item with no requiredHours at the DTO', async () => {
      const res = await bulk([
        { employeeId: fx.staffAId, date: nextDate(), shiftType: 'FLEXIBLE' },
      ]);

      expect(res.status).toBe(400);
      expect(body(res)).toContain('requiredHours');
      expect(await rowsFor(fx.staffAId)).toHaveLength(0);
    });

    it('BULK-API-05 DECISION: bulk is not transactional — good rows survive bad ones', async () => {
      // Four distinct failure reasons alongside two rows that must still land.
      // This is the case that documents the decision: if bulk ever becomes
      // transactional, this goes red and the change has to be argued rather
      // than slipped in.
      const goodA = nextDate();
      const goodB = nextDate();
      const conflictDate = nextDate();
      const outsideContract = '2027-08-01';

      // Pre-existing row so one item collides with something already there.
      await ctx.prisma.workSchedule.create({
        data: {
          employeeId: fx.staffAId,
          date: new Date(`${conflictDate}T00:00:00.000Z`),
          shiftType: 'FULL_DAY',
          startTime: new Date(atUtc(conflictDate, '09:00')),
          endTime: new Date(atUtc(conflictDate, '18:00')),
        },
      });

      const res = await bulk([
        item(fx.staffAId, goodA),
        item(fx.staffOnLeaveId, RESERVED.leaveMiddle), // approved leave
        item(fx.staffAId, conflictDate), // conflicts with the row above
        item(fx.staffAId, outsideContract), // outside the contract window
        item(fx.staffInactiveId, nextDate()), // not an ACTIVE employee
        item(fx.staffNoContractId, goodB),
      ]);

      expect(res.status).toBe(201);
      expect(res.body.data.success).toBe(2);
      expect(res.body.data.failed).toBe(4);
      expect(res.body.data.errors).toHaveLength(4);

      // Each failure names the rule it broke, and carries the employee and date
      // so the modal can point at the offending row.
      const reasons = res.body.data.errors.map((e: any) => e.error);
      expect(reasons).toEqual(
        expect.arrayContaining([
          'Leave day has been approved',
          'Work schedule conflict',
          'Work date is outside the contract period',
          'Employee is not in active status',
        ]),
      );
      res.body.data.errors.forEach((e: any) => {
        expect(e.employeeId).toBeTruthy();
        expect(e.date).toBeTruthy();
      });

      // And the two good rows really are in the database.
      expect(await rowsFor(fx.staffNoContractId)).toHaveLength(1);
      const staffARows = await rowsFor(fx.staffAId);
      expect(staffARows.map((r) => r.date.toISOString().slice(0, 10))).toEqual(
        expect.arrayContaining([goodA, conflictDate]),
      );
    });

    it('BULK-API-06 refuses a duplicate (employeeId, date) pair INSIDE one payload', async () => {
      // The second row conflicts with the first, which the same request just
      // created. This works only because the rows are attempted sequentially —
      // and it is the in-request half of the T5 race that SCH-API-52 pins.
      const date = nextDate();
      const res = await bulk([item(fx.staffAId, date), item(fx.staffAId, date)]);

      expect(res.body.data.success).toBe(1);
      expect(res.body.data.failed).toBe(1);
      expect(res.body.data.errors[0].error).toBe('Work schedule conflict');
      expect(await rowsFor(fx.staffAId)).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Payload boundaries
  // ══════════════════════════════════════════════════════════════════════════
  describe('BULK-API-07..13 — payload boundaries', () => {
    it('BULK-API-07 FIXED (T8): an empty schedules array is a 400', async () => {
      // `@IsArray()` had no `@ArrayNotEmpty()`, and the service computes its
      // leave-lookup window with `Math.min(...[])` — which is `Infinity`, so
      // `new Date(Infinity)` is an Invalid Date and Prisma threw. An empty list
      // is a no-op request, not a server fault.
      const res = await bulk([]);

      expect(res.status).toBe(400);
      expect(body(res)).toContain('schedules');
    });

    it('BULK-API-08 refuses a missing or non-array schedules property', async () => {
      const missing = await ctx
        .http()
        .post('/calendar/schedules/bulk')
        .set(bearer(fx.admin.token))
        .send({});
      const notArray = await ctx
        .http()
        .post('/calendar/schedules/bulk')
        .set(bearer(fx.admin.token))
        .send({ schedules: 'nope' });

      expect(missing.status).toBe(400);
      expect(notArray.status).toBe(400);
    });

    it('BULK-API-09 FIXED (T9): more than 500 rows is refused at the DTO', async () => {
      // The client already warned above 500 rows
      // (`BulkScheduleModal.tsx:252`); the server accepted any N and did per-row
      // awaits with an N+1 conflict query and no transaction, so an unbounded
      // array was unbounded work. The two now describe the same boundary.
      //
      // Refused BEFORE the handler runs, which is the point: the old behaviour
      // was 501 round trips for a request that should never have been started.
      const date = nextDate();
      const tooMany = await bulk(
        Array.from({ length: 501 }, () => item(fx.staffAId, date)),
      );

      expect(tooMany.status).toBe(400);
      expect(await rowsFor(fx.staffAId)).toHaveLength(0);
    });

    it('BULK-API-09c accepts a payload at exactly the cap', async () => {
      // The boundary is inclusive, and asserted because a cap that was off by
      // one would look identical from the rejection side. 500 rows on ONE date
      // keeps it cheap: the first lands, the rest collide.
      const date = nextDate();
      const atCap = await bulk(
        Array.from({ length: 500 }, () => item(fx.staffAId, date)),
      );

      expect(atCap.status).toBe(201);
      expect(atCap.body.data.success).toBe(1);
      expect(atCap.body.data.failed).toBe(499);
    });

    it('BULK-API-10 a malformed item rejects the whole request before anything is written', async () => {
      // `@ValidateNested({ each: true })` runs before the handler, so a bad row
      // in position 2 must stop row 1 from being created. Without this the
      // partial-failure contract would be indistinguishable from "half the
      // request was silently validated".
      const goodDate = nextDate();
      const res = await bulk([
        item(fx.staffAId, goodDate),
        { employeeId: 'not-a-uuid', date: 'never', shiftType: 'MOONLIGHT' },
      ]);

      expect(res.status).toBe(400);
      expect(await rowsFor(fx.staffAId)).toHaveLength(0);
    });

    it('BULK-API-11 FIXED (T10): isWorkDay: false survives a bulk create', async () => {
      // `BulkScheduleItem` had no `isWorkDay` field and the service hardcoded
      // `isWorkDay: true`, unlike single create — and with
      // `forbidNonWhitelisted` on, sending the flag was a 400 rather than being
      // quietly dropped. So a rostered non-working day was expressible through
      // the single door and UNREACHABLE through the one a whole month gets
      // built with.
      const date = nextDate();
      const res = await bulk([item(fx.staffAId, date, { isWorkDay: false })]);

      expect(res.status).toBe(201);
      expect(res.body.data.success).toBe(1);
      const rows = await rowsFor(fx.staffAId);
      expect(rows[0]?.isWorkDay).toBe(false);
    });

    it('BULK-API-12 every bulk row defaults to a working day', async () => {
      // The consequence of T10, stated positively: whatever the roster meant,
      // what got stored is a working day.
      const res = await bulk([item(fx.staffAId, nextDate())]);

      expect(res.body.data.success).toBe(1);
      const rows = await rowsFor(fx.staffAId);
      expect(rows[0].isWorkDay).toBe(true);
    });

    it('BULK-API-13 accepts notes per row and stores them', async () => {
      const date = nextDate();
      const res = await bulk([item(fx.staffAId, date, { notes: 'Week 32' })]);

      expect(res.body.data.success).toBe(1);
      const rows = await rowsFor(fx.staffAId);
      expect(rows[0].notes).toBe('Week 32');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Per-row rules — the same rules single create enforces
  // ══════════════════════════════════════════════════════════════════════════
  describe('BULK-API-14..22 — per-row rules', () => {
    it('BULK-API-14 reports an unknown employee as a row failure, not a request failure', async () => {
      // Single create answers 404 for the same input. Bulk cannot, because the
      // other rows may be fine — so the failure is demoted to a row error. The
      // asymmetry is intentional and worth pinning.
      const res = await bulk([
        item(fx.staffAId, nextDate()),
        item('00000000-0000-4000-8000-000000000000', nextDate()),
      ]);

      expect(res.status).toBe(201);
      expect(res.body.data.success).toBe(1);
      expect(res.body.data.errors[0].error).toBe('Employee not found');
    });

    it('BULK-API-15 refuses each day of an approved leave', async () => {
      const res = await bulk([
        item(fx.staffOnLeaveId, RESERVED.leaveStart),
        item(fx.staffOnLeaveId, RESERVED.leaveMiddle),
        item(fx.staffOnLeaveId, RESERVED.leaveEnd),
      ]);

      expect(res.body.data.success).toBe(0);
      expect(res.body.data.failed).toBe(3);
      res.body.data.errors.forEach((e: any) =>
        expect(e.error).toBe('Leave day has been approved'),
      );
    });

    it('BULK-API-16 allows the days either side of an approved leave', async () => {
      const res = await bulk([
        item(fx.staffOnLeaveId, '2026-06-09'),
        item(fx.staffOnLeaveId, '2026-06-13'),
      ]);

      expect(res.body.data.success).toBe(2);
      // These fall outside the spec's own date window, so clean them here.
      await ctx.prisma.workSchedule.deleteMany({
        where: {
          employeeId: fx.staffOnLeaveId,
          date: {
            gte: new Date('2026-06-09T00:00:00.000Z'),
            lte: new Date('2026-06-13T00:00:00.000Z'),
          },
        },
      });
    });

    it('BULK-API-17 enforces the contract window at both ends', async () => {
      const res = await bulk([
        item(fx.staffAId, '2025-12-31'),
        item(fx.staffAId, '2027-01-01'),
      ]);

      expect(res.body.data.failed).toBe(2);
      res.body.data.errors.forEach((e: any) =>
        expect(e.error).toBe('Work date is outside the contract period'),
      );
    });

    it('BULK-API-18 leaves an employee with no contract unbounded', async () => {
      // The same conditional rule single create applies (SCH-API-08): no ACTIVE
      // contract means no window to fall outside of.
      const far = '2027-08-15';
      const res = await bulk([item(fx.staffNoContractId, far)]);

      expect(res.body.data.success).toBe(1);
      await ctx.prisma.workSchedule.deleteMany({
        where: {
          employeeId: fx.staffNoContractId,
          date: new Date(`${far}T00:00:00.000Z`),
        },
      });
    });

    it('BULK-API-19 refuses an inverted window as a row error', async () => {
      const date = nextDate();
      const res = await bulk([
        item(fx.staffAId, date, {
          startTime: atUtc(date, '18:00'),
          endTime: atUtc(date, '09:00'),
        }),
      ]);

      expect(res.body.data.failed).toBe(1);
      expect(res.body.data.errors[0].error).toBe('Invalid time');
    });

    it('BULK-API-20 applies the FLEXIBLE date-level exclusivity rule (D3)', async () => {
      // Same rule as single create, reached through the batch door: a flexible
      // day cannot share its date with anything.
      const date = nextDate();
      const res = await bulk([
        { employeeId: fx.staffAId, date, shiftType: 'FLEXIBLE', requiredHours: 8 },
        item(fx.staffAId, date),
      ]);

      expect(res.body.data.success).toBe(1);
      expect(res.body.data.failed).toBe(1);
      expect(res.body.data.errors[0].error).toBe('Work schedule conflict');
    });

    it('BULK-API-21 allows two non-overlapping shifts on one day', async () => {
      // The complement of BULK-API-06: a split day is legitimate, and bulk must
      // not treat "same employee, same date" as automatically a conflict.
      const date = nextDate();
      const res = await bulk([
        item(fx.staffAId, date, {
          shiftType: 'CUSTOM',
          startTime: atUtc(date, '09:00'),
          endTime: atUtc(date, '12:00'),
        }),
        item(fx.staffAId, date, {
          shiftType: 'CUSTOM',
          startTime: atUtc(date, '13:00'),
          endTime: atUtc(date, '17:00'),
        }),
      ]);

      expect(res.body.data.success).toBe(2);
      expect(await rowsFor(fx.staffAId)).toHaveLength(2);
    });

    it('BULK-API-22 FIXED (T13): a bulk run is on the audit record', async () => {
      // Schedules created, nothing on the record. Same root cause as
      // SCH-API-51 — no `@AuditResource` on the controller — but worth its own
      // case because bulk is the highest-volume write in the module and the one
      // most likely to be asked about after the fact.
      const before = await ctx.prisma.auditLog.count({
        where: { resourceType: 'WorkSchedule', userId: fx.admin.userId },
      });

      const res = await bulk([
        item(fx.staffAId, nextDate()),
        item(fx.staffAId, nextDate()),
        item(fx.staffAId, nextDate()),
      ]);
      expect(res.body.data.success).toBe(3);

      const after = await ctx.prisma.auditLog.count({
        where: { resourceType: 'WorkSchedule', userId: fx.admin.userId },
      });
      expect(after).toBeGreaterThan(before);
    });
  });
});
