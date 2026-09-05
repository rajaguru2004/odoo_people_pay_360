import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { PrismaService } from '../prisma/prisma.service';
import { AttendanceCalendarService } from '../attendances/attendance-calendar.service';
import { parseDayKey } from '../attendances/attendance-calendar.util';
import { SchedulesService, gapsBelowMedian } from './schedules.service';
import { SchedulesHubService } from './schedules-hub.service';
import {
  bucketOf,
  labelForDayKey,
  resolveScheduleRange,
  trendKindFor,
} from './schedule-range.util';

/**
 * Monday 9 March 2026, so a `week` anchored anywhere in it resolves to
 * 9–15 March and the branch below rests on the 13th and 14th.
 */
const NOW = new Date('2026-03-11T09:00:00.000Z');

const at = (key: string) => parseDayKey(key) as DateTime;
const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

const MUSCAT = {
  id: 'b1',
  timezone: 'Asia/Muscat',
  officeStartTime: '08:00',
  officeEndTime: '17:00',
  graceMinutes: 15,
  // Friday and Saturday, as an Oman branch keeps them.
  weeklyOffDays: [5, 6],
};

interface FakeSchedule {
  id: string;
  employeeId: string;
  date: Date;
  shiftType: string;
  startTime: string | null;
  endTime: string | null;
  requiredHours?: number | null;
  employee: {
    firstName: string;
    lastName: string;
    branchId: string | null;
    departmentId: string | null;
  };
}

interface FakeEmployee {
  id: string;
  firstName: string;
  lastName: string;
  branchId: string | null;
  departmentId: string | null;
}

function inRange(date: Date, filter: unknown): boolean {
  if (filter instanceof Date) return date.getTime() === filter.getTime();
  const range = filter as { gte?: Date; lte?: Date };
  if (range?.gte && date < range.gte) return false;
  if (range?.lte && date > range.lte) return false;
  return true;
}

function makePrisma(
  options: {
    employees?: FakeEmployee[];
    schedules?: FakeSchedule[];
    holidays?: Array<{
      id: string;
      name: string;
      date: Date;
      branchId: string | null;
    }>;
    departments?: Array<{ id: string; name: string }>;
  } = {},
) {
  const employees = options.employees ?? [];
  const schedules = options.schedules ?? [];
  const holidays = options.holidays ?? [];
  const departments = options.departments ?? [];

  return {
    company: {
      findFirst: jest.fn().mockResolvedValue({ timezone: 'Asia/Muscat' }),
    },
    branch: { findMany: jest.fn().mockResolvedValue([MUSCAT]) },
    employee: {
      findMany: jest.fn(
        ({ where }: { where?: { id?: { notIn?: string[] } } }) => {
          const excluded = new Set(where?.id?.notIn ?? []);
          return Promise.resolve(employees.filter((e) => !excluded.has(e.id)));
        },
      ),
      findUnique: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn(() =>
        Promise.resolve(
          [...new Set(employees.map((e) => e.departmentId))].map(
            (departmentId) => ({
              departmentId,
              _count: {
                _all: employees.filter((e) => e.departmentId === departmentId)
                  .length,
              },
            }),
          ),
        ),
      ),
    },
    department: { findMany: jest.fn().mockResolvedValue(departments) },
    holiday: {
      findMany: jest.fn(({ where }: { where: { date: unknown } }) =>
        Promise.resolve(holidays.filter((h) => inRange(h.date, where.date))),
      ),
    },
    workSchedule: {
      findMany: jest.fn(({ where }: { where: { date: unknown } }) =>
        Promise.resolve(schedules.filter((s) => inRange(s.date, where.date))),
      ),
    },
    attendance: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
  };
}

function makeHub(options: Parameters<typeof makePrisma>[0] = {}) {
  const prisma = makePrisma(options) as unknown as PrismaService;
  const calendar = new AttendanceCalendarService(prisma);
  const schedules = new SchedulesService(prisma, calendar);
  return new SchedulesHubService(prisma, schedules);
}

/** Five people in one department, all at the Muscat branch. */
const TEAM: FakeEmployee[] = Array.from({ length: 5 }, (_, i) => ({
  id: `e${i + 1}`,
  firstName: 'Staff',
  lastName: `${i + 1}`,
  branchId: 'b1',
  departmentId: 'd1',
}));

const shiftOn = (
  employeeId: string,
  dayKey: string,
  overrides: Partial<FakeSchedule> = {},
): FakeSchedule => ({
  id: `${employeeId}-${dayKey}`,
  employeeId,
  date: day(dayKey),
  shiftType: 'FULL_DAY',
  startTime: '08:00',
  endTime: '17:00',
  requiredHours: null,
  employee: {
    firstName: 'Staff',
    lastName: employeeId.slice(1),
    branchId: 'b1',
    departmentId: 'd1',
  },
  ...overrides,
});

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('resolveScheduleRange', () => {
  it('makes a Monday-first week', () => {
    const range = resolveScheduleRange('week', at('2026-03-11'));
    expect(range.start).toBe('2026-03-09');
    expect(range.end).toBe('2026-03-15');
    expect(range.label).toBe('9 – 15 Mar 2026');
    expect(range.prevAnchor).toBe('2026-03-04');
    expect(range.nextAnchor).toBe('2026-03-18');
  });

  it('makes a whole calendar month whatever day it is anchored on', () => {
    const range = resolveScheduleRange('month', at('2026-03-31'));
    expect(range.start).toBe('2026-03-01');
    expect(range.end).toBe('2026-03-31');
    expect(range.label).toBe('March 2026');
    // Stepping back from the 31st must not land on a day February does not have.
    expect(range.prevAnchor).toBe('2026-02-28');
  });

  it('makes a whole year', () => {
    const range = resolveScheduleRange('year', at('2026-07-04'));
    expect(range.start).toBe('2026-01-01');
    expect(range.end).toBe('2026-12-31');
    expect(range.label).toBe('2026');
  });

  it('draws a day per bar for a week and a month, and a month per bar for a year', () => {
    expect(trendKindFor('week')).toBe('day');
    expect(trendKindFor('month')).toBe('day');
    expect(trendKindFor('year')).toBe('month');
  });

  it('buckets a year by month and everything else by day', () => {
    expect(bucketOf('year', at('2026-03-11'))).toEqual({
      key: '2026-03',
      label: 'Mar',
    });
    expect(bucketOf('week', at('2026-03-11'))).toEqual({
      key: '2026-03-11',
      label: '11 Mar',
    });
  });

  it('names a date the way an action item reads it', () => {
    expect(labelForDayKey('2026-03-11')).toBe('11 Mar');
    expect(labelForDayKey('not-a-date')).toBe('not-a-date');
  });
});

describe('gapsBelowMedian', () => {
  it('reports nothing when the window is too short to have a middle', () => {
    expect(gapsBelowMedian([0, 5])).toBe(0);
  });

  it('counts the days below the window s own normal', () => {
    expect(gapsBelowMedian([5, 5, 5, 1, 0])).toBe(2);
  });

  it('reports nothing when every day is the same', () => {
    expect(gapsBelowMedian([4, 4, 4, 4, 4])).toBe(0);
  });
});

describe('SchedulesHubService.getSummary', () => {
  it('refuses a period it does not serve', async () => {
    await expect(
      makeHub().getSummary('today' as never, undefined, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an anchor that is not a date', async () => {
    await expect(
      makeHub().getSummary('week', 'last-tuesday'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('expects nobody on the branch weekly off, so a rest day is not a gap', async () => {
    const hub = makeHub({
      employees: TEAM,
      departments: [{ id: 'd1', name: 'Operations' }],
      schedules: [],
    });

    const summary = await hub.getSummary('week', '2026-03-11');
    const friday = summary.trend.find((b) => b.key === '2026-03-13');
    const monday = summary.trend.find((b) => b.key === '2026-03-09');

    // 13 March 2026 is a Friday — the branch rests, so nobody is expected and
    // nobody is unassigned. Without this a closed day draws a full-height bar.
    expect(friday).toMatchObject({
      expected: 0,
      unassigned: 0,
      coverageRate: null,
    });
    expect(monday).toMatchObject({ expected: 5, scheduled: 0, unassigned: 5 });
  });

  it('counts working days by the branch calendar, not by the length of the window', () => {
    return makeHub({ employees: TEAM })
      .getSummary('week', '2026-03-11')
      .then((summary) => {
        // Seven days, two of them the branch's weekly off.
        expect(summary.periodStats.workingDays).toBe(5);
      });
  });

  it('reports coverage as unknown rather than nought when nobody is active', async () => {
    const summary = await makeHub({ employees: [] }).getSummary(
      'week',
      '2026-03-11',
    );
    expect(summary.periodStats.activeHeadcount).toBe(0);
    expect(summary.periodStats.coverageRate).toBeNull();
  });

  it('counts a person rostered on their weekly off as a conflict, not as coverage', async () => {
    const hub = makeHub({
      employees: TEAM,
      departments: [{ id: 'd1', name: 'Operations' }],
      // The 13th is a Friday.
      schedules: [shiftOn('e1', '2026-03-13')],
    });

    const summary = await hub.getSummary('week', '2026-03-11');
    expect(summary.periodStats.conflicts.onWeeklyOff).toBe(1);
    expect(summary.periodStats.conflicts.total).toBe(1);
    // The bar for a closed day never goes negative, however many are on it.
    expect(summary.trend.find((b) => b.key === '2026-03-13')?.unassigned).toBe(
      0,
    );
  });

  it('counts a holiday roster once, not twice, when it lands on a weekly off', async () => {
    const hub = makeHub({
      employees: TEAM,
      departments: [{ id: 'd1', name: 'Operations' }],
      schedules: [shiftOn('e1', '2026-03-13')],
      holidays: [
        {
          id: 'h1',
          name: 'National Day',
          date: day('2026-03-13'),
          branchId: null,
        },
      ],
    });

    const summary = await hub.getSummary('week', '2026-03-11');
    expect(summary.periodStats.conflicts.onHoliday).toBe(1);
    expect(summary.periodStats.conflicts.onWeeklyOff).toBe(0);
    expect(summary.periodStats.conflicts.total).toBe(1);
  });

  it('places a night shift on both sides of midnight in the hourly curve', async () => {
    const hub = makeHub({
      employees: TEAM,
      departments: [{ id: 'd1', name: 'Operations' }],
      schedules: [
        shiftOn('e1', '2026-03-09', {
          shiftType: 'NIGHT',
          startTime: '22:00',
          endTime: '06:00',
        }),
      ],
    });

    const summary = await hub.getSummary('week', '2026-03-11');
    const hours = summary.staffCoverage.hours;
    expect(hours[22].onShift).toBeGreaterThan(0);
    expect(hours[2].onShift).toBeGreaterThan(0);
    expect(hours[12].onShift).toBe(0);
  });

  it('says how many flexible shifts the hourly curve leaves out', async () => {
    const hub = makeHub({
      employees: TEAM,
      departments: [{ id: 'd1', name: 'Operations' }],
      schedules: [
        shiftOn('e1', '2026-03-09', {
          shiftType: 'FLEXIBLE',
          startTime: null,
          endTime: null,
          requiredHours: 8,
        }),
      ],
    });

    const summary = await hub.getSummary('week', '2026-03-11');
    expect(summary.staffCoverage.flexibleExcluded).toBe(1);
    expect(summary.staffCoverage.hours.every((h) => h.onShift === 0)).toBe(
      true,
    );
  });

  it('lists a department with no roster at 0%, not as missing data', async () => {
    const hub = makeHub({
      employees: TEAM,
      departments: [{ id: 'd1', name: 'Operations' }],
      schedules: [],
    });

    const summary = await hub.getSummary('week', '2026-03-11');
    expect(summary.departments).toEqual([
      expect.objectContaining({
        id: 'd1',
        name: 'Operations',
        headcount: 5,
        scheduled: 0,
        unscheduled: 5,
        rate: 0,
        hasData: true,
      }),
    ]);
  });

  it('names the people with no shift so the queue is workable as it is', async () => {
    const hub = makeHub({
      employees: TEAM,
      departments: [{ id: 'd1', name: 'Operations' }],
      schedules: [],
    });

    const summary = await hub.getSummary('week', '2026-03-11');
    expect(summary.attention.unassigned.count).toBe(5);
    expect(summary.attention.unassigned.names).toHaveLength(5);
  });

  it('pages forward into next week, because a roster is read ahead of today', async () => {
    const summary = await makeHub({ employees: TEAM }).getSummary(
      'week',
      '2026-03-11',
    );
    expect(summary.range.hasNext).toBe(true);
    expect(summary.range.isCurrent).toBe(true);
  });

  it('stops paging forward a year past today rather than into empty windows', async () => {
    const summary = await makeHub({ employees: TEAM }).getSummary(
      'week',
      '2027-06-01',
    );
    expect(summary.range.hasNext).toBe(false);
    expect(summary.range.isCurrent).toBe(false);
  });

  it('hands back the window before it, so every delta has a comparison', async () => {
    const summary = await makeHub({ employees: TEAM }).getSummary(
      'week',
      '2026-03-11',
    );
    expect(summary.previousRange).toEqual({
      start: '2026-03-02',
      end: '2026-03-08',
      label: '2 – 8 Mar 2026',
    });
    expect(summary.previousStats.activeHeadcount).toBe(5);
  });
});
