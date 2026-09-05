import { HolidaysService } from './holidays.service';

/**
 * July 2026 (independently worked out): Jul 1 is a Wednesday, 31 days.
 *   Fridays  = 3,10,17,24,31  (5)
 *   Saturdays= 4,11,18,25      (4)
 *   Sundays  = 5,12,19,26      (4)
 * So a Fri+Sat weekend leaves 22 working days; a Sunday-only weekend leaves 27.
 */
describe('HolidaysService work-day engine', () => {
  const makePrisma = (opts: {
    branchWeeklyOff?: string | null;
    globalWeeklyOff?: string | null;
    holidays?: { date: Date }[];
  }) => ({
    branch: {
      findUnique: jest.fn().mockResolvedValue(
        opts.branchWeeklyOff === undefined
          ? null
          : { weeklyOffDays: opts.branchWeeklyOff },
      ),
    },
    systemSetting: {
      findUnique: jest.fn().mockResolvedValue(
        opts.globalWeeklyOff === undefined
          ? null
          : { value: opts.globalWeeklyOff },
      ),
    },
    holiday: {
      findMany: jest.fn().mockResolvedValue(opts.holidays ?? []),
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  });

  const svc = (prisma: any) => new HolidaysService(prisma as any);

  it('uses the branch weekly-off days (Fri+Sat) for the work-day count', async () => {
    const prisma = makePrisma({ branchWeeklyOff: '5,6' });
    const res = await svc(prisma).getWorkDaysBreakdown(7, 2026, 'branch-1');

    expect(res.totalDays).toBe(31);
    expect(res.weekends).toBe(9); // 5 Fridays + 4 Saturdays
    expect(res.holidays).toBe(0);
    expect(res.workDays).toBe(22);
    expect(prisma.branch.findUnique).toHaveBeenCalled();
  });

  it('falls back to the global setting when the branch has no override', async () => {
    const prisma = makePrisma({ branchWeeklyOff: null, globalWeeklyOff: '0' });
    const res = await svc(prisma).getWorkDaysBreakdown(7, 2026, 'branch-1');

    expect(res.weekends).toBe(4); // Sundays only
    expect(res.workDays).toBe(27);
  });

  it('defaults to Sunday-only when nothing is configured', async () => {
    const prisma = makePrisma({}); // no branch id, no setting row
    const res = await svc(prisma).getWorkDaysInMonth(7, 2026);
    expect(res).toBe(27);
  });

  it('subtracts holidays that fall on a working day', async () => {
    const prisma = makePrisma({
      branchWeeklyOff: '5,6',
      holidays: [{ date: new Date(Date.UTC(2026, 6, 6)) }], // Mon Jul 6 — a work day
    });
    const res = await svc(prisma).getWorkDaysBreakdown(7, 2026, 'branch-1');
    expect(res.holidays).toBe(1);
    expect(res.workDays).toBe(21);
  });

  it('does not double-count a holiday that lands on a weekly-off day', async () => {
    const prisma = makePrisma({
      branchWeeklyOff: '5,6',
      holidays: [{ date: new Date(Date.UTC(2026, 6, 3)) }], // Fri Jul 3 — already off
    });
    const res = await svc(prisma).getWorkDaysBreakdown(7, 2026, 'branch-1');
    expect(res.weekends).toBe(9);
    expect(res.holidays).toBe(0);
    expect(res.workDays).toBe(22);
  });

  it('getWorkingDatesBetween skips weekly-off days and holidays', async () => {
    const prisma = makePrisma({
      branchWeeklyOff: '5,6',
      holidays: [{ date: new Date(Date.UTC(2026, 6, 6)) }], // Mon Jul 6 holiday
    });
    // Jul 3 (Fri, off) .. Jul 7 (Tue): working = Jul 5 (Sun), Jul 7 (Tue)
    const dates = await svc(prisma).getWorkingDatesBetween(
      new Date(Date.UTC(2026, 6, 3)),
      new Date(Date.UTC(2026, 6, 7)),
      'branch-1',
    );
    const iso = dates.map((d) => d.toISOString().split('T')[0]);
    expect(iso).toEqual(['2026-07-05', '2026-07-07']);
  });

  it('copyYear shifts each holiday to the target year and skips duplicates', async () => {
    const prisma = makePrisma({});
    prisma.holiday.findMany = jest.fn().mockResolvedValue([
      {
        name: 'National Day',
        date: new Date(Date.UTC(2025, 10, 18)),
        isRecurring: true,
        branchId: null,
        description: null,
      },
    ]);
    prisma.holiday.createMany = jest.fn().mockResolvedValue({ count: 1 });

    const res = await svc(prisma).copyYear(2025, 2026);

    const arg = prisma.holiday.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data[0].year).toBe(2026);
    expect(arg.data[0].date.toISOString().split('T')[0]).toBe('2026-11-18');
    expect(res.data.created).toBe(1);
  });

  /**
   * The paid-holiday day count for daily-wage staff, who are otherwise paid
   * strictly for days worked. A holiday that lands on a weekly-off day is
   * already an unpaid rest day and must not be paid a second time — which is
   * why holidayList (every holiday row) cannot be used for this.
   */
  describe('getPaidHolidayDatesInMonth', () => {
    it('returns holidays that displaced a working day', async () => {
      // Jul 2026: the 8th is a Wednesday, the 15th a Wednesday.
      const prisma = makePrisma({
        branchWeeklyOff: '5,6',
        holidays: [
          { date: new Date(Date.UTC(2026, 6, 8)) },
          { date: new Date(Date.UTC(2026, 6, 15)) },
        ],
      });
      await expect(
        svc(prisma).getPaidHolidayDatesInMonth(7, 2026, 'branch-1'),
      ).resolves.toEqual(['2026-07-08', '2026-07-15']);
    });

    it('excludes a holiday that falls on a weekly-off day', async () => {
      // Jul 3 2026 is a Friday, which is a weekly off under 5,6.
      const prisma = makePrisma({
        branchWeeklyOff: '5,6',
        holidays: [
          { date: new Date(Date.UTC(2026, 6, 3)) },
          { date: new Date(Date.UTC(2026, 6, 8)) },
        ],
      });
      await expect(
        svc(prisma).getPaidHolidayDatesInMonth(7, 2026, 'branch-1'),
      ).resolves.toEqual(['2026-07-08']);
    });

    it('is branch-scoped through the same filter as the work-day count', async () => {
      const prisma = makePrisma({ branchWeeklyOff: '5,6', holidays: [] });
      await svc(prisma).getPaidHolidayDatesInMonth(7, 2026, 'branch-1');
      expect(prisma.branch.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'branch-1' } }),
      );
      expect(prisma.holiday.findMany).toHaveBeenCalled();
    });

    it('no holidays → empty list, never undefined', async () => {
      const prisma = makePrisma({ branchWeeklyOff: '5,6', holidays: [] });
      await expect(
        svc(prisma).getPaidHolidayDatesInMonth(7, 2026, 'branch-1'),
      ).resolves.toEqual([]);
    });
  });

  /**
   * isWeeklyOff — timezone-safety tests
   *
   * Postgres DATE columns are returned by Prisma as midnight in the server's
   * LOCAL timezone. On an IST (+5:30) server "2026-08-24" (Monday) arrives as
   * 2026-08-23T18:30:00.000Z whose raw UTC day is 0 (Sunday). On an SGT (+8)
   * server the same date arrives as 2026-08-23T16:00:00.000Z, also Sunday.
   *
   * The noon-normalisation (+12 h) added to isWeeklyOff must fix this for all
   * timezones the clients (SG, IN) actually use.
   */
  describe('isWeeklyOff — timezone-aware day classification', () => {
    /** Weekly-off = Sunday only (the production default: "0") */
    const sundayOnlyPrisma = () =>
      makePrisma({ branchWeeklyOff: null, globalWeeklyOff: '0' });

    it('Monday 2026-08-24 → NOT a weekly-off day (UTC midnight input)', async () => {
      // Input as a plain YYYY-MM-DD parse: new Date('2026-08-24') = UTC midnight
      // UTC day = 1 (Monday). Should NOT be a rest day.
      const date = new Date('2026-08-24'); // 2026-08-24T00:00:00.000Z
      const result = await svc(sundayOnlyPrisma()).isWeeklyOff(date, undefined);
      expect(result).toBe(false);
    });

    it('Sunday 2026-08-23 → IS a weekly-off day (UTC midnight input)', async () => {
      const date = new Date('2026-08-23'); // 2026-08-23T00:00:00.000Z, UTC day = 0
      const result = await svc(sundayOnlyPrisma()).isWeeklyOff(date, undefined);
      expect(result).toBe(true);
    });

    it('Monday 2026-08-24 as IST local-midnight → NOT a weekly-off day', async () => {
      // IST server: Prisma returns "2026-08-24" as 2026-08-23T18:30:00.000Z
      // Raw UTC day = 0 (Sunday) — this is the bug. The fix must return false.
      const istMidnight = new Date('2026-08-23T18:30:00.000Z');
      const result = await svc(sundayOnlyPrisma()).isWeeklyOff(istMidnight, undefined);
      expect(result).toBe(false); // still Monday in IST
    });

    it('Monday 2026-08-24 as SGT local-midnight → NOT a weekly-off day', async () => {
      // SGT server (+8): Prisma returns "2026-08-24" as 2026-08-23T16:00:00.000Z
      // Raw UTC day = 0 (Sunday) — same bug, different offset. Fix must return false.
      const sgtMidnight = new Date('2026-08-23T16:00:00.000Z');
      const result = await svc(sundayOnlyPrisma()).isWeeklyOff(sgtMidnight, undefined);
      expect(result).toBe(false); // still Monday in SGT
    });

    it('Sunday 2026-08-23 as IST local-midnight → IS a weekly-off day', async () => {
      // IST: "2026-08-23" → 2026-08-22T18:30:00.000Z, UTC day = 6 (Saturday)
      // After +12h: 2026-08-23T06:30:00.000Z, UTC day = 0 (Sunday) ✓
      const istMidnight = new Date('2026-08-22T18:30:00.000Z');
      const result = await svc(sundayOnlyPrisma()).isWeeklyOff(istMidnight, undefined);
      expect(result).toBe(true);
    });

    it('Sunday 2026-08-23 as SGT local-midnight → IS a weekly-off day', async () => {
      // SGT: "2026-08-23" → 2026-08-22T16:00:00.000Z, UTC day = 6 (Saturday)
      // After +12h: 2026-08-23T04:00:00.000Z, UTC day = 0 (Sunday) ✓
      const sgtMidnight = new Date('2026-08-22T16:00:00.000Z');
      const result = await svc(sundayOnlyPrisma()).isWeeklyOff(sgtMidnight, undefined);
      expect(result).toBe(true);
    });

    it('Fri+Sat weekend (Middle-East branches) — Friday as SGT local-midnight is a weekly-off', async () => {
      // Fri+Sat branch. Friday 2026-08-21 as SGT → 2026-08-20T16:00:00.000Z (Thursday UTC)
      // After +12h → 2026-08-21T04:00:00.000Z, UTC day = 5 (Friday) ✓
      const prisma = makePrisma({ branchWeeklyOff: '5,6' });
      const sgtFri = new Date('2026-08-20T16:00:00.000Z'); // Fri Aug 21 SGT midnight
      expect(await svc(prisma).isWeeklyOff(sgtFri, 'branch-1')).toBe(true);
    });

    it('Fri+Sat weekend — Thursday as SGT local-midnight is NOT a weekly-off', async () => {
      const prisma = makePrisma({ branchWeeklyOff: '5,6' });
      const sgtThu = new Date('2026-08-19T16:00:00.000Z'); // Thu Aug 20 SGT midnight
      expect(await svc(prisma).isWeeklyOff(sgtThu, 'branch-1')).toBe(false);
    });

    it('falls back to Sunday-only default when no setting exists', async () => {
      const prisma = makePrisma({}); // neither branch nor global setting
      // Sunday as IST midnight
      const istSun = new Date('2026-08-22T18:30:00.000Z');
      expect(await svc(prisma).isWeeklyOff(istSun, undefined)).toBe(true);
    });

    it('Monday passed as exact UTC midnight (no timezone shift) remains correct', async () => {
      // Edge case: no timezone shift (UTC server or string input). Must still work.
      const utcMon = new Date('2026-08-24T00:00:00.000Z');
      expect(await svc(sundayOnlyPrisma()).isWeeklyOff(utcMon, undefined)).toBe(false);
    });
  });

});
