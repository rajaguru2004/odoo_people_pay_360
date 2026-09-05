import { CalendarService } from './calendar.service';

/**
 * Roster coverage and conflicts for a week.
 *
 * The Schedules hub previously counted schedules and called it a KPI, which
 * says nothing: 36 shifts is neither good nor bad. These three are the
 * questions a scheduler actually has, and the last two are conflicts the
 * roster is perfectly happy to contain — the existing conflict check is
 * per-employee and only fires while somebody is editing one person.
 */
describe('CalendarService.coverageStats', () => {
  let schedules: any[];
  let holidays: any[];
  let weeklyOffDays: number[];

  const prisma: any = {
    workSchedule: { findMany: jest.fn(async () => schedules) },
    employee: { count: jest.fn(async () => 10) },
  };
  const holidaysSvc: any = {
    getHolidaysInRange: jest.fn(async () => holidays),
    getWeeklyOffDays: jest.fn(async () => weeklyOffDays),
  };

  const service = new CalendarService(prisma, holidaysSvc);

  beforeEach(() => {
    jest.clearAllMocks();
    // Monday 2026-08-17 to Sunday 2026-08-23.
    schedules = [
      { employeeId: 'e1', date: new Date('2026-08-17'), employee: { fullName: 'Asha' } },
      { employeeId: 'e2', date: new Date('2026-08-17'), employee: { fullName: 'Karim' } },
      { employeeId: 'e1', date: new Date('2026-08-18'), employee: { fullName: 'Asha' } },
      // On the public holiday.
      { employeeId: 'e3', date: new Date('2026-08-20'), employee: { fullName: 'Meera' } },
      // On the branch's weekly off (Sunday = 0).
      { employeeId: 'e2', date: new Date('2026-08-23'), employee: { fullName: 'Karim' } },
    ];
    holidays = [{ date: new Date('2026-08-20'), name: 'National Day' }];
    weeklyOffDays = [0];
  });

  const run = () => service.coverageStats('2026-08-17', '2026-08-23');

  it('counts the people with no shift as a set difference against active staff', async () => {
    const res: any = await run();
    // Three distinct people rostered out of ten active.
    expect(res.data.scheduledEmployees).toBe(3);
    expect(res.data.unscheduled).toBe(7);
  });

  it('flags anybody rostered on a company holiday', async () => {
    const res: any = await run();
    expect(res.data.conflicts.onHoliday).toBe(1);
    expect(res.data.conflicts.samples.some((s: any) => s.holiday === 'National Day')).toBe(true);
  });

  it("flags anybody rostered on their branch's weekly off", async () => {
    const res: any = await run();
    expect(res.data.conflicts.onWeeklyOff).toBe(1);
  });

  it('reports every date in the window, including the empty ones', async () => {
    // A day missing from the roster is exactly what this is looking for, so it
    // cannot be omitted just because no row mentions it.
    const res: any = await run();
    expect(res.data.byDay).toHaveLength(7);
    expect(res.data.byDay.find((d: any) => d.date === '2026-08-19').scheduled).toBe(0);
  });

  it('picks the thinnest working day and ignores holidays when doing so', async () => {
    // The 20th has one shift but is a holiday — being quiet on a holiday is
    // not a coverage gap, and naming it would send somebody to fix nothing.
    const res: any = await run();
    expect(res.data.thinnestDay.date).not.toBe('2026-08-20');
    expect(res.data.thinnestDay.scheduled).toBe(0);
  });
});
