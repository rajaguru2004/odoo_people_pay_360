import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../system-settings/system-settings.service';
import { WorkingDaysService } from './working-days.service';

const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

/**
 * A `@db.Date` value as a driver running on a +05:30 server hands it back:
 * midnight LOCAL, which is the previous evening in UTC.
 */
const asReadOnIstServer = (key: string) =>
  new Date(day(key).getTime() - 5.5 * 3_600_000);

function makeService(
  options: {
    branchWeeklyOff?: number[] | null;
    setting?: string;
    holidays?: Array<{ date: Date; branchId: string | null }>;
  } = {},
) {
  const holidays = options.holidays ?? [];

  const prisma = {
    branch: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.branchWeeklyOff === null
            ? null
            : { weeklyOffDays: options.branchWeeklyOff ?? [] },
        ),
    },
    holiday: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          holidays.find(
            (h) =>
              h.date.getTime() === (where.date as Date).getTime() &&
              matchesBranchScope(h.branchId, where),
          ) ?? null,
        ),
      ),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
        const range = where.date as { gte: Date; lte: Date };
        return Promise.resolve(
          holidays
            .filter(
              (h) =>
                h.date >= range.gte &&
                h.date <= range.lte &&
                matchesBranchScope(h.branchId, where),
            )
            .map((h) => ({ date: h.date })),
        );
      }),
    },
  } as unknown as PrismaService;

  const settings = {
    get: jest.fn().mockResolvedValue(options.setting ?? '5,6'),
  } as unknown as SystemSettingsService;

  return new WorkingDaysService(prisma, settings);
}

/** Mirrors the `OR: [{ branchId: null }, { branchId }]` fragment under test. */
function matchesBranchScope(
  branchId: string | null,
  where: Record<string, unknown>,
): boolean {
  if (Array.isArray(where.OR)) {
    return (where.OR as Array<{ branchId: string | null }>).some(
      (clause) => clause.branchId === branchId,
    );
  }
  return where.branchId === branchId;
}

describe('WorkingDaysService.isoWeekdayOf', () => {
  it('reads a UTC-midnight date as its own weekday', () => {
    // 2026-08-24 is a Monday.
    expect(WorkingDaysService.isoWeekdayOf(day('2026-08-24'))).toBe(1);
    expect(WorkingDaysService.isoWeekdayOf(day('2026-08-28'))).toBe(5);
    expect(WorkingDaysService.isoWeekdayOf(day('2026-08-30'))).toBe(7);
  });

  it('survives a date read back as local midnight on an eastern server', () => {
    // Without the noon shift this is 2026-08-23T18:30Z and reports Sunday for a
    // Monday — every leave request east of Greenwich priced against the wrong
    // calendar, silently.
    expect(
      WorkingDaysService.isoWeekdayOf(asReadOnIstServer('2026-08-24')),
    ).toBe(1);
  });
});

describe('WorkingDaysService.parseWeeklyOffCsv', () => {
  it('keeps ISO weekdays and drops everything else', () => {
    expect(WorkingDaysService.parseWeeklyOffCsv('5,6')).toEqual([5, 6]);
    expect(WorkingDaysService.parseWeeklyOffCsv(' 5 , 7 ')).toEqual([5, 7]);
    // 0 is the Sunday of a 0-indexed calendar. This app is 1-indexed, so a 0 is
    // a value from somewhere else and is refused rather than read as Monday.
    expect(WorkingDaysService.parseWeeklyOffCsv('0,8,x,5')).toEqual([5]);
  });
});

describe('getWeeklyOffDays', () => {
  it('prefers the branch rest days over the global setting', async () => {
    const service = makeService({ branchWeeklyOff: [5], setting: '5,6' });
    await expect(service.getWeeklyOffDays('branch-1')).resolves.toEqual([5]);
  });

  it('falls back to the setting when the branch has none', async () => {
    // An EMPTY array means "inherit", not "this branch works seven days".
    const service = makeService({ branchWeeklyOff: [], setting: '5,6' });
    await expect(service.getWeeklyOffDays('branch-1')).resolves.toEqual([5, 6]);
  });

  it('falls back to Friday and Saturday when the setting is nonsense', async () => {
    const service = makeService({ branchWeeklyOff: [], setting: 'x' });
    await expect(service.getWeeklyOffDays('branch-1')).resolves.toEqual([5, 6]);
  });
});

describe('isHoliday', () => {
  it('matches a company-wide holiday for a branch-scoped caller', async () => {
    // The rule this covers: `branchId = x` never matches the NULL row, so a
    // plain equality would silently drop every national holiday.
    const service = makeService({
      holidays: [{ date: day('2026-11-18'), branchId: null }],
    });
    await expect(
      service.isHoliday(day('2026-11-18'), 'branch-1'),
    ).resolves.toBe(true);
  });

  it('matches a branch-specific holiday only at that branch', async () => {
    const service = makeService({
      holidays: [{ date: day('2026-08-05'), branchId: 'branch-1' }],
    });
    await expect(
      service.isHoliday(day('2026-08-05'), 'branch-1'),
    ).resolves.toBe(true);
    await expect(
      service.isHoliday(day('2026-08-05'), 'branch-2'),
    ).resolves.toBe(false);
  });
});

describe('getWorkingDatesBetween', () => {
  it('drops the branch weekly rest days', async () => {
    const service = makeService({ branchWeeklyOff: [5, 6] });
    // Thu 27 Aug 2026 → Mon 31 Aug. Friday and Saturday come out.
    const dates = await service.getWorkingDatesBetween(
      day('2026-08-27'),
      day('2026-08-31'),
      'branch-1',
    );
    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-08-27',
      '2026-08-30',
      '2026-08-31',
    ]);
  });

  it('drops holidays as well, and counts the rest', async () => {
    const service = makeService({
      branchWeeklyOff: [5, 6],
      holidays: [{ date: day('2026-08-31'), branchId: null }],
    });
    await expect(
      service.getWorkDaysBetween(
        day('2026-08-27'),
        day('2026-08-31'),
        'branch-1',
      ),
    ).resolves.toBe(2);
  });

  it('returns nothing when the range runs backwards', async () => {
    const service = makeService({ branchWeeklyOff: [5, 6] });
    await expect(
      service.getWorkingDatesBetween(day('2026-08-31'), day('2026-08-27')),
    ).resolves.toEqual([]);
  });

  it('normalises a date read back as local midnight to the day it means', async () => {
    const service = makeService({ branchWeeklyOff: [5, 6] });
    const dates = await service.getWorkingDatesBetween(
      asReadOnIstServer('2026-08-27'),
      asReadOnIstServer('2026-08-27'),
      'branch-1',
    );
    expect(dates.map((d) => d.toISOString())).toEqual([
      '2026-08-27T00:00:00.000Z',
    ]);
  });
});
