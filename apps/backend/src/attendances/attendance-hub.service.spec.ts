import { BadRequestException } from '@nestjs/common';
import { AttendanceHubService } from './attendance-hub.service';

/**
 * The module hub's aggregate.
 *
 * Every case here is a way the old hub lied. It divided by headcount, so a
 * Saturday read as total collapse; it called an unfinished morning "absent";
 * it printed 0% for a department that had never filed a single record; and its
 * chart was ten hard-coded bars labelled "Jan 1..Jan 10" that moved for nobody.
 *
 * Company timezone is UTC throughout so a date key is just its own string.
 */

const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const keyOf = (d: Date) => d.toISOString().slice(0, 10);

interface Row {
  date: string;
  status?: 'PRESENT' | 'ABSENT' | 'LEAVE';
  isLate?: boolean;
  workHours?: number;
  employeeId?: string;
  fullName?: string;
  checkIn?: Date;
  checkOut?: Date | null;
}

describe('AttendanceHubService', () => {
  /** Wall-clock "now"; every case sets it before building the service. */
  let now: Date;
  let rows: Row[];
  let employees: Array<{ id: string; fullName: string; branchId: string | null; departmentId: string }>;
  /** Working days per branch id (''=no branch), as YYYY-MM-DD. */
  let workingDays: Record<string, string[]>;
  let leaves: any[];
  let schedules: any[];
  let deptRaw: any[];
  let overHoursCount: Array<{ n: number }>;
  let overHoursNames: Array<{ name: string }>;
  let boundaryPassed: boolean;

  const build = () => {
    const inRange = (from: Date, to: Date) =>
      rows.filter((r) => r.date >= keyOf(from) && r.date <= keyOf(to));

    const prisma: any = {
      employee: {
        groupBy: jest.fn(async ({ by }: any) => {
          const buckets = new Map<string, any>();
          for (const e of employees) {
            const k = by.includes('departmentId')
              ? `${e.departmentId}|${e.branchId ?? ''}`
              : `${e.branchId ?? ''}`;
            const entry = buckets.get(k) ?? {
              branchId: e.branchId,
              departmentId: e.departmentId,
              _count: { _all: 0 },
            };
            entry._count._all += 1;
            buckets.set(k, entry);
          }
          return [...buckets.values()].map((b) =>
            by.includes('departmentId')
              ? { departmentId: b.departmentId, branchId: b.branchId, _count: b._count }
              : { branchId: b.branchId, _count: b._count },
          );
        }),
        findMany: jest.fn(async ({ where }: any) => {
          const excluded: string[] = where?.id?.notIn ?? [];
          return employees
            .filter((e) => !excluded.includes(e.id))
            .map((e) => ({ id: e.id, fullName: e.fullName, branchId: e.branchId }));
        }),
      },
      department: {
        findMany: jest.fn(async () => [
          { id: 'dept-ops', name: 'Ops' },
          { id: 'dept-quiet', name: 'Quiet' },
        ]),
      },
      attendance: {
        groupBy: jest.fn(async ({ by, where }: any) => {
          let subset = inRange(where.date.gte, where.date.lte);
          if (where.isLate) subset = subset.filter((r) => r.isLate);
          if (where.workHours) subset = subset.filter((r) => r.workHours != null);
          const buckets = new Map<string, any>();
          for (const r of subset) {
            const k = by.includes('status') ? `${r.date}|${r.status}` : r.date;
            const entry = buckets.get(k) ?? {
              date: day(
                Number(r.date.slice(0, 4)),
                Number(r.date.slice(5, 7)),
                Number(r.date.slice(8, 10)),
              ),
              status: r.status,
              _count: { _all: 0 },
              _sum: { workHours: 0 },
            };
            entry._count._all += 1;
            entry._sum.workHours += r.workHours ?? 0;
            buckets.set(k, entry);
          }
          return [...buckets.values()];
        }),
        count: jest.fn(async ({ where }: any) => {
          let subset = inRange(where.date.gte, where.date.lte);
          if (where.status) subset = subset.filter((r) => r.status === where.status);
          if (where.checkOut === null) subset = subset.filter((r) => !r.checkOut);
          if (where.checkIn?.not === null) subset = subset.filter((r) => !!r.checkIn);
          return subset.length;
        }),
        findMany: jest.fn(async ({ where, take }: any) => {
          let subset = inRange(where.date.gte, where.date.lte);
          if (where.checkIn?.not === null) subset = subset.filter((r) => !!r.checkIn);
          if (where.checkOut === null) subset = subset.filter((r) => !r.checkOut);
          if (where.isLate) subset = subset.filter((r) => r.isLate);
          if (where.status) subset = subset.filter((r) => r.status === where.status);
          if (take) subset = subset.slice(0, take);
          return subset.map((r) => ({
            employeeId: r.employeeId ?? 'emp-1',
            status: r.status,
            isLate: !!r.isLate,
            checkIn: r.checkIn ?? null,
            checkOut: r.checkOut ?? null,
            workHours: r.workHours ?? null,
            employee: { fullName: r.fullName ?? 'Someone' },
          }));
        }),
      },
      leaveRequest: { findMany: jest.fn(async () => leaves) },
      workSchedule: {
        groupBy: jest.fn(async () => schedules),
        findMany: jest.fn(async () => []),
      },
      attendanceCorrection: { count: jest.fn(async () => 3) },
      // Three different statements come through this door now: the department
      // roll-up, and the over-hours count/names pair that has to compare each
      // row against its own rostered requirement.
      $queryRaw: jest.fn(async (strings: any) => {
        const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
        if (sql.includes('COUNT(DISTINCT a.employee_id)')) return overHoursCount;
        if (sql.includes('DISTINCT e.full_name')) return overHoursNames;
        return deptRaw;
      }),
    };

    const tz: any = {
      getCompanyTZ: jest.fn(async () => 'UTC'),
      toDateKey: jest.fn((d: Date) => day(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())),
      localHour: jest.fn((d: Date) => d.getUTCHours()),
    };

    const holidays: any = {
      getWorkingDatesBetween: jest.fn(async (from: Date, to: Date, branchId?: string) => {
        const allowed = workingDays[branchId ?? ''] ?? [];
        const out: Date[] = [];
        let c = new Date(from);
        while (c.getTime() <= to.getTime()) {
          if (allowed.includes(keyOf(c))) out.push(new Date(c));
          c = new Date(c.getTime() + 86_400_000);
        }
        return out;
      }),
    };

    const settings: any = { getSetting: jest.fn(async (_k: string, fb: string) => fb) };
    const attendances: any = {
      hasDayEndBoundaryPassed: jest.fn(async () => boundaryPassed),
    };

    jest.spyOn(global.Date, 'now').mockReturnValue(now.getTime());
    const realDate = Date;
    jest
      .spyOn(global as any, 'Date')
      .mockImplementation((...args: any[]) =>
        args.length === 0 ? new realDate(now) : new (realDate as any)(...args),
      );
    (global.Date as any).UTC = realDate.UTC;
    (global.Date as any).now = () => now.getTime();

    return new AttendanceHubService(prisma, tz, holidays, settings, attendances);
  };

  beforeEach(() => {
    now = new Date(Date.UTC(2026, 7, 5, 12, 0, 0)); // Wed 2026-08-05, midday
    boundaryPassed = true;
    employees = [
      { id: 'e1', fullName: 'Asha', branchId: 'b1', departmentId: 'dept-ops' },
      { id: 'e2', fullName: 'Karim', branchId: 'b1', departmentId: 'dept-ops' },
      { id: 'e3', fullName: 'Meera', branchId: 'b1', departmentId: 'dept-ops' },
      { id: 'e4', fullName: 'Ravi', branchId: 'b1', departmentId: 'dept-quiet' },
    ];
    // Mon 3rd – Wed 5th are working days; the 1st and 2nd are the weekend.
    workingDays = { b1: ['2026-08-03', '2026-08-04', '2026-08-05'] };
    rows = [];
    leaves = [];
    schedules = [{ shiftType: 'FULL_DAY', _count: { _all: 4 } }];
    deptRaw = [];
    overHoursCount = [{ n: 0 }];
    overHoursNames = [];
  });

  afterEach(() => jest.restoreAllMocks());

  it('refuses a period it does not understand instead of guessing', async () => {
    const svc = build();
    await expect(svc.getHubSummary('quarter' as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.getHubSummary('month', 'last-tuesday')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // `Date.UTC` rolls out-of-range parts over, so this would silently become
    // 2027-02-14 and answer for a period nobody asked about.
    await expect(svc.getHubSummary('month', '2026-13-45')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('answers a single day with its arrival curve, hour by hour', async () => {
    rows = [
      { date: '2026-08-05', status: 'PRESENT', checkIn: new Date(Date.UTC(2026, 7, 5, 8, 15)) },
      {
        date: '2026-08-05',
        status: 'PRESENT',
        isLate: true,
        checkIn: new Date(Date.UTC(2026, 7, 5, 9, 30)),
      },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('today')).data;

    // A day has no daily shape to draw, so its chart is the only trend a day
    // actually has: when people walked in.
    expect(summary.trendKind).toBe('hour');
    expect(summary.trend).toHaveLength(16); // 6 AM .. 9 PM
    expect(summary.trend.find((b) => b.key === '08')).toMatchObject({
      label: '8 AM',
      present: 1,
      onTime: 1,
      late: 0,
    });
    expect(summary.trend.find((b) => b.key === '09')).toMatchObject({
      present: 1,
      late: 1,
    });
    // The window is that one day, and its totals ARE the day's totals.
    expect(summary.range).toMatchObject({
      start: '2026-08-05',
      end: '2026-08-05',
      label: 'Aug 5',
      prevAnchor: '2026-08-04',
      nextAnchor: '2026-08-06',
      hasNext: false,
      isCurrent: true,
    });
    expect(summary.periodStats.daysCounted).toBe(1);
    expect(summary.periodStats.present).toBe(summary.today.present);
  });

  it('compares every window with the same window one step back', async () => {
    rows = [
      // Yesterday: two in. Today: one.
      { date: '2026-08-04', status: 'PRESENT', employeeId: 'e1' },
      { date: '2026-08-04', status: 'PRESENT', employeeId: 'e2' },
      { date: '2026-08-05', status: 'PRESENT', employeeId: 'e1' },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('today')).data;

    expect(summary.previousRange).toMatchObject({
      start: '2026-08-04',
      end: '2026-08-04',
      label: 'Aug 4',
    });
    expect(summary.periodStats.present).toBe(1);
    expect(summary.previousStats.present).toBe(2);
    // 25% today against 50% yesterday — the delta the KPI cards draw.
    expect(summary.periodStats.attendanceRate).toBe(25);
    expect(summary.previousStats.attendanceRate).toBe(50);
  });

  it('moves every panel with the window, not just the cards', async () => {
    rows = [
      // The window being asked for: Monday the 3rd.
      { date: '2026-08-03', status: 'PRESENT', employeeId: 'e1', fullName: 'Asha', checkIn: new Date(Date.UTC(2026, 7, 3, 8, 0)) },
      // Today, which is NOT in that window.
      { date: '2026-08-05', status: 'PRESENT', employeeId: 'e2', fullName: 'Karim', checkIn: new Date(Date.UTC(2026, 7, 5, 15, 0)) },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('today', '2026-08-03')).data;

    expect(summary.range.start).toBe('2026-08-03');
    expect(summary.range.isCurrent).toBe(false);

    // The arrival curve is the 3rd's 8 AM punch, not today's 3 PM one. A panel
    // left on today while the cards moved is the same lie in a quieter place.
    expect(summary.arrivalPattern.find((a) => a.hour === 8)?.onTime).toBe(1);
    expect(summary.arrivalPattern.find((a) => a.hour === 15)?.onTime).toBe(0);
    // Roster adherence likewise reads the window's totals.
    expect(summary.shifts.checkedIn).toBe(1);
    expect(summary.periodStats.present).toBe(1);

    // `today` still rides along, because the open-day rule needs it — but
    // nothing on screen reads it as a headline any more.
    expect(summary.today.date).toBe('2026-08-05');
    // "Nobody heard from" cannot be historical: on a closed day those people
    // are simply absent, and the absence figure already says so.
    expect(summary.attention.notCheckedIn.count).toBe(0);
  });

  it('expects nobody on a day the branch calendar is closed', async () => {
    // Sunday the 2nd. Three employees exist; none of them was going to work.
    now = new Date(Date.UTC(2026, 7, 2, 12, 0, 0));
    const svc = build();

    const snap = await svc.daySnapshot(day(2026, 8, 2));

    expect(snap.expected).toBe(0);
    expect(snap.absent).toBe(0);
    // Not 0%: a rate with nothing to divide by is unknown, and 0% would be a
    // claim that the whole company failed to turn up on its day off.
    expect(snap.presentRate).toBeNull();
    expect(snap.absentRate).toBeNull();
  });

  it('does not call an unfinished morning an absence', async () => {
    boundaryPassed = false;
    rows = [{ date: '2026-08-05', status: 'PRESENT', employeeId: 'e1', workHours: 4 }];
    const svc = build();

    const snap = await svc.daySnapshot(day(2026, 8, 5));

    expect(snap.expected).toBe(4);
    expect(snap.present).toBe(1);
    expect(snap.absent).toBe(0);
    // The three who have not punched are "not checked in", which is a fact,
    // rather than "absent", which is a judgement the day has not earned.
    expect(snap.notCheckedIn).toBe(3);
    expect(snap.settled).toBe(false);
  });

  it('derives the absences the cron has not written yet, once the day has closed', async () => {
    rows = [{ date: '2026-08-05', status: 'PRESENT', employeeId: 'e1' }];
    const svc = build();

    const snap = await svc.daySnapshot(day(2026, 8, 5));

    // Four expected, one present, no ABSENT rows in the table at all — the
    // calendar still knows three people are missing.
    expect(snap.absent).toBe(3);
    expect(snap.settled).toBe(true);
  });

  it('takes approved leave out of the expectation instead of counting it absent', async () => {
    rows = [{ date: '2026-08-05', status: 'PRESENT', employeeId: 'e1' }];
    leaves = [
      {
        startDate: day(2026, 8, 4),
        endDate: day(2026, 8, 6),
        employee: { branchId: 'b1', departmentId: 'dept-ops' },
      },
      {
        startDate: day(2026, 8, 5),
        endDate: day(2026, 8, 5),
        employee: { branchId: 'b1', departmentId: 'dept-ops' },
      },
    ];
    const svc = build();

    const snap = await svc.daySnapshot(day(2026, 8, 5));

    expect(snap.onLeave).toBe(2);
    // 4 expected − 1 present − 2 on leave = 1, not 3.
    expect(snap.absent).toBe(1);
  });

  it('counts leave only on days the branch was actually open', async () => {
    // A leave spanning the weekend must not manufacture leave-days out of days
    // nobody was going to work anyway.
    leaves = [
      {
        startDate: day(2026, 8, 1),
        endDate: day(2026, 8, 5),
        employee: { branchId: 'b1', departmentId: 'dept-ops' },
      },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('month')).data;

    // Aug 3, 4 and 5 are open; Aug 1 and 2 are not.
    expect(summary.periodStats.onLeave).toBe(3);
  });

  it('keeps the closed days on the axis but expects nobody on them', async () => {
    rows = [
      { date: '2026-08-03', status: 'PRESENT', employeeId: 'e1', isLate: true },
      { date: '2026-08-04', status: 'PRESENT', employeeId: 'e1' },
      { date: '2026-08-05', status: 'PRESENT', employeeId: 'e1' },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('month')).data;

    // The axis is the calendar, so the week's rhythm stays readable — but the
    // weekend carries no expectation, so it cannot read as a bad day.
    expect(summary.trend.map((b) => b.key)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
    expect(summary.trend[0]).toMatchObject({
      key: '2026-08-01',
      expected: 0,
      present: 0,
      absent: 0,
      attendanceRate: null,
    });
    expect(summary.trend[2]).toMatchObject({
      expected: 4,
      present: 1,
      late: 1,
      onTime: 0,
      absent: 3,
      attendanceRate: 25,
    });
    expect(summary.range).toMatchObject({
      label: 'Aug 2026',
      start: '2026-08-01',
      end: '2026-08-31',
      through: '2026-08-05',
      hasNext: false,
      isCurrent: true,
    });
  });

  it('never reports more than everybody, even when people work a closed day', async () => {
    // The defect this pins: Founders Day is a holiday, six people clocked in
    // anyway, and the hub read "106% attendance" — a number that cannot exist.
    // Here Aug 1 is a weekend the calendar expects nobody on, and two people
    // worked it.
    rows = [
      { date: '2026-08-01', status: 'PRESENT', employeeId: 'e1' },
      { date: '2026-08-01', status: 'PRESENT', employeeId: 'e2' },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('month')).data;
    const sat = summary.trend.find((b) => b.key === '2026-08-01')!;

    // Whoever actually turned up was evidently expected to.
    expect(sat.expected).toBe(2);
    expect(sat.attendanceRate).toBe(100);
    // Reconciling only ever RAISES the denominator, so it cannot hide the three
    // people missing on a day the calendar did expect four.
    expect(summary.periodStats.attendanceRate).toBeLessThanOrEqual(100);
    expect(summary.trend.find((b) => b.key === '2026-08-05')!.absent).toBe(4);
  });

  it('never aggregates a day that has not happened', async () => {
    const svc = build();
    const summary = (await svc.getHubSummary('month')).data;

    // The month runs to the 31st, but only five days of it exist.
    expect(summary.trend.every((b) => b.key <= '2026-08-05')).toBe(true);
  });

  it('rolls a year up into months and offers the anchors to page with', async () => {
    rows = [{ date: '2026-08-03', status: 'PRESENT', employeeId: 'e1' }];
    const svc = build();

    const summary = (await svc.getHubSummary('year')).data;

    // One bar per month up to today, never past it — a year view of a year in
    // progress is eight months, not twelve with four empty ones on the end.
    expect(summary.trend.map((b) => b.label)).toEqual([
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
    ]);
    expect(summary.trend[7]).toMatchObject({ key: '2026-08', present: 1 });
    expect(summary.trendKind).toBe('month');
    // Days are days in every period; bars are what changes.
    expect(summary.periodStats.bucketCount).toBe(8);
    expect(summary.periodStats.daysCounted).toBeGreaterThan(8);
    expect(summary.range).toMatchObject({
      label: '2026',
      prevAnchor: '2025-01-01',
      nextAnchor: '2027-01-01',
      hasNext: false,
    });
  });

  it('lets the caller page backwards, and reports that period as not current', async () => {
    const svc = build();
    const summary = (await svc.getHubSummary('week', '2026-07-20')).data;

    // Monday-first, whatever day of the week the anchor happens to be.
    expect(summary.range).toMatchObject({
      start: '2026-07-20',
      end: '2026-07-26',
      label: 'Jul 20 – 26',
      isCurrent: false,
      hasNext: true,
    });
  });

  it('marks a department that filed nothing as having no data, not as 0%', async () => {
    deptRaw = [
      { departmentId: 'dept-ops', present: 6, late: 2, absent: 1, recorded: 9 },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('month')).data;
    const ops = summary.departments.find((d) => d.id === 'dept-ops')!;
    const quiet = summary.departments.find((d) => d.id === 'dept-quiet')!;

    expect(ops.hasData).toBe(true);
    expect(quiet.hasData).toBe(false);
    // The silent department sorts LAST despite its 0%, so it cannot bury a
    // department that is genuinely short-handed.
    expect(summary.departments[summary.departments.length - 1].id).toBe('dept-quiet');
  });

  it('buckets arrivals by the hour they happened, split on time against late', async () => {
    rows = [
      { date: '2026-08-05', status: 'PRESENT', checkIn: new Date(Date.UTC(2026, 7, 5, 8, 15)) },
      { date: '2026-08-05', status: 'PRESENT', checkIn: new Date(Date.UTC(2026, 7, 5, 8, 45)) },
      {
        date: '2026-08-05',
        status: 'PRESENT',
        isLate: true,
        checkIn: new Date(Date.UTC(2026, 7, 5, 9, 30)),
      },
      // 4 AM is outside the 6 AM–9 PM window: it clamps to the edge rather
      // than vanishing, because a night-shift punch is still a punch.
      { date: '2026-08-05', status: 'PRESENT', checkIn: new Date(Date.UTC(2026, 7, 5, 4, 0)) },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('month')).data;
    const at = (h: number) => summary.arrivalPattern.find((a) => a.hour === h)!;

    expect(at(8)).toMatchObject({ onTime: 2, late: 0, label: '8 AM' });
    expect(at(9)).toMatchObject({ onTime: 0, late: 1 });
    expect(at(6).onTime).toBe(1);
  });

  it('measures the roster against the calendar when no roster exists', async () => {
    schedules = [];
    rows = [{ date: '2026-08-05', status: 'PRESENT', employeeId: 'e1' }];
    const svc = build();

    const summary = (await svc.getHubSummary('month')).data;

    expect(summary.shifts.source).toBe('calendar');
    // Window-scoped, so a month counts shift-DAYS in the same unit as the
    // `expected` it falls back to: 4 employees across 3 open days.
    expect(summary.shifts.scheduled).toBe(12);
    expect(summary.shifts.checkedIn).toBe(1);
    expect(summary.shifts.yetToCheckIn).toBe(11);
  });

  it('counts rostered shift-days across the window, not just today', async () => {
    // The groupBy is asked for a RANGE now; the stub returns what the roster
    // holds for it, and the panel must report that rather than a headcount.
    schedules = [
      { shiftType: 'MORNING', _count: { _all: 6 } },
      { shiftType: 'FULL_DAY', _count: { _all: 6 } },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('month')).data;

    expect(summary.shifts.source).toBe('roster');
    expect(summary.shifts.shiftCount).toBe(2);
    expect(summary.shifts.scheduled).toBe(12);
  });

  it('names the people behind every action item', async () => {
    boundaryPassed = false;
    overHoursCount = [{ n: 1 }];
    overHoursNames = [{ name: 'Asha' }];
    rows = [
      {
        date: '2026-08-05',
        status: 'PRESENT',
        employeeId: 'e1',
        fullName: 'Asha',
        isLate: true,
        checkIn: new Date(Date.UTC(2026, 7, 5, 9, 40)),
        checkOut: null,
        workHours: 11,
      },
    ];
    const svc = build();

    const summary = (await svc.getHubSummary('today')).data;

    expect(summary.attention.notCheckedOut).toMatchObject({ count: 1, names: ['Asha'] });
    expect(summary.attention.late.names).toEqual(['Asha']);
    // 11h against the 8h default is over the scheduled day.
    expect(summary.attention.overScheduledHours).toMatchObject({ count: 1, names: ['Asha'] });
    // The day is still open, so the three who have not punched are "not heard
    // from" rather than absent.
    expect(summary.attention.notCheckedIn.count).toBe(3);
    // The queue is never windowed — it is what is waiting NOW.
    expect(summary.attention.pendingCorrections).toBe(3);
  });

  it('caps the names it returns without capping the counts', async () => {
    // A year-long window must cost the same as a day. The count comes from an
    // aggregate and the names from a bounded `take`, so twelve names under a
    // count of ninety is the intended shape, not a bug.
    rows = Array.from({ length: 20 }, (_, i) => ({
      date: '2026-08-05',
      status: 'PRESENT' as const,
      employeeId: `e${i}`,
      fullName: `Person ${i}`,
      isLate: true,
      checkIn: new Date(Date.UTC(2026, 7, 5, 10, 0)),
      checkOut: null,
    }));
    const svc = build();

    const summary = (await svc.getHubSummary('today')).data;

    expect(summary.attention.notCheckedOut.count).toBe(20);
    expect(summary.attention.notCheckedOut.names).toHaveLength(12);
  });
});
