import { bootE2EApp, E2EContext } from './utils/e2e-app';
import {
  setupScheduleFixtures,
  ScheduleFixtures,
  CONTRACT_START,
  CONTRACT_END,
  RESERVED,
  freeDate,
  atUtc,
} from './utils/schedule-fixtures';
import { bearer } from './utils/settings';
import { ShiftType as PrismaShiftType } from '@prisma/client';
import { ShiftType as DtoShiftType } from '../src/calendar/dto/create-schedule.dto';

/**
 * Time & Schedules — the `/calendar/schedules/*` write surface, end to end.
 *
 * `WorkSchedule` is one row per employee per date and it is the only model in
 * the feature: there is no template, no roster and no pattern generator, so
 * every rule the product has about when someone is expected at work is enforced
 * in `calendar.service.ts` at create or update time. This suite is the record of
 * those rules — the contract window, the approved-leave refusal, the employee
 * status gate, the conflict matrix, and the shape each of the six `ShiftType`
 * values produces in the database.
 *
 * Layer assignment (plan §4.1): everything here is "the server refused". Whether
 * the user was TOLD why is a browser case and lives in
 * `e2e/specs/lifecycle/time-schedule-shifts.spec.ts`. Nothing in this file
 * asserts a message reaching a screen, and nothing there re-asserts a rule.
 *
 * Cases marked `FIXED (Tn)` were written as PINS first — an assertion of the
 * wrong behaviour plus an `it.failing` twin naming the behaviour we wanted —
 * and collapsed once the fix landed, which is the convention
 * `organization-branch.e2e-spec.ts:15-18` established and what proves the fix
 * is real rather than asserted into existence. The `Tn` refers to the plan's
 * findings register; T7 is recorded at SCH-API-40 as investigated and NOT a
 * defect.
 *
 * Date discipline: `WorkSchedule` has one row per employee per date, so a case
 * that reuses a date another case already wrote collides with it rather than
 * with the rule under test. Every date here comes from `freeDate(n)` with
 * `n` in THIS SPEC'S RANGE — see `DATE_BASE` below.
 */
describe('Time & Schedules — schedule CRUD and rules (e2e)', () => {
  let ctx: E2EContext;
  let fx: ScheduleFixtures;

  const body = (res: any) => JSON.stringify(res.body);

  /**
   * This spec owns `freeDate(0..89)` — 2026-03-01 to 2026-05-29. The rest of the
   * window is allocated: scope 90..149, bulk 150..209, calendar-read 210..269,
   * cross-module 270..305 (the contract ends 2026-12-31, which is `freeDate(305)`).
   * Overlapping ranges would make one spec's leftover row the next spec's
   * phantom conflict, and `maxWorkers: 1` guarantees they share one database.
   *
   * The `RESERVED` dates sit inside the scope block but are NOT excluded from
   * it: they are occupied for one specific employee each (`scheduleBId` on
   * `staffB`, `flexibleScheduleId` on `staffFlexible`, the approved leave on
   * `staffOnLeave`), and conflicts are per employee-day. Only a case that pairs
   * a reserved date with its own employee collides.
   *
   * Budget rather than a hard block: this spec consumes roughly 70 of its 90
   * dates, because several `it.each` tables draw one per row.
   */
  const DATE_BASE = 0;
  let dateSeq = 0;
  /** A date in this spec's range that no earlier case in this file has used. */
  const nextDate = () => freeDate(DATE_BASE + dateSeq++);

  /** Every schedule a case creates, so `afterEach` can undo it. */
  const created: string[] = [];

  /** POST a schedule as ADMIN and register the row for teardown. */
  const create = async (payload: Record<string, unknown>, token?: string) => {
    const res = await ctx
      .http()
      .post('/calendar/schedules')
      .set(bearer(token ?? fx.admin.token))
      .send(payload);
    const id = res.body?.data?.id;
    if (id) created.push(id);
    return res;
  };

  /** A valid FULL_DAY 09:00-18:00 payload for `staffA` on `date`. */
  const fullDay = (date: string, over: Record<string, unknown> = {}) => ({
    employeeId: fx.staffAId,
    date,
    shiftType: 'FULL_DAY',
    startTime: atUtc(date, '09:00'),
    endTime: atUtc(date, '18:00'),
    ...over,
  });

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupScheduleFixtures(ctx);
  }, 120000);

  afterEach(async () => {
    // "One schedule per employee per date" means a leftover row refuses the next
    // create with a conflict that looks exactly like a broken rule. Rows are
    // removed by id rather than by employee so the fixture's own two schedules
    // (`scheduleBId`, `flexibleScheduleId`) survive — cases assert against them.
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
  // Create — the happy shapes
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCH-API-01..08 — create', () => {
    it('SCH-API-01 creates a minimal fixed-window shift', async () => {
      const date = nextDate();
      const res = await create(fullDay(date));

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.employeeId).toBe(fx.staffAId);
      expect(res.body.data.shiftType).toBe('FULL_DAY');
      // Defaults the DTO leaves out.
      expect(res.body.data.isWorkDay).toBe(true);
      expect(res.body.data.notes).toBeNull();
      // A fixed-window shift carries no target-hours figure.
      expect(res.body.data.requiredHours).toBeNull();
      // The response includes the employee, which the shift screen renders.
      expect(res.body.data.employee.id).toBe(fx.staffAId);
    });

    it('SCH-API-02 creates a maximal shift with every optional field set', async () => {
      const date = nextDate();
      const res = await create(
        fullDay(date, { isWorkDay: false, notes: 'Maximal payload' }),
      );

      expect(res.status).toBe(201);
      expect(res.body.data.isWorkDay).toBe(false);
      expect(res.body.data.notes).toBe('Maximal payload');
    });

    it.each([
      ['MORNING', '06:00', '14:00'],
      ['AFTERNOON', '14:00', '22:00'],
      ['FULL_DAY', '09:00', '18:00'],
      ['NIGHT', '22:00', '23:30'],
      ['CUSTOM', '10:15', '15:45'],
    ])(
      'SCH-API-03 stores a %s shift with its window and no requiredHours',
      async (shiftType, from, to) => {
        const date = nextDate();
        const res = await create({
          employeeId: fx.staffAId,
          date,
          shiftType,
          startTime: atUtc(date, from),
          endTime: atUtc(date, to),
        });

        expect(res.status).toBe(201);
        expect(res.body.data.shiftType).toBe(shiftType);
        expect(res.body.data.startTime).toBe(atUtc(date, from));
        expect(res.body.data.endTime).toBe(atUtc(date, to));
        // The column is nulled for every non-flexible type, not merely omitted
        // from the response — the shift screen reads it to decide which pair of
        // fields to render.
        expect(res.body.data.requiredHours).toBeNull();
      },
    );

    it('SCH-API-04 stores a FLEXIBLE shift as target hours with null times', async () => {
      const date = nextDate();
      const res = await create({
        employeeId: fx.staffAId,
        date,
        shiftType: 'FLEXIBLE',
        requiredHours: 7.5,
      });

      expect(res.status).toBe(201);
      expect(res.body.data.shiftType).toBe('FLEXIBLE');
      expect(res.body.data.startTime).toBeNull();
      expect(res.body.data.endTime).toBeNull();
      expect(Number(res.body.data.requiredHours)).toBe(7.5);
    });

    it('SCH-API-05 ignores startTime/endTime supplied alongside FLEXIBLE', async () => {
      // The client sends a full payload on every save, so a user who switches
      // the type in the modal without clearing the window still sends one. The
      // stored row must be the flexible SHAPE regardless.
      const date = nextDate();
      const res = await create({
        employeeId: fx.staffAId,
        date,
        shiftType: 'FLEXIBLE',
        requiredHours: 6,
        startTime: atUtc(date, '09:00'),
        endTime: atUtc(date, '18:00'),
      });

      expect(res.status).toBe(201);
      expect(res.body.data.startTime).toBeNull();
      expect(res.body.data.endTime).toBeNull();
      expect(Number(res.body.data.requiredHours)).toBe(6);
    });

    it('SCH-API-06 accepts an overnight shift that ends the next morning', async () => {
      const date = nextDate();
      const res = await create({
        employeeId: fx.staffAId,
        date,
        shiftType: 'NIGHT',
        startTime: atUtc(date, '22:00'),
        // The window crosses midnight; the DATE is still the day it began.
        endTime: `${freeDate(DATE_BASE + dateSeq)}T06:00:00.000Z`,
      });

      expect(res.status).toBe(201);
      expect(res.body.data.shiftType).toBe('NIGHT');
    });

    it('SCH-API-07 accepts isWorkDay: false — a rostered non-working day', async () => {
      const date = nextDate();
      const res = await create(fullDay(date, { isWorkDay: false }));

      expect(res.status).toBe(201);
      expect(res.body.data.isWorkDay).toBe(false);
      const row = await ctx.prisma.workSchedule.findUnique({
        where: { id: res.body.data.id },
      });
      expect(row?.isWorkDay).toBe(false);
    });

    it('SCH-API-08 creates for an employee with no contract at all', async () => {
      // Contract validation is conditional: no ACTIVE contract means no window
      // to be outside of, which is deliberate — see the twin at SCH-API-13.
      const date = nextDate();
      const res = await create({
        ...fullDay(date),
        employeeId: fx.staffNoContractId,
      });

      expect(res.status).toBe(201);
      expect(res.body.data.employeeId).toBe(fx.staffNoContractId);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Create — the refusals
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCH-API-09..20 — create refusals', () => {
    it('SCH-API-09 refuses an unknown employee with 404', async () => {
      const res = await create({
        ...fullDay(nextDate()),
        employeeId: '00000000-0000-4000-8000-000000000000',
      });

      expect(res.status).toBe(404);
      expect(body(res)).toContain('Employee not found');
    });

    it('SCH-API-10 refuses an INACTIVE employee', async () => {
      const res = await create({
        ...fullDay(nextDate()),
        employeeId: fx.staffInactiveId,
      });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('active employees');
    });

    it('SCH-API-11 accepts the first and last day of the contract window', async () => {
      // The boundary is inclusive at both ends. Asserted as one case because
      // the pair is the rule; splitting them hides that they must agree.
      const first = await create({
        ...fullDay(CONTRACT_START),
        startTime: atUtc(CONTRACT_START, '09:00'),
        endTime: atUtc(CONTRACT_START, '18:00'),
      });
      const last = await create({
        ...fullDay(CONTRACT_END),
        startTime: atUtc(CONTRACT_END, '09:00'),
        endTime: atUtc(CONTRACT_END, '18:00'),
      });

      expect(first.status).toBe(201);
      expect(last.status).toBe(201);
    });

    it('SCH-API-12 refuses the day before the contract starts', async () => {
      const res = await create({
        ...fullDay('2025-12-31'),
        startTime: atUtc('2025-12-31', '09:00'),
        endTime: atUtc('2025-12-31', '18:00'),
      });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('contract start date');
    });

    it('SCH-API-13 refuses the day after the contract ends', async () => {
      const res = await create({
        ...fullDay('2027-01-01'),
        startTime: atUtc('2027-01-01', '09:00'),
        endTime: atUtc('2027-01-01', '18:00'),
      });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('contract end date');
    });

    it.each([
      ['first', RESERVED.leaveStart],
      ['middle', RESERVED.leaveMiddle],
      ['last', RESERVED.leaveEnd],
    ])(
      'SCH-API-14 refuses a schedule on the %s day of an approved leave',
      async (_label, date) => {
        // The leave window is inclusive at both ends; a rule that only checked
        // the interior would let someone be rostered on the day they left.
        const res = await create({
          employeeId: fx.staffOnLeaveId,
          date,
          shiftType: 'FULL_DAY',
          startTime: atUtc(date, '09:00'),
          endTime: atUtc(date, '18:00'),
        });

        expect(res.status).toBe(400);
        expect(body(res)).toContain('leave day');
        // The refusal names the leave type, which is what makes it actionable.
        expect(body(res)).toContain('ANNUAL');
      },
    );

    it('SCH-API-15 allows the day either side of an approved leave', async () => {
      // The complement of SCH-API-14: the guard must not spill past the window.
      const dayBefore = '2026-06-09';
      const dayAfter = '2026-06-13';
      const before = await create({
        employeeId: fx.staffOnLeaveId,
        date: dayBefore,
        shiftType: 'FULL_DAY',
        startTime: atUtc(dayBefore, '09:00'),
        endTime: atUtc(dayBefore, '18:00'),
      });
      const after = await create({
        employeeId: fx.staffOnLeaveId,
        date: dayAfter,
        shiftType: 'FULL_DAY',
        startTime: atUtc(dayAfter, '09:00'),
        endTime: atUtc(dayAfter, '18:00'),
      });

      expect(before.status).toBe(201);
      expect(after.status).toBe(201);
    });

    it('SCH-API-16 refuses startTime equal to endTime', async () => {
      const date = nextDate();
      const res = await create({
        ...fullDay(date),
        startTime: atUtc(date, '09:00'),
        endTime: atUtc(date, '09:00'),
      });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('Start time must be before end time');
    });

    it('SCH-API-17 refuses endTime before startTime', async () => {
      const date = nextDate();
      const res = await create({
        ...fullDay(date),
        startTime: atUtc(date, '18:00'),
        endTime: atUtc(date, '09:00'),
      });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('Start time must be before end time');
    });

    it('SCH-API-18 refuses a flexible shift with no requiredHours', async () => {
      const res = await create({
        employeeId: fx.staffAId,
        date: nextDate(),
        shiftType: 'FLEXIBLE',
      });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('requiredHours');
    });

    it('SCH-API-19 refuses a non-flexible shift with no window', async () => {
      const res = await create({
        employeeId: fx.staffAId,
        date: nextDate(),
        shiftType: 'FULL_DAY',
      });

      expect(res.status).toBe(400);
      expect(body(res)).toMatch(/startTime|endTime/);
    });

    it('SCH-API-20 refuses a property the DTO does not define', async () => {
      // `forbidNonWhitelisted` is on in `e2e-app.ts`, matching production. A
      // typo'd field must be refused, not silently dropped.
      const res = await create({ ...fullDay(nextDate()), branchId: fx.branchA });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('branchId');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DTO validation table
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCH-API-21..23 — DTO validation', () => {
    /**
     * Each row is a single field made invalid against an otherwise-valid
     * payload, so a 400 can only be attributed to the field named. Boundary
     * ACCEPTANCE is asserted separately at SCH-API-22 — a table of rejections
     * alone would pass against a DTO that rejected everything.
     */
    const rejections: Array<[string, Record<string, unknown>]> = [
      ['employeeId missing', { employeeId: undefined }],
      ['employeeId not a uuid', { employeeId: 'not-a-uuid' }],
      ['employeeId numeric', { employeeId: 12345 }],
      ['date missing', { date: undefined }],
      ['date not a date', { date: 'the first of March' }],
      ['date as a number', { date: 20260301 }],
      ['shiftType missing', { shiftType: undefined }],
      ['shiftType unknown', { shiftType: 'GRAVEYARD' }],
      ['shiftType lowercase', { shiftType: 'full_day' }],
      ['startTime not a date', { startTime: 'nine o clock' }],
      ['endTime not a date', { endTime: '' }],
      ['isWorkDay a string', { isWorkDay: 'false' }],
      ['notes a number', { notes: 42 }],
      ['notes an object', { notes: { text: 'x' } }],
    ];

    it.each(rejections)('SCH-API-21 rejects %s', async (_label, over) => {
      const date = nextDate();
      const payload: Record<string, unknown> = { ...fullDay(date), ...over };
      // `undefined` in the override means "omit the key entirely".
      Object.keys(over).forEach((k) => {
        if (over[k] === undefined) delete payload[k];
      });

      const res = await create(payload);
      expect(res.status).toBe(400);
    });

    it('SCH-API-22 accepts the boundary values the table rejects around', async () => {
      // The acceptance half of the pair above. Without it, a DTO that rejected
      // every payload would make all 14 rejection rows pass.
      const date = nextDate();
      const res = await create({
        employeeId: fx.staffAId,
        date,
        shiftType: 'CUSTOM',
        startTime: atUtc(date, '00:00'),
        endTime: atUtc(date, '23:59'),
        isWorkDay: true,
        notes: '',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.notes).toBe('');
    });

    it('SCH-API-23 accepts a bare YYYY-MM-DD date as well as a full ISO string', async () => {
      // The shift screen sends `YYYY-MM-DD`; the MCP tool sends a full ISO
      // timestamp. `@IsDateString()` takes both and they must mean the same day.
      const date = nextDate();
      const res = await create({
        ...fullDay(date),
        date: `${date}T00:00:00.000Z`,
      });

      expect(res.status).toBe(201);
      const row = await ctx.prisma.workSchedule.findUnique({
        where: { id: res.body.data.id },
      });
      expect(row?.date.toISOString().slice(0, 10)).toBe(date);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Conflict matrix
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCH-API-24..30 — conflicts', () => {
    /** Seed a fixed-window shift for `staffA` and return its date. */
    const seedShift = async (from: string, to: string) => {
      const date = nextDate();
      const res = await create({
        employeeId: fx.staffAId,
        date,
        shiftType: 'CUSTOM',
        startTime: atUtc(date, from),
        endTime: atUtc(date, to),
      });
      expect(res.status).toBe(201);
      return date;
    };

    const second = (date: string, from: string, to: string) =>
      create({
        employeeId: fx.staffAId,
        date,
        shiftType: 'CUSTOM',
        startTime: atUtc(date, from),
        endTime: atUtc(date, to),
      });

    it('SCH-API-24 refuses a shift overlapping the head of an existing one', async () => {
      const date = await seedShift('09:00', '12:00');
      const res = await second(date, '11:00', '14:00');

      expect(res.status).toBe(400);
      expect(body(res)).toContain('overlaps');
    });

    it('SCH-API-25 refuses a shift overlapping the tail of an existing one', async () => {
      const date = await seedShift('12:00', '15:00');
      const res = await second(date, '09:00', '13:00');

      expect(res.status).toBe(400);
    });

    it('SCH-API-26 refuses a shift wholly containing an existing one', async () => {
      const date = await seedShift('12:00', '13:00');
      const res = await second(date, '09:00', '18:00');

      expect(res.status).toBe(400);
    });

    it('SCH-API-27 refuses a shift wholly contained by an existing one', async () => {
      const date = await seedShift('09:00', '18:00');
      const res = await second(date, '12:00', '13:00');

      expect(res.status).toBe(400);
    });

    it('SCH-API-28 ALLOWS two shifts that merely touch at the boundary', async () => {
      // `end == start` is a split day, not an overlap — a morning and an evening
      // shift with no gap. The interval comparison is half-open for exactly
      // this reason, and getting it wrong would refuse a legitimate roster.
      const date = await seedShift('09:00', '12:00');
      const res = await second(date, '12:00', '15:00');

      expect(res.status).toBe(201);
    });

    it('SCH-API-29 treats FLEXIBLE as date-level exclusive in both directions (D3)', async () => {
      // Decision, not defect: a flexible day has no window, so nothing can be
      // scheduled alongside it and two flexible days are redundant.
      const dateA = nextDate();
      expect(
        (
          await create({
            employeeId: fx.staffAId,
            date: dateA,
            shiftType: 'FLEXIBLE',
            requiredHours: 8,
          })
        ).status,
      ).toBe(201);

      // flexible exists → fixed refused
      const fixedAfterFlexible = await create({
        employeeId: fx.staffAId,
        date: dateA,
        shiftType: 'CUSTOM',
        startTime: atUtc(dateA, '09:00'),
        endTime: atUtc(dateA, '10:00'),
      });
      expect(fixedAfterFlexible.status).toBe(400);

      // flexible exists → another flexible refused
      const flexibleAfterFlexible = await create({
        employeeId: fx.staffAId,
        date: dateA,
        shiftType: 'FLEXIBLE',
        requiredHours: 4,
      });
      expect(flexibleAfterFlexible.status).toBe(400);

      // the reverse order: fixed exists → flexible refused
      const dateB = await seedShift('09:00', '12:00');
      const flexibleAfterFixed = await create({
        employeeId: fx.staffAId,
        date: dateB,
        shiftType: 'FLEXIBLE',
        requiredHours: 8,
      });
      expect(flexibleAfterFixed.status).toBe(400);
    });

    it('SCH-API-30 scopes conflicts to the employee AND the date', async () => {
      // The same window on a different day, and the same window on the same day
      // for a different employee, are both fine. A conflict rule that ignored
      // either dimension would make a shared roster impossible.
      const date = await seedShift('09:00', '12:00');

      const otherDay = nextDate();
      const differentDate = await create({
        employeeId: fx.staffAId,
        date: otherDay,
        shiftType: 'CUSTOM',
        startTime: atUtc(otherDay, '09:00'),
        endTime: atUtc(otherDay, '12:00'),
      });
      const differentEmployee = await create({
        employeeId: fx.staffNoContractId,
        date,
        shiftType: 'CUSTOM',
        startTime: atUtc(date, '09:00'),
        endTime: atUtc(date, '12:00'),
      });

      expect(differentDate.status).toBe(201);
      expect(differentEmployee.status).toBe(201);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Read by id
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCH-API-31..33 — read by id', () => {
    it('SCH-API-31 returns the schedule with its employee', async () => {
      const date = nextDate();
      const { body: createdBody } = await create(fullDay(date));

      const res = await ctx
        .http()
        .get(`/calendar/schedules/${createdBody.data.id}`)
        .set(bearer(fx.admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(createdBody.data.id);
      expect(res.body.data.employee.employeeCode).toContain(fx.runId);
      expect(res.body.data.employee.department).toBeTruthy();
    });

    it('SCH-API-32 returns 404 for an unknown id without leaking anything', async () => {
      const res = await ctx
        .http()
        .get('/calendar/schedules/00000000-0000-4000-8000-000000000000')
        .set(bearer(fx.admin.token));

      expect(res.status).toBe(404);
      expect(body(res)).toContain('Work schedule not found');
      // No stack, no file path — P27 in the People phase was exactly this leak.
      expect(body(res)).not.toContain('/home/');
      expect(body(res)).not.toContain('prisma');
    });

    it('SCH-API-33 FIXED (T15): a malformed id is a 400 and leaks nothing', async () => {
      // Two defects, one case, because the fix had to be two things. The status
      // came from `ParseUUIDPipe` on the route; the BODY came from
      // `AllExceptionsFilter`, which forwarded `exception.message` for every
      // non-HttpException — and Prisma's message embeds the absolute path of the
      // checkout plus an excerpt of the failing source.
      //
      // Fixing only the pipe would have closed this trigger and left the
      // disclosure reachable from anywhere else that could provoke an internal
      // error; SCOPE-API-08d found a second trigger with no malformed input in
      // it at all. That is why the filter was fixed rather than the symptom.
      const res = await ctx
        .http()
        .get('/calendar/schedules/not-a-uuid')
        .set(bearer(fx.admin.token));

      expect(res.status).toBe(400);
      expect(body(res)).not.toContain('/home/');
      expect(body(res)).not.toContain('calendar.service.ts');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Update
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCH-API-34..40 — update', () => {
    /** A fresh shift for `staffA` to mutate, returned with its date. */
    const seedForUpdate = async () => {
      const date = nextDate();
      const res = await create(fullDay(date, { notes: 'before' }));
      expect(res.status).toBe(201);
      return { id: res.body.data.id as string, date };
    };

    const put = (id: string, payload: Record<string, unknown>) =>
      ctx
        .http()
        .put(`/calendar/schedules/${id}`)
        .set(bearer(fx.admin.token))
        .send(payload);

    it('SCH-API-34 updates the window of an existing shift', async () => {
      const { id, date } = await seedForUpdate();
      const res = await put(id, {
        employeeId: fx.staffAId,
        date,
        shiftType: 'CUSTOM',
        startTime: atUtc(date, '10:00'),
        endTime: atUtc(date, '16:00'),
      });

      expect(res.status).toBe(200);
      expect(res.body.data.startTime).toBe(atUtc(date, '10:00'));
      expect(res.body.data.endTime).toBe(atUtc(date, '16:00'));
      expect(res.body.data.shiftType).toBe('CUSTOM');
    });

    it('SCH-API-35 lets a shift keep its own slot (self-exclusion)', async () => {
      // The conflict check must exclude the row being updated, or no shift
      // could ever be edited without first being deleted.
      const { id, date } = await seedForUpdate();
      const res = await put(id, {
        employeeId: fx.staffAId,
        date,
        shiftType: 'FULL_DAY',
        startTime: atUtc(date, '09:00'),
        endTime: atUtc(date, '18:00'),
        notes: 'unchanged window, changed note',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.notes).toBe('unchanged window, changed note');
    });

    it('SCH-API-36 switching FULL_DAY → FLEXIBLE nulls the window', async () => {
      const { id, date } = await seedForUpdate();
      const res = await put(id, {
        employeeId: fx.staffAId,
        date,
        shiftType: 'FLEXIBLE',
        requiredHours: 6.5,
      });

      expect(res.status).toBe(200);
      expect(res.body.data.startTime).toBeNull();
      expect(res.body.data.endTime).toBeNull();
      expect(Number(res.body.data.requiredHours)).toBe(6.5);
    });

    it('SCH-API-37 switching FLEXIBLE → CUSTOM nulls requiredHours', async () => {
      const date = nextDate();
      const seeded = await create({
        employeeId: fx.staffAId,
        date,
        shiftType: 'FLEXIBLE',
        requiredHours: 6,
      });
      expect(seeded.status).toBe(201);

      const res = await put(seeded.body.data.id, {
        employeeId: fx.staffAId,
        date,
        shiftType: 'CUSTOM',
        startTime: atUtc(date, '11:00'),
        endTime: atUtc(date, '17:00'),
      });

      expect(res.status).toBe(200);
      expect(res.body.data.requiredHours).toBeNull();
      expect(res.body.data.startTime).toBe(atUtc(date, '11:00'));
    });

    it('SCH-API-38 refuses an inverted window on update', async () => {
      const { id, date } = await seedForUpdate();
      const res = await put(id, {
        employeeId: fx.staffAId,
        date,
        shiftType: 'CUSTOM',
        startTime: atUtc(date, '18:00'),
        endTime: atUtc(date, '09:00'),
      });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('Start time must be before end time');
    });

    it('SCH-API-39 returns 404 updating an unknown schedule', async () => {
      const res = await put('00000000-0000-4000-8000-000000000000', {
        notes: 'x',
        shiftType: 'FLEXIBLE',
        requiredHours: 8,
      });

      expect(res.status).toBe(404);
    });

    it('SCH-API-40 T7 IS NOT A DEFECT: a notes-only update succeeds and preserves the shape', async () => {
      // The plan predicted a 400 here and asked for it to be confirmed against
      // the real `ValidationPipe` before anything was "fixed" (§2, T7). It was,
      // and the prediction was wrong — this is the assertion that records why.
      //
      // The reasoning behind the prediction: `UpdateScheduleDto =
      // PartialType(CreateScheduleDto)` inherits
      // `@ValidateIf(o => o.shiftType !== FLEXIBLE) @IsDateString()` on
      // `startTime`/`endTime`, and with `shiftType` omitted
      // `undefined !== 'FLEXIBLE'` is true — so `@IsDateString()` would run
      // against `undefined` and reject.
      //
      // What actually happens: `PartialType` also stamps `@IsOptional()` onto
      // every inherited property, and class-validator's `@IsOptional()` REMOVES
      // the remaining validators for that property when the value is `undefined`
      // rather than merely tolerating it. It short-circuits before `@ValidateIf`
      // is consulted, so the time fields are simply absent from validation.
      //
      // The consequence is that the service's effective-shape merge
      // (`calendar.service.ts:337-372`) IS reachable, and this case proves it:
      // a lone `notes` write must leave the type and the window exactly as they
      // were. Nothing to fix in WP-5; T7 is struck from the register.
      const { id } = await seedForUpdate();
      const res = await put(id, { notes: 'just the note' });

      expect(res.status).toBe(200);
      expect(res.body.data.notes).toBe('just the note');
      expect(res.body.data.shiftType).toBe('FULL_DAY');
      expect(res.body.data.startTime).not.toBeNull();
      expect(res.body.data.endTime).not.toBeNull();
    });

    it('SCH-API-40b partial updates work field by field, not just for notes', async () => {
      // The general form of the case above. If `@IsOptional()` ever stopped
      // short-circuiting — a class-validator upgrade, or someone "tidying" the
      // DTO by dropping PartialType — every one of these would start 400ing and
      // the shift screen would be the only client that still worked, because it
      // always sends a full payload.
      const { id } = await seedForUpdate();

      const workDayOnly = await put(id, { isWorkDay: false });
      expect(workDayOnly.status).toBe(200);
      expect(workDayOnly.body.data.isWorkDay).toBe(false);
      expect(workDayOnly.body.data.shiftType).toBe('FULL_DAY');

      const typeOnly = await put(id, { shiftType: 'MORNING' });
      expect(typeOnly.status).toBe(200);
      expect(typeOnly.body.data.shiftType).toBe('MORNING');
      // Switching between two fixed types keeps the window it already had.
      expect(typeOnly.body.data.startTime).not.toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Update — the rules create enforces and update does not (T6)
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCH-API-41..43 — update applies the same date rules as create (T6)', () => {
    const put = (id: string, payload: Record<string, unknown>) =>
      ctx
        .http()
        .put(`/calendar/schedules/${id}`)
        .set(bearer(fx.admin.token))
        .send(payload);

    it('SCH-API-41 FIXED (T6): a PUT onto an approved leave day is refused', async () => {
      // `createSchedule` refused this and `updateSchedule` checked nothing, so
      // every state create rejected was reachable by creating a legal schedule
      // and then moving it. Both doors now run the same `assertSchedulable`.
      const seedDate = nextDate();
      const seeded = await create({
        employeeId: fx.staffOnLeaveId,
        date: seedDate,
        shiftType: 'FULL_DAY',
        startTime: atUtc(seedDate, '09:00'),
        endTime: atUtc(seedDate, '18:00'),
      });
      expect(seeded.status).toBe(201);

      const res = await put(seeded.body.data.id, {
        employeeId: fx.staffOnLeaveId,
        date: RESERVED.leaveMiddle,
        shiftType: 'FULL_DAY',
        startTime: atUtc(RESERVED.leaveMiddle, '09:00'),
        endTime: atUtc(RESERVED.leaveMiddle, '18:00'),
      });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('leave day');
    });

    it('SCH-API-42 FIXED (T6): a PUT outside the contract window is refused', async () => {
      const date = nextDate();
      const seeded = await create(fullDay(date));
      expect(seeded.status).toBe(201);

      const outside = '2027-03-01';
      const res = await put(seeded.body.data.id, {
        employeeId: fx.staffAId,
        date: outside,
        shiftType: 'FULL_DAY',
        startTime: atUtc(outside, '09:00'),
        endTime: atUtc(outside, '18:00'),
      });

      expect(res.status).toBe(400);
      expect(body(res)).toContain('contract');
    });

    it('SCH-API-43 DECISION: a PUT that does not move the schedule is not re-validated', async () => {
      // The deliberate limit of the T6 fix. The shared date rules run when a PUT
      // MOVES the schedule, not on every PUT. Re-running them on an unchanged
      // date would make a note or time edit fail for a row that was perfectly
      // legal when it was written — an employee since gone inactive, a contract
      // since expired — which is a different product decision (retroactive
      // invalidation of existing roster) and not one this phase took.
      //
      // Create is still refused for an INACTIVE employee (SCH-API-10); what is
      // allowed here is adjusting a day that already exists.
      const date = nextDate();
      const seeded = await create({
        ...fullDay(date),
        employeeId: fx.staffNoContractId,
      });
      expect(seeded.status).toBe(201);

      await ctx.prisma.employee.update({
        where: { id: fx.staffNoContractId },
        data: { status: 'INACTIVE' },
      });
      try {
        const res = await put(seeded.body.data.id, {
          employeeId: fx.staffNoContractId,
          date,
          shiftType: 'CUSTOM',
          startTime: atUtc(date, '10:00'),
          endTime: atUtc(date, '16:00'),
        });

        expect(res.status).toBe(200);
      } finally {
        // Restore, or every later case using this employee inherits INACTIVE.
        await ctx.prisma.employee.update({
          where: { id: fx.staffNoContractId },
          data: { status: 'ACTIVE' },
        });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Delete
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCH-API-44..45 — delete', () => {
    it('SCH-API-44 deletes a schedule and the row is gone', async () => {
      const date = nextDate();
      const seeded = await create(fullDay(date));
      const id = seeded.body.data.id;

      const res = await ctx
        .http()
        .delete(`/calendar/schedules/${id}`)
        .set(bearer(fx.admin.token));

      expect(res.status).toBe(200);
      expect(
        await ctx.prisma.workSchedule.findUnique({ where: { id } }),
      ).toBeNull();
    });

    it('SCH-API-45 deleting twice, and deleting the unknown, both 404', async () => {
      const date = nextDate();
      const seeded = await create(fullDay(date));
      const id = seeded.body.data.id;

      await ctx
        .http()
        .delete(`/calendar/schedules/${id}`)
        .set(bearer(fx.admin.token));
      const again = await ctx
        .http()
        .delete(`/calendar/schedules/${id}`)
        .set(bearer(fx.admin.token));
      const unknown = await ctx
        .http()
        .delete('/calendar/schedules/00000000-0000-4000-8000-000000000000')
        .set(bearer(fx.admin.token));

      expect(again.status).toBe(404);
      expect(unknown.status).toBe(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Bounds, the conflicts endpoint, audit, concurrency, and the enum decision
  // ══════════════════════════════════════════════════════════════════════════
  describe('SCH-API-46..54 — bounds, conflicts endpoint, audit, duplicate rows', () => {
    it('SCH-API-46 accepts requiredHours at the sensible bounds and refuses zero', async () => {
      const half = await create({
        employeeId: fx.staffAId,
        date: nextDate(),
        shiftType: 'FLEXIBLE',
        requiredHours: 0.5,
      });
      const full = await create({
        employeeId: fx.staffAId,
        date: nextDate(),
        shiftType: 'FLEXIBLE',
        requiredHours: 24,
      });
      const zero = await create({
        employeeId: fx.staffAId,
        date: nextDate(),
        shiftType: 'FLEXIBLE',
        requiredHours: 0,
      });

      expect(half.status).toBe(201);
      expect(full.status).toBe(201);
      // `@IsPositive()` catches this one.
      expect(zero.status).toBe(400);
    });

    it('SCH-API-47 FIXED (T11): requiredHours is capped at 24', async () => {
      // The client capped at 24 and the server took anything positive, so the
      // two disagreed about what a day is — and above 999.99 the `Decimal(5,2)`
      // column turned that disagreement into a 500 at insert time.
      const atCap = await create({
        employeeId: fx.staffAId,
        date: nextDate(),
        shiftType: 'FLEXIBLE',
        requiredHours: 24,
      });
      const overCap = await create({
        employeeId: fx.staffAId,
        date: nextDate(),
        shiftType: 'FLEXIBLE',
        requiredHours: 25,
      });
      const wouldOverflow = await create({
        employeeId: fx.staffAId,
        date: nextDate(),
        shiftType: 'FLEXIBLE',
        requiredHours: 1000,
      });

      expect(atCap.status).toBe(201);
      expect(overCap.status).toBe(400);
      // The column overflow is now unreachable: refused as a value rather than
      // discovered at insert time.
      expect(wouldOverflow.status).toBe(400);
    });

    it('SCH-API-48 FIXED (T14): notes is capped at 500 characters', async () => {
      // Aligned with the cap the MCP shift tool already applied, so the field
      // has one contract regardless of which door sets it.
      const ok = await create(fullDay(nextDate(), { notes: 'x'.repeat(500) }));
      const tooLong = await create(
        fullDay(nextDate(), { notes: 'x'.repeat(501) }),
      );

      expect(ok.status).toBe(201);
      expect(tooLong.status).toBe(400);
    });

    it('SCH-API-49 FIXED (T12): conflicts/check reports real overlaps and nothing else', async () => {
      // It used to return every schedule in the range labelled `conflicts`,
      // without ever calling the overlap logic — so an ordinary roster reported
      // one conflict per day and the endpoint could not answer the only
      // question it exists to answer.
      const loneDate = nextDate();
      expect(
        (
          await create({
            employeeId: fx.staffAId,
            date: loneDate,
            shiftType: 'CUSTOM',
            startTime: atUtc(loneDate, '09:00'),
            endTime: atUtc(loneDate, '12:00'),
          })
        ).status,
      ).toBe(201);

      // A split day: two shifts, one date, no overlap. Legitimate, and the old
      // implementation called both of them conflicts.
      const splitDate = nextDate();
      const morning = await create({
        employeeId: fx.staffAId,
        date: splitDate,
        shiftType: 'CUSTOM',
        startTime: atUtc(splitDate, '09:00'),
        endTime: atUtc(splitDate, '12:00'),
      });
      const evening = await create({
        employeeId: fx.staffAId,
        date: splitDate,
        shiftType: 'CUSTOM',
        startTime: atUtc(splitDate, '13:00'),
        endTime: atUtc(splitDate, '17:00'),
      });
      expect([morning.status, evening.status]).toEqual([201, 201]);

      const res = await ctx
        .http()
        .get('/calendar/schedules/conflicts/check')
        .query({
          employeeId: fx.staffAId,
          startDate: loneDate,
          endDate: splitDate,
        })
        .set(bearer(fx.admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.hasConflicts).toBe(false);
      expect(res.body.data.conflicts).toEqual([]);
    });

    it('SCH-API-49c FIXED (T12): a genuine overlap IS reported, with both rows', async () => {
      // The other half of the pair. An endpoint that reported nothing would
      // satisfy the case above just as well, so the positive case is what makes
      // it an assertion rather than a tautology.
      //
      // The overlapping pair is written straight to the database: the service
      // refuses to CREATE an overlap, which is exactly why an endpoint that
      // DETECTS one is worth having — it finds rows that predate the rule or
      // arrived by another route.
      const date = nextDate();
      const base = {
        employeeId: fx.staffAId,
        date: new Date(`${date}T00:00:00.000Z`),
        shiftType: 'CUSTOM' as const,
      };
      created.push(
        (
          await ctx.prisma.workSchedule.create({
            data: {
              ...base,
              startTime: new Date(atUtc(date, '09:00')),
              endTime: new Date(atUtc(date, '13:00')),
            },
          })
        ).id,
      );
      created.push(
        (
          await ctx.prisma.workSchedule.create({
            data: {
              ...base,
              startTime: new Date(atUtc(date, '12:00')),
              endTime: new Date(atUtc(date, '17:00')),
            },
          })
        ).id,
      );

      const res = await ctx
        .http()
        .get('/calendar/schedules/conflicts/check')
        .query({ employeeId: fx.staffAId, startDate: date, endDate: date })
        .set(bearer(fx.admin.token));

      expect(res.body.data.hasConflicts).toBe(true);
      // Both sides of the collision, not just the later one.
      expect(res.body.data.conflicts).toHaveLength(2);
    });

    it('SCH-API-50 conflicts/check returns nothing for a range with no shifts', async () => {
      const date = nextDate();
      const res = await ctx
        .http()
        .get('/calendar/schedules/conflicts/check')
        .query({ employeeId: fx.staffAId, startDate: date, endDate: date })
        .set(bearer(fx.admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.hasConflicts).toBe(false);
      expect(res.body.data.conflicts).toEqual([]);
    });

    it('SCH-API-51 FIXED (T13): create, update and delete each leave an AuditLog row', async () => {
      // The MCP path was already audited (`mcp/tools/shifts.tools.ts` sets
      // `auditResourceType: 'WorkSchedule'`), so the same action was on the
      // record when performed by chat and absent when performed in the UI.
      const date = nextDate();
      const seeded = await create(fullDay(date));
      const id = seeded.body.data.id;

      await ctx
        .http()
        .put(`/calendar/schedules/${id}`)
        .set(bearer(fx.admin.token))
        .send({ notes: 'audited edit' });
      await ctx
        .http()
        .delete(`/calendar/schedules/${id}`)
        .set(bearer(fx.admin.token));

      const rows = await ctx.prisma.auditLog.findMany({
        where: { resourceType: 'WorkSchedule', userId: fx.admin.userId },
        select: { action: true, resourceId: true },
      });
      const actions = rows
        .filter((r) => r.resourceId === id)
        .map((r) => r.action);

      expect(actions).toEqual(expect.arrayContaining(['UPDATE', 'DELETE']));
      expect(rows.some((r) => r.action === 'CREATE')).toBe(true);
    });

    it('SCH-API-52 FIXED (T5): the database refuses a second identical employee-day row', async () => {
      // The constraint deliberately keys on (employee_id, date, start_time)
      // with NULLS NOT DISTINCT rather than on (employee_id, date), because a
      // split day is legitimate — SCH-API-28 and SCH-API-49 both depend on two
      // rows sharing a date. What must not be representable is a SECOND row
      // starting at the same moment.
      const date = nextDate();
      const row = {
        employeeId: fx.staffAId,
        date: new Date(`${date}T00:00:00.000Z`),
        shiftType: 'CUSTOM' as const,
        startTime: new Date(atUtc(date, '09:00')),
        endTime: new Date(atUtc(date, '18:00')),
      };

      const first = await ctx.prisma.workSchedule.create({ data: row });
      created.push(first.id);

      // Deliberately NOT `await expect(...).rejects`: if the promise ever
      // resolves, that form inserts a row and throws before anything can
      // register it for teardown, and the orphan then counts towards the next
      // case's month totals.
      let code: string | undefined;
      try {
        const duplicate = await ctx.prisma.workSchedule.create({ data: row });
        created.push(duplicate.id);
      } catch (error) {
        code = (error as { code?: string }).code;
      }

      expect(code).toBe('P2002');
    });

    it('SCH-API-52b FIXED (T5): two FLEXIBLE days collide even though both start times are NULL', async () => {
      // The case an ordinary unique index would miss: in PostgreSQL NULL is
      // normally distinct from NULL, so without NULLS NOT DISTINCT an employee
      // could hold any number of flexible days for the same date.
      const date = nextDate();
      const row = {
        employeeId: fx.staffAId,
        date: new Date(`${date}T00:00:00.000Z`),
        shiftType: 'FLEXIBLE' as const,
        startTime: null,
        endTime: null,
        requiredHours: 8,
      };

      created.push((await ctx.prisma.workSchedule.create({ data: row })).id);

      let code: string | undefined;
      try {
        const duplicate = await ctx.prisma.workSchedule.create({ data: row });
        created.push(duplicate.id);
      } catch (error) {
        code = (error as { code?: string }).code;
      }

      expect(code).toBe('P2002');
    });

    it('SCH-API-52c FIXED (T5): a split day is still allowed alongside the constraint', async () => {
      // The capability the plan's original `@@unique([employeeId, date])` would
      // have destroyed, asserted next to the constraint that replaced it so the
      // two can never drift apart.
      const date = nextDate();
      const morning = await create({
        employeeId: fx.staffAId,
        date,
        shiftType: 'CUSTOM',
        startTime: atUtc(date, '09:00'),
        endTime: atUtc(date, '12:00'),
      });
      const evening = await create({
        employeeId: fx.staffAId,
        date,
        shiftType: 'CUSTOM',
        startTime: atUtc(date, '13:00'),
        endTime: atUtc(date, '17:00'),
      });

      expect([morning.status, evening.status]).toEqual([201, 201]);
    });

    it('SCH-API-53 FIXED (T5): one scheduled day counts once', async () => {
      // The harm the constraint removes. `getOverviewCalendar` returns every
      // row and the matrix renders one cell per employee-day (`.find()`), while
      // `getCalendarStats` COUNTS rows — so a duplicate put one shift on screen
      // and two in the tile above it. With the duplicate unrepresentable, the
      // grid and the tile cannot disagree.
      //
      // `staffOtherDept` rather than `staffA`: `stats` counts a whole MONTH for
      // one employee, and staffA is the employee almost every other case in this
      // file writes to.
      const date = nextDate();
      const row = {
        employeeId: fx.staffOtherDeptId,
        date: new Date(`${date}T00:00:00.000Z`),
        shiftType: 'FULL_DAY' as const,
        startTime: new Date(atUtc(date, '09:00')),
        endTime: new Date(atUtc(date, '18:00')),
        isWorkDay: true,
      };
      created.push((await ctx.prisma.workSchedule.create({ data: row })).id);
      await ctx.prisma.workSchedule
        .create({ data: row })
        .then((r) => created.push(r.id))
        .catch(() => undefined);

      const overview = await ctx
        .http()
        .get('/calendar/overview')
        .query({ startDate: date, endDate: date })
        .set(bearer(fx.admin.token));
      const [year, month] = date.split('-').map(Number);
      const stats = await ctx
        .http()
        .get('/calendar/stats')
        .query({ month, year })
        .set(bearer(fx.otherEmployee.token));

      const onThatDay = overview.body.data.schedules.filter(
        (s: any) => s.employeeId === fx.staffOtherDeptId && s.date === date,
      );
      expect(onThatDay).toHaveLength(1);
      expect(stats.body.data.workDays).toBe(1);
    });

    it('SCH-API-54 D4: the DTO enum and the Prisma enum agree', async () => {
      // `ShiftType` is declared twice — once in `dto/create-schedule.dto.ts` and
      // once generated from the schema. A value added to the schema and not to
      // the DTO is silently un-settable through the API, and the reverse is a
      // 500 at insert time. Neither is visible without this assertion.
      expect(Object.keys(DtoShiftType).sort()).toEqual(
        Object.keys(PrismaShiftType).sort(),
      );
      expect(Object.values(DtoShiftType).sort()).toEqual(
        Object.values(PrismaShiftType).sort(),
      );
    });
  });
});
