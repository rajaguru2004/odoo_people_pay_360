import { BadRequestException } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { PrismaService } from '../prisma/prisma.service';
import { AttendanceCalendarService } from './attendance-calendar.service';
import {
  AttendanceHubService,
  reconcileExpected,
  resolveHubRange,
} from './attendance-hub.service';
import { parseDayKey } from './attendance-calendar.util';

/** 15 March 2026 is a Sunday — a working day on a Fri/Sat weekend. */
const NOW = new Date('2026-03-15T09:00:00.000Z');

const at = (key: string) => parseDayKey(key) as DateTime;

interface FakeRow {
  employeeId: string;
  branchId?: string | null;
  date: Date;
  checkIn?: Date | null;
  checkOut?: Date | null;
  workHours?: number | null;
  expectedHours?: number | null;
  status: string;
  isLate?: boolean;
}

function inRange(date: Date, filter: unknown): boolean {
  if (filter instanceof Date) return date.getTime() === filter.getTime();
  const range = filter as { gte?: Date; lte?: Date };
  if (range.gte && date < range.gte) return false;
  if (range.lte && date > range.lte) return false;
  return true;
}

function makePrisma(
  options: {
    branches?: unknown[];
    employees?: unknown[];
    attendances?: FakeRow[];
    departments?: unknown[];
    pendingCorrections?: number;
  } = {},
) {
  const attendances = options.attendances ?? [];
  return {
    company: {
      findFirst: jest.fn().mockResolvedValue({ timezone: 'Asia/Muscat' }),
    },
    branch: { findMany: jest.fn().mockResolvedValue(options.branches ?? []) },
    employee: {
      findMany: jest.fn().mockResolvedValue(options.employees ?? []),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    department: {
      findMany: jest.fn().mockResolvedValue(options.departments ?? []),
    },
    holiday: { findMany: jest.fn().mockResolvedValue([]) },
    workSchedule: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    attendance: {
      findMany: jest.fn(({ where }: { where: { date: unknown } }) =>
        Promise.resolve(
          attendances
            .filter((row) => inRange(row.date, where.date))
            .map((row) => ({
              branchId: null,
              checkIn: null,
              checkOut: null,
              workHours: null,
              expectedHours: null,
              isLate: false,
              ...row,
            })),
        ),
      ),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    attendanceCorrection: {
      count: jest.fn().mockResolvedValue(options.pendingCorrections ?? 0),
    },
  };
}

function makeHub(options: Parameters<typeof makePrisma>[0] = {}) {
  const prisma = makePrisma(options) as unknown as PrismaService;
  const calendar = new AttendanceCalendarService(prisma);
  return new AttendanceHubService(prisma, calendar);
}

const MUSCAT_BRANCH = {
  id: 'b1',
  timezone: 'Asia/Muscat',
  officeStartTime: '08:00',
  officeEndTime: '17:00',
  graceMinutes: 15,
  weeklyOffDays: [5, 6],
};

describe('resolveHubRange', () => {
  it('makes a single day out of "today"', () => {
    expect(resolveHubRange('today', at('2026-03-15'))).toEqual({
      start: '2026-03-15',
      end: '2026-03-15',
      label: 'Sun, 15 Mar 2026',
      prevAnchor: '2026-03-14',
      nextAnchor: '2026-03-16',
    });
  });

  it('makes a Monday-first week', () => {
    const range = resolveHubRange('week', at('2026-03-15'));
    expect(range.start).toBe('2026-03-09');
    expect(range.end).toBe('2026-03-15');
    expect(range.label).toBe('9 – 15 Mar 2026');
    expect(range.prevAnchor).toBe('2026-03-08');
    expect(range.nextAnchor).toBe('2026-03-22');
  });

  it('labels a week that spans two months', () => {
    expect(resolveHubRange('week', at('2026-03-01')).label).toBe(
      '23 Feb – 1 Mar 2026',
    );
  });

  it('makes a calendar month', () => {
    expect(resolveHubRange('month', at('2026-03-15'))).toEqual({
      start: '2026-03-01',
      end: '2026-03-31',
      label: 'March 2026',
      prevAnchor: '2026-02-15',
      nextAnchor: '2026-04-15',
    });
  });

  it('clamps a month step that would land on a day the month does not have', () => {
    expect(resolveHubRange('month', at('2026-03-31')).prevAnchor).toBe(
      '2026-02-28',
    );
  });

  it('makes a calendar year', () => {
    expect(resolveHubRange('year', at('2026-03-15'))).toEqual({
      start: '2026-01-01',
      end: '2026-12-31',
      label: '2026',
      prevAnchor: '2025-03-15',
      nextAnchor: '2027-03-15',
    });
  });
});

describe('reconcileExpected', () => {
  it('takes the plan minus approved leave', () => {
    expect(reconcileExpected(10, 2, 8, 0)).toBe(8);
  });

  it('never reports fewer expected than actually turned up', () => {
    // Six people worked a public holiday nobody was expected on.
    expect(reconcileExpected(0, 0, 6, 0)).toBe(6);
  });

  it('never goes negative when leave exceeds the plan', () => {
    expect(reconcileExpected(2, 5, 0, 0)).toBe(0);
  });
});

describe('AttendanceHubService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('refuses a malformed anchor rather than falling back to today', async () => {
    const hub = makeHub();
    await expect(hub.getSummary('month', '15-03-2026')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('reports every rate as null, not zero, when nothing was expected', async () => {
    const result = await makeHub().getSummary('month');

    expect(result.periodStats.expected).toBe(0);
    expect(result.periodStats.attendanceRate).toBeNull();
    expect(result.periodStats.absentRate).toBeNull();
    expect(result.periodStats.lateRate).toBeNull();
    expect(result.periodStats.avgWorkHours).toBeNull();
    expect(result.today.presentRate).toBeNull();
    expect(result.today.absentRate).toBeNull();
    expect(result.today.onTimeRate).toBeNull();
    expect(result.yesterday.presentRate).toBeNull();
  });

  it('does not let the stepper walk into the future', async () => {
    const current = await makeHub().getSummary('month');
    expect(current.range.isCurrent).toBe(true);
    expect(current.range.hasNext).toBe(false);

    const past = await makeHub().getSummary('month', '2026-01-10');
    expect(past.range.isCurrent).toBe(false);
    expect(past.range.hasNext).toBe(true);

    // More than one step back: last year's next anchor is itself in the future,
    // but 2026 exists and has begun, so the stepper must not be locked.
    const lastYear = await makeHub().getSummary('year', '2025-06-01');
    expect(lastYear.range.hasNext).toBe(true);

    // Already ahead of today — there is nothing further forward to show.
    const future = await makeHub().getSummary('month', '2026-08-04');
    expect(future.range.hasNext).toBe(false);
  });

  it('reports how much of an in-progress window has happened', async () => {
    const result = await makeHub().getSummary('month');
    expect(result.range.start).toBe('2026-03-01');
    expect(result.range.end).toBe('2026-03-31');
    expect(result.range.through).toBe('2026-03-15');
  });

  it('reports a window entirely in the future as having happened not at all', async () => {
    const result = await makeHub().getSummary('month', '2026-08-04');
    expect(result.range.through).toBeNull();
    expect(result.periodStats.daysCounted).toBe(0);
    expect(result.periodStats.attendanceRate).toBeNull();
  });

  it('compares against the same window one step back', async () => {
    const result = await makeHub().getSummary('month');
    expect(result.previousRange).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
      label: 'February 2026',
    });
    expect(result.previousStats).toBeDefined();

    const week = await makeHub().getSummary('week');
    expect(week.previousRange.start).toBe('2026-03-02');
    expect(week.previousRange.end).toBe('2026-03-08');
  });

  it('buckets the trend by hour for a single day', async () => {
    const result = await makeHub().getSummary('today');
    expect(result.trendKind).toBe('hour');
    expect(result.trend).toHaveLength(24);
    expect(result.trend[0]).toMatchObject({ key: '00', label: '12 AM' });
    expect(result.trend[13]).toMatchObject({ key: '13', label: '1 PM' });
    // An hour expects nobody in particular, so it has no rate to report.
    expect(result.trend[9].attendanceRate).toBeNull();
    expect(result.periodStats.bucketCount).toBe(24);
  });

  it('buckets the trend by day for a week and a month', async () => {
    const week = await makeHub().getSummary('week');
    expect(week.trendKind).toBe('day');
    expect(week.trend).toHaveLength(7);
    expect(week.trend[0].key).toBe('2026-03-09');
    expect(week.trend[0].label).toBe('9 Mar');

    const month = await makeHub().getSummary('month');
    expect(month.trendKind).toBe('day');
    // Only the days that have actually happened.
    expect(month.trend).toHaveLength(15);
  });

  it('buckets the trend by month for a year', async () => {
    const result = await makeHub().getSummary('year');
    expect(result.trendKind).toBe('month');
    expect(result.trend.map((b) => b.label)).toEqual(['Jan', 'Feb', 'Mar']);
    expect(result.trend[0].key).toBe('2026-01');
  });

  it('divides by the working calendar, not by headcount', async () => {
    const hub = makeHub({
      branches: [MUSCAT_BRANCH],
      employees: [
        {
          id: 'e1',
          firstName: 'Aisha',
          lastName: 'Al Balushi',
          status: 'ACTIVE',
          branchId: 'b1',
          departmentId: 'd1',
        },
        {
          id: 'e2',
          firstName: 'Omar',
          lastName: 'Al Hinai',
          status: 'ACTIVE',
          branchId: 'b1',
          departmentId: 'd1',
        },
      ],
      departments: [{ id: 'd1', name: 'Finance' }],
      attendances: [
        {
          employeeId: 'e1',
          branchId: 'b1',
          date: new Date('2026-03-15T00:00:00.000Z'),
          checkIn: new Date('2026-03-15T04:05:00.000Z'),
          checkOut: new Date('2026-03-15T13:00:00.000Z'),
          workHours: 8.92,
          expectedHours: 9,
          status: 'PRESENT',
        },
      ],
    });

    const result = await hub.getSummary('today');

    // Two employees, one working day, nobody on leave.
    expect(result.today.expected).toBe(2);
    expect(result.today.present).toBe(1);
    expect(result.today.presentRate).toBe(50);
    // The day is still open at 13:00 Muscat, so the second person is not yet
    // an absence — only somebody who has not been heard from.
    expect(result.today.settled).toBe(false);
    expect(result.today.absent).toBe(0);
    expect(result.today.notCheckedIn).toBe(1);
    expect(result.attention.notCheckedIn).toEqual({
      count: 1,
      names: ['Omar Al Hinai'],
    });
  });

  it('excludes a weekly rest day from what was expected', async () => {
    const hub = makeHub({
      branches: [MUSCAT_BRANCH],
      employees: [
        {
          id: 'e1',
          firstName: 'Aisha',
          lastName: 'Al Balushi',
          status: 'ACTIVE',
          branchId: 'b1',
          departmentId: 'd1',
        },
      ],
    });

    // 2026-03-14 is a Saturday, which this branch takes off.
    const result = await hub.getSummary('today', '2026-03-14');
    expect(result.periodStats.expected).toBe(0);
    expect(result.periodStats.attendanceRate).toBeNull();
  });

  it('caps the names on the attention strip without capping the count', async () => {
    const employees = Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`,
      firstName: 'Late',
      lastName: `Arriver ${i}`,
      status: 'ACTIVE',
      branchId: 'b1',
      departmentId: 'd1',
    }));
    const hub = makeHub({
      branches: [MUSCAT_BRANCH],
      employees,
      departments: [{ id: 'd1', name: 'Operations' }],
      attendances: employees.map((e) => ({
        employeeId: e.id,
        branchId: 'b1',
        date: new Date('2026-03-15T00:00:00.000Z'),
        checkIn: new Date('2026-03-15T05:30:00.000Z'),
        status: 'LATE',
        isLate: true,
      })),
    });

    const result = await hub.getSummary('today');
    expect(result.attention.late.count).toBe(12);
    expect(result.attention.late.names).toHaveLength(8);
    // Checked in and never checked out — twelve unclosed shifts.
    expect(result.attention.notCheckedOut.count).toBe(12);
    expect(result.attention.notCheckedOut.names).toHaveLength(8);
  });

  it('falls back to the branch calendar when no roster covers the window', async () => {
    const result = await makeHub({
      branches: [MUSCAT_BRANCH],
      employees: [
        {
          id: 'e1',
          firstName: 'Aisha',
          lastName: 'Al Balushi',
          status: 'ACTIVE',
          branchId: 'b1',
          departmentId: 'd1',
        },
      ],
    }).getSummary('today');

    expect(result.shifts.source).toBe('calendar');
    expect(result.shifts.shiftCount).toBe(0);
    expect(result.shifts.scheduled).toBe(result.periodStats.expected);
  });

  it('carries the pending correction queue rather than windowing it', async () => {
    const result = await makeHub({ pendingCorrections: 7 }).getSummary('year');
    expect(result.attention.pendingCorrections).toBe(7);
  });
});
