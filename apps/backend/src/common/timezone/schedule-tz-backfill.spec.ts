import type { PrismaClient } from '@prisma/client';
import { backfillScheduleTimezone } from '../../../prisma/backfill-schedule-timezone';

/**
 * The deploy-time repair for schedules stored in the browser's timezone instead
 * of the company's. It rewrites live data on every container start, so the
 * guards matter more than the arithmetic: run once, never when the delta is
 * zero, never outside the configured window.
 */
describe('backfillScheduleTimezone', () => {
  const ROW = {
    id: 'ws-1',
    // 08:00 typed in Asia/Kolkata → stored 02:30Z. Intended: 08:00 SGT = 00:00Z.
    startTime: new Date('2026-06-11T02:30:00.000Z'),
    endTime: new Date('2026-06-11T13:30:00.000Z'),
    priorEmailSent: true,
    postEmailSent: false,
  };

  const makePrisma = (over: { marker?: unknown; tz?: string; rows?: unknown[] } = {}) => {
    const updates: any[] = [];
    const upserts: any[] = [];
    const prisma = {
      systemSetting: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(
            where.key === 'system_timezone'
              ? { value: over.tz ?? 'Asia/Singapore' }
              : (over.marker ?? null),
          ),
        ),
        upsert: jest.fn((args: any) => {
          upserts.push(args);
          return Promise.resolve({});
        }),
      },
      workSchedule: {
        findMany: jest.fn(() => Promise.resolve(over.rows ?? [ROW])),
        update: jest.fn((args: any) => {
          updates.push(args);
          return Promise.resolve({});
        }),
      },
    };
    return { prisma: prisma as unknown as PrismaClient, updates, upserts, raw: prisma };
  };

  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.SCHEDULE_TZ_BACKFILL_ENTRY_TZ = 'Asia/Kolkata';
    process.env.SCHEDULE_TZ_BACKFILL_FROM = 'all';
    delete process.env.SCHEDULE_TZ_BACKFILL_SKIP;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  it('moves the stored instant to the company wall clock the admin typed', async () => {
    const { prisma, updates } = makePrisma();
    await backfillScheduleTimezone(prisma);

    expect(updates).toHaveLength(1);
    // 02:30Z − 2h30m = 00:00Z, i.e. 08:00 Asia/Singapore.
    expect(updates[0].data.startTime.toISOString()).toBe('2026-06-11T00:00:00.000Z');
    expect(updates[0].data.endTime.toISOString()).toBe('2026-06-11T11:00:00.000Z');
  });

  it('does nothing on a second deploy — the marker short-circuits it', async () => {
    const { prisma, raw } = makePrisma({ marker: { value: '{"shifted":3}' } });
    await backfillScheduleTimezone(prisma);
    expect(raw.workSchedule.findMany).not.toHaveBeenCalled();
    expect(raw.workSchedule.update).not.toHaveBeenCalled();
  });

  it('writes the marker so the next deploy is a no-op', async () => {
    const { prisma, upserts } = makePrisma();
    await backfillScheduleTimezone(prisma);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].where.key).toBe('schedule_tz_backfill_v1');
    expect(JSON.parse(upserts[0].create.value)).toMatchObject({
      entryTZ: 'Asia/Kolkata',
      companyTZ: 'Asia/Singapore',
      shifted: 1,
    });
  });

  it('touches nothing when the entry zone IS the company zone', async () => {
    // The common deployment: admins sit in the company's own timezone, so the
    // old code stored the right instant and a shift would corrupt it.
    const { prisma, raw } = makePrisma({ tz: 'Asia/Kolkata' });
    await backfillScheduleTimezone(prisma);
    expect(raw.workSchedule.update).not.toHaveBeenCalled();
    expect(raw.systemSetting.upsert).toHaveBeenCalled(); // still marked done
  });

  it('honours SCHEDULE_TZ_BACKFILL_SKIP', async () => {
    process.env.SCHEDULE_TZ_BACKFILL_SKIP = '1';
    const { prisma, raw } = makePrisma();
    await backfillScheduleTimezone(prisma);
    expect(raw.systemSetting.findUnique).not.toHaveBeenCalled();
  });

  it('defaults to repairing today onward, not history', async () => {
    delete process.env.SCHEDULE_TZ_BACKFILL_FROM;
    const { prisma, raw } = makePrisma();
    await backfillScheduleTimezone(prisma);
    const where = (raw.workSchedule.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.date.gte).toBeInstanceOf(Date);
    expect(where.shiftType).toEqual({ not: 'FLEXIBLE' });
  });

  it('scans every date when SCHEDULE_TZ_BACKFILL_FROM=all', async () => {
    const { prisma, raw } = makePrisma();
    await backfillScheduleTimezone(prisma);
    const where = (raw.workSchedule.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.date).toBeUndefined();
  });

  it('re-arms the reminder flags for a shift that is still upcoming', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000);
    const { prisma, updates } = makePrisma({
      rows: [{ ...ROW, startTime: future, endTime: new Date(future.getTime() + 3_600_000) }],
    });
    await backfillScheduleTimezone(prisma);
    // The prior reminder already went out against the WRONG time; it has to be
    // allowed to fire again at the corrected one.
    expect(updates[0].data.priorEmailSent).toBe(false);
    expect(updates[0].data.postEmailSent).toBe(false);
  });

  it('leaves the flags alone for a shift already in the past', async () => {
    const { prisma, updates } = makePrisma();
    await backfillScheduleTimezone(prisma);
    expect(updates[0].data.priorEmailSent).toBeUndefined();
  });

  it('ignores an invalid entry zone instead of shifting by a garbage delta', async () => {
    process.env.SCHEDULE_TZ_BACKFILL_ENTRY_TZ = 'Mars/Olympus_Mons';
    const { prisma, raw } = makePrisma();
    await backfillScheduleTimezone(prisma);
    expect(raw.workSchedule.update).not.toHaveBeenCalled();
    expect(raw.systemSetting.upsert).not.toHaveBeenCalled(); // retried next deploy
  });
});
