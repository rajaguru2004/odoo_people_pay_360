import { DemoAutoseedScheduler } from './demo-autoseed.scheduler';
import { seedTodayAttendance } from './sample-data.today-attendance';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { companyTzCache } from '../common/timezone/timezone-cache';

/**
 * The nightly demo top-up. Two things have to hold: the kill switch really
 * stops it (it writes attendance rows, so a real tenant that inherited the
 * image must stay untouched), and re-running it the same night must not
 * duplicate or reshuffle anybody's day.
 */

// 2026-08-27 is a Thursday — a working day in both Oman (Fri/Sat off) and India.
const NOW = new Date('2026-08-27T02:00:00Z');
const TODAY_KEY = new Date('2026-08-27T00:00:00.000Z');

const MUSCAT = {
  id: 'branch-mct',
  timezone: 'Asia/Muscat',
  officeStartTime: '08:00',
  officeEndTime: '17:00',
  weeklyOffDays: '5,6',
};

/** Minimal in-memory prisma double: enough surface for the top-up's queries. */
function fakePrisma(opts: {
  employees: Array<{ id: string; branchId: string | null; timezone?: string | null }>;
  attendance?: any[];
  leave?: any[];
  branches?: any[];
}) {
  const attendance: any[] = [...(opts.attendance ?? [])];
  return {
    rows: attendance,
    systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    branch: { findMany: jest.fn().mockResolvedValue(opts.branches ?? [MUSCAT]) },
    employee: { findMany: jest.fn().mockResolvedValue(opts.employees) },
    leaveRequest: { findMany: jest.fn().mockResolvedValue(opts.leave ?? []) },
    attendance: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where?.source === 'AUTO') {
          return attendance.filter(
            (a) => a.source === 'AUTO' && a.checkIn && !a.checkOut && a.date < where.date.lt,
          );
        }
        const keys = new Set(where.date.in.map((d: Date) => d.getTime()));
        return attendance.filter((a) => keys.has(a.date.getTime()));
      }),
      createMany: jest.fn(async ({ data }: any) => {
        const seen = new Set(attendance.map((a) => `${a.employeeId}|${a.date.getTime()}`));
        let count = 0;
        for (const row of data) {
          const k = `${row.employeeId}|${row.date.getTime()}`;
          if (seen.has(k)) continue;
          seen.add(k);
          attendance.push(row);
          count += 1;
        }
        return { count };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = attendance.find((a) => a.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
  } as any;
}

describe('seedTodayAttendance', () => {
  it('opens today at the branch office start, in the branch zone', async () => {
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });

    const result = await seedTodayAttendance(prisma, { now: NOW, companyTz: 'Asia/Muscat' });

    expect(result.created).toBe(1);
    const row = prisma.rows[0];
    // 08:00 Asia/Muscat is 04:00Z — the hour the naive-UTC bug got wrong (it
    // stored 08:00Z, which the UI rendered as 13:30 in the company zone).
    expect(row.checkIn.getUTCHours()).toBe(4);
    expect(row.checkIn.getUTCMinutes()).toBeLessThanOrEqual(12);
    expect(row.status).toBe('PRESENT');
    expect(row.source).toBe('AUTO');
    // No check-out: the demo day is in progress, tomorrow's run closes it.
    expect(row.checkOut).toBeUndefined();
  });

  it('keeps every clock-in inside the 08:00–08:30 arrival band', async () => {
    const employees = Array.from({ length: 40 }, (_, i) => ({
      id: `emp-${i}`,
      branchId: MUSCAT.id,
    }));
    const prisma = fakePrisma({ employees });

    await seedTodayAttendance(prisma, { now: NOW, companyTz: 'Asia/Muscat' });

    for (const row of prisma.rows) {
      const mins =
        row.checkIn.getUTCHours() * 60 + row.checkIn.getUTCMinutes() - 4 * 60; // minutes past 08:00 local
      expect(mins).toBeGreaterThanOrEqual(0);
      expect(mins).toBeLessThanOrEqual(40);
      expect(row.isLate).toBe(mins > 15);
    }
    // The "Going late today" tile must not be empty.
    expect(prisma.rows.some((r: any) => r.isLate)).toBe(true);
    // …nor mostly late.
    expect(prisma.rows.filter((r: any) => r.isLate).length).toBeLessThan(employees.length / 2);
  });

  it('is idempotent — a second run the same night adds nothing', async () => {
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });

    await seedTodayAttendance(prisma, { now: NOW, companyTz: 'Asia/Muscat' });
    const first = prisma.rows[0].checkIn.getTime();
    const second = await seedTodayAttendance(prisma, { now: NOW, companyTz: 'Asia/Muscat' });

    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].checkIn.getTime()).toBe(first); // minutes not reshuffled
  });

  it('skips the branch weekly-off days', async () => {
    // 2026-08-28 is a Friday — day 5, in Muscat's '5,6' weekly off.
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });

    const result = await seedTodayAttendance(prisma, {
      now: new Date('2026-08-28T02:00:00Z'),
      companyTz: 'Asia/Muscat',
    });

    expect(result.created).toBe(0);
    expect(result.offDay).toBe(1);
  });

  it('fills a weekly-off day when the demo explicitly asks for it', async () => {
    // 2026-08-28 is a Friday — day 5, inside Muscat's '5,6'. A demo tenant is
    // judged on never opening empty, so it may be told to fill the weekend.
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });

    const result = await seedTodayAttendance(prisma, {
      now: new Date('2026-08-28T02:00:00Z'),
      companyTz: 'Asia/Muscat',
      includeOffDays: true,
    });

    expect(result.created).toBe(1);
    expect(result.offDay).toBe(0);
    expect(prisma.rows[0].status).toBe('PRESENT');
  });

  it("keeps going when one branch holds a typo'd timezone", async () => {
    // The demo data carries 'Aska/Kolkata'. Luxon calls that invalid, which
    // turned the day key into an Invalid Date and made Math.max NaN — the run
    // threw and EVERY branch lost its rows, not just the misconfigured one.
    const BAD = {
      id: 'branch-bad',
      timezone: 'Aska/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
      weeklyOffDays: null,
    };
    const prisma = fakePrisma({
      employees: [
        { id: 'e1', branchId: MUSCAT.id },
        { id: 'e2', branchId: BAD.id },
      ],
      branches: [MUSCAT, BAD],
    });

    const result = await seedTodayAttendance(prisma, { now: NOW, companyTz: 'Asia/Muscat' });

    expect(result.created).toBe(2);
    for (const row of prisma.rows) {
      expect(row.date.getTime()).toBe(TODAY_KEY.getTime());
      expect(Number.isNaN(row.checkIn.getTime())).toBe(false);
    }
  });

  it("reads an empty weekly-off string as unset rather than as 'Sunday off'", async () => {
    // parseWeeklyOff('') yields [0] because Number('') === 0, so a branch that
    // had simply never been configured silently pinned Sunday and ignored the
    // company-wide calendar_weekly_holidays.
    const BLANK = {
      id: 'branch-blank',
      timezone: 'Asia/Kolkata',
      officeStartTime: '09:00',
      officeEndTime: '18:00',
      weeklyOffDays: '',
    };
    const prisma = fakePrisma({
      employees: [{ id: 'e1', branchId: BLANK.id }],
      branches: [BLANK],
    });
    prisma.systemSetting.findUnique.mockResolvedValue({ value: '5,6' });

    // 2026-08-30 is a Sunday: an off day under the buggy [0], a working day
    // under the company's real Fri/Sat weekend.
    const result = await seedTodayAttendance(prisma, {
      now: new Date('2026-08-30T06:00:00Z'),
      companyTz: 'Asia/Kolkata',
    });

    expect(result.offDay).toBe(0);
    expect(result.created).toBe(1);
  });

  it('writes a LEAVE row rather than a phantom check-in for approved leave', async () => {
    const prisma = fakePrisma({
      employees: [{ id: 'e1', branchId: MUSCAT.id }],
      leave: [
        {
          employeeId: 'e1',
          startDate: new Date('2026-08-26T00:00:00.000Z'),
          endDate: new Date('2026-08-28T00:00:00.000Z'),
        },
      ],
    });

    await seedTodayAttendance(prisma, { now: NOW, companyTz: 'Asia/Muscat' });

    expect(prisma.rows[0].status).toBe('LEAVE');
    expect(prisma.rows[0].checkIn).toBeUndefined();
  });

  it("closes yesterday's open rows, and only the ones it wrote", async () => {
    const prisma = fakePrisma({
      employees: [],
      attendance: [
        {
          id: 'a1',
          employeeId: 'e1',
          branchId: MUSCAT.id,
          date: new Date('2026-08-26T00:00:00.000Z'),
          checkIn: new Date('2026-08-26T04:05:00.000Z'),
          checkOut: null,
          source: 'AUTO',
        },
        {
          id: 'a2',
          employeeId: 'e2',
          branchId: MUSCAT.id,
          date: new Date('2026-08-26T00:00:00.000Z'),
          checkIn: new Date('2026-08-26T04:05:00.000Z'),
          checkOut: null,
          source: 'ESS', // a real demo viewer's check-in — must be left alone
        },
      ],
    });

    const result = await seedTodayAttendance(prisma, { now: NOW, companyTz: 'Asia/Muscat' });

    expect(result.closed).toBe(1);
    expect(prisma.rows.find((r: any) => r.id === 'a1').checkOut).toBeInstanceOf(Date);
    expect(prisma.rows.find((r: any) => r.id === 'a2').checkOut).toBeNull();
  });

  it('leaves an existing row for today untouched', async () => {
    const existing = {
      id: 'a1',
      employeeId: 'e1',
      branchId: MUSCAT.id,
      date: TODAY_KEY,
      checkIn: new Date('2026-08-27T05:30:00.000Z'),
      checkOut: null,
      source: 'ESS',
    };
    const prisma = fakePrisma({
      employees: [{ id: 'e1', branchId: MUSCAT.id }],
      attendance: [existing],
    });

    const result = await seedTodayAttendance(prisma, { now: NOW, companyTz: 'Asia/Muscat' });

    expect(result.created).toBe(0);
    expect(result.existing).toBe(1);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].checkIn).toBe(existing.checkIn);
  });
});

/**
 * Keyed by setting name, not one blanket value: the two demo flags have to be
 * able to differ, and a mock that answers 'true' to everything hid the fact
 * that `run()` used the real wall clock — the suite went red on any Friday.
 */
const schedulerFor = (
  vals: Record<string, string>,
  prisma: any,
  systemTz = 'Asia/Muscat',
) => {
  const settings = {
    getSetting: jest.fn(async (key: string, dflt: string) => vals[key] ?? dflt),
  };
  const tz = new TimezoneService({
    getSetting: jest.fn().mockResolvedValue(systemTz),
  } as unknown as SystemSettingsService);
  return new DemoAutoseedScheduler(
    prisma as PrismaService,
    settings as unknown as SystemSettingsService,
    tz,
  );
};

describe('DemoAutoseedScheduler kill switch', () => {
  beforeEach(() => companyTzCache.invalidate());

  it('writes nothing when demo_autoseed_enabled is false', async () => {
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });

    expect(await schedulerFor({ demo_autoseed_enabled: 'false' }, prisma).run(NOW)).toBeNull();

    expect(prisma.employee.findMany).not.toHaveBeenCalled();
    expect(prisma.attendance.createMany).not.toHaveBeenCalled();
    expect(prisma.rows).toHaveLength(0);
  });

  it('tops the day up when demo_autoseed_enabled is true', async () => {
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });

    const result = await schedulerFor({ demo_autoseed_enabled: 'true' }, prisma).run(NOW);

    expect(result?.created).toBe(1);
    expect(prisma.rows).toHaveLength(1);
  });
});

describe('DemoAutoseedScheduler firing zone', () => {
  beforeEach(() => companyTzCache.invalidate());

  /**
   * The defect this covers: the job used ONE gate on the company zone, while
   * `seedTodayAttendance` derives every employee's day from the BRANCH zone.
   * With the company on Asia/Kolkata the 00:30 gate fired at 23:00 of the
   * previous Muscat day, so Muscat's rows for a given day were only written
   * late that night — the Muscat board read "Present today 0" right through
   * the working day. Every branch west of the company had the same failure.
   */
  const MUSCAT_0030 = new Date('2026-08-26T20:30:00Z'); // 00:30 Aug 27 in Muscat
  const KOLKATA_0030 = new Date('2026-08-26T19:00:00Z'); // 00:30 Aug 27 IST → 23:00 Aug 26 Muscat

  it("opens Muscat's own day at 00:30 Muscat, not at 00:30 company time", async () => {
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });

    await schedulerFor({ demo_autoseed_enabled: 'true' }, prisma, 'Asia/Kolkata').tick(
      MUSCAT_0030,
    );

    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].date.getTime()).toBe(TODAY_KEY.getTime()); // 2026-08-27
  });

  it('still has not reached the new Muscat day at 00:30 company time', async () => {
    // Same instant the old single gate used. Muscat is on Aug 26 here, so the
    // only row it can honestly open is Aug 26's — which is exactly why a gate
    // pinned to the company zone never produced a current Muscat day.
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });

    await schedulerFor({ demo_autoseed_enabled: 'true' }, prisma, 'Asia/Kolkata').tick(
      KOLKATA_0030,
    );

    expect(prisma.rows[0].date.getTime()).toBe(
      new Date('2026-08-26T00:00:00.000Z').getTime(),
    );
  });

  it("fires at most once per that zone's own local day", async () => {
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });
    const scheduler = schedulerFor({ demo_autoseed_enabled: 'true' }, prisma, 'Asia/Kolkata');

    await scheduler.tick(MUSCAT_0030);
    await scheduler.tick(new Date(MUSCAT_0030.getTime() + 60_000)); // still in the window

    expect(prisma.attendance.createMany).toHaveBeenCalledTimes(1);
  });

  it('touches no table at all while the kill switch is off', async () => {
    const prisma = fakePrisma({ employees: [{ id: 'e1', branchId: MUSCAT.id }] });

    await schedulerFor({ demo_autoseed_enabled: 'false' }, prisma, 'Asia/Kolkata').tick(
      MUSCAT_0030,
    );

    expect(prisma.branch.findMany).not.toHaveBeenCalled();
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
    expect(prisma.rows).toHaveLength(0);
  });
});
