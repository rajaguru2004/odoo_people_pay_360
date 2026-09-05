import { BadRequestException } from '@nestjs/common';
import { SchedulesHubService } from './schedules-hub.service';

/**
 * The Schedules module hub.
 *
 * The interesting cases are all about NOT lying:
 *
 *  1. A closed day expects nobody. Without that, every Friday in Muscat draws a
 *     full-height "unassigned" bar and a perfectly covered week reads as a
 *     disaster.
 *  2. "Coverage gaps" is measured against the window's OWN median, because a
 *     six-person branch and a six-hundred-person one have different normals.
 *  3. FLEXIBLE shifts have no window at all, so they cannot sit on an hour axis.
 *     They are excluded from the curve AND counted, so the panel can say so
 *     rather than quietly under-drawing the morning.
 *  4. A department that rostered nobody IS 0% — unlike attendance, where a
 *     missing row means the punches never arrived, a missing roster row is the
 *     answer. Only a department with nobody active in it is unknown.
 *  5. Overlap uses the one half-open rule from `calendar.service.ts`: shifts
 *     that merely touch are a split day, and FLEXIBLE is date-level exclusive.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const at = (iso: string, hhmm: string) => new Date(`${iso}T${hhmm}:00.000Z`);

/** Monday 2026-08-17 .. Sunday 2026-08-23. */
const MON = '2026-08-17';
const TUE = '2026-08-18';
const WED = '2026-08-19';
const THU = '2026-08-20';
const FRI = '2026-08-21';
const SAT = '2026-08-22';
const SUN = '2026-08-23';

interface Row {
  employeeId: string;
  date: Date;
  shiftType: string;
  startTime: Date | null;
  endTime: Date | null;
  employee: {
    fullName: string;
    branchId: string | null;
    departmentId: string | null;
    department: { id: string; name: string } | null;
  };
}

function row(
  employeeId: string,
  date: string,
  shiftType = 'FULL_DAY',
  times: [string, string] | null = ['08:00', '17:00'],
  dept: { id: string; name: string } | null = { id: 'd1', name: 'Operations' },
  fullName = employeeId,
): Row {
  return {
    employeeId,
    date: d(date),
    shiftType,
    startTime: times ? at(date, times[0]) : null,
    endTime: times ? at(date, times[1]) : null,
    employee: {
      fullName,
      branchId: 'b1',
      departmentId: dept?.id ?? null,
      department: dept,
    },
  };
}

describe('SchedulesHubService', () => {
  let schedules: Row[];
  let holidays: Array<{ date: Date; name: string }>;
  let weeklyOff: number[];
  /** Dates each branch is actually open. Defaults to Mon–Fri of the test week. */
  let workingDates: Date[];
  let headcountByBranch: Array<{ branchId: string | null; _count: { _all: number } }>;
  let headcountByDept: Array<{ departmentId: string | null; _count: { _all: number } }>;
  let unscheduledPeople: Array<{ fullName: string }>;
  let departmentRows: Array<{ id: string; name: string }>;

  const prisma: any = {
    workSchedule: { findMany: jest.fn(async () => schedules) },
    department: { findMany: jest.fn(async () => departmentRows) },
    employee: {
      groupBy: jest.fn(async (args: any) =>
        args.by?.[0] === 'branchId' ? headcountByBranch : headcountByDept,
      ),
      findMany: jest.fn(async () => unscheduledPeople),
    },
  };
  const holidaysSvc: any = {
    getWorkingDatesBetween: jest.fn(async () => workingDates),
    getHolidaysInRange: jest.fn(async () => holidays),
    getWeeklyOffDays: jest.fn(async () => weeklyOff),
  };

  const svc = new SchedulesHubService(prisma, holidaysSvc);
  const summary = (period: any = 'week', anchor = MON) =>
    svc.getHubSummary(period, anchor).then((r: any) => r.data);

  beforeEach(() => {
    jest.clearAllMocks();
    // Ten active people, all in one branch and one department.
    headcountByBranch = [{ branchId: 'b1', _count: { _all: 10 } }];
    headcountByDept = [{ departmentId: 'd1', _count: { _all: 10 } }];
    unscheduledPeople = [{ fullName: 'Unrostered Ursula' }];
    departmentRows = [
      { id: 'd1', name: 'Operations' },
      { id: 'd2', name: 'Sales' },
      { id: 'd3', name: 'Legal' },
    ];
    // Mon–Fri open, Sat/Sun closed.
    workingDates = [MON, TUE, WED, THU, FRI].map(d);
    holidays = [];
    weeklyOff = [6, 0]; // Saturday and Sunday
    schedules = [
      row('e1', MON), row('e2', MON), row('e3', MON),
      row('e1', TUE), row('e2', TUE), row('e3', TUE),
      row('e1', WED), row('e2', WED), row('e3', WED),
      row('e1', THU), row('e2', THU), row('e3', THU),
      row('e1', FRI), row('e2', FRI), row('e3', FRI),
    ];
  });

  it('refuses a period it does not understand instead of guessing', async () => {
    await expect(svc.getHubSummary('quarter' as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an anchor that is not a real date', async () => {
    await expect(svc.getHubSummary('week', '2026-13-45')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.getHubSummary('week', 'last-monday')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('measures coverage against active headcount, not against shift rows', async () => {
    const s = await summary();
    // 3 of 10 people have a shift somewhere in the week; 15 rows is not the story.
    expect(s.periodStats.scheduledEmployees).toBe(3);
    expect(s.periodStats.unscheduled).toBe(7);
    expect(s.periodStats.shiftRows).toBe(15);
    expect(s.periodStats.coverageRate).toBe(30);
  });

  it('expects nobody on a day the branch calendar is closed', async () => {
    const s = await summary();
    const sat = s.trend.find((b: any) => b.key === SAT);
    const mon = s.trend.find((b: any) => b.key === MON);
    // The weekend is still on the axis — a missing bar reads as missing data —
    // but it expects nobody, so it draws no unassigned block.
    expect(sat.expected).toBe(0);
    expect(sat.unassigned).toBe(0);
    expect(sat.coverageRate).toBeNull();
    expect(mon.expected).toBe(10);
    expect(mon.scheduled).toBe(3);
    expect(mon.unassigned).toBe(7);
  });

  it('counts working days from the branch calendar, not from the window length', async () => {
    const s = await summary();
    expect(s.periodStats.workingDays).toBe(5); // seven days, five of them open
  });

  it('never claims more than 100% coverage when a closed branch is rostered', async () => {
    // The calendar is per BRANCH; the roster is company-wide. Branch A rests
    // Saturday, so Saturday expects nobody from it — but three people from a
    // branch that works Saturdays are legitimately on the roster. Dividing one
    // by the other reported 150% on real data (caught by SHUB-04).
    workingDates = [MON, TUE, WED, THU, FRI, SAT].map(d);
    headcountByBranch = [{ branchId: 'b1', _count: { _all: 2 } }];
    headcountByDept = [{ departmentId: 'd1', _count: { _all: 2 } }];
    schedules = [row('e1', SAT), row('e2', SAT), row('e3', SAT)];
    const s = await summary();
    const sat = s.trend.find((b: any) => b.key === SAT);
    expect(sat.scheduled).toBe(3);
    expect(sat.expected).toBe(2);
    expect(sat.coverageRate).toBe(100);
  });

  it('never draws a negative unassigned block when people work a closed day', async () => {
    schedules.push(row('e4', SAT), row('e5', SAT), row('e6', SAT));
    const s = await summary();
    const sat = s.trend.find((b: any) => b.key === SAT);
    expect(sat.scheduled).toBe(3);
    expect(sat.expected).toBe(0);
    // Rostered on a closed day is a CONFLICT, counted below — not negative
    // unassignment, which would draw a bar hanging off the axis.
    expect(sat.unassigned).toBe(0);
    expect(s.periodStats.conflicts.onWeeklyOff).toBe(3);
  });

  it('counts a holiday roster as a conflict and names who is on it', async () => {
    holidays = [{ date: d(THU), name: 'National Day' }];
    workingDates = [MON, TUE, WED, FRI].map(d);
    const s = await summary();
    expect(s.periodStats.conflicts.onHoliday).toBe(3);
    expect(s.attention.onHoliday.samples[0]).toMatchObject({
      date: THU,
      holiday: 'National Day',
    });
    expect(s.holidays).toEqual([{ date: THU, name: 'National Day' }]);
  });

  it('measures coverage gaps against the window own median, not a fixed number', async () => {
    // Mon/Tue/Wed have 3, Thu has 1, Fri has 1. Median of [1,1,3,3,3] is 3, so
    // the two thin days are the gaps.
    schedules = [
      row('e1', MON), row('e2', MON), row('e3', MON),
      row('e1', TUE), row('e2', TUE), row('e3', TUE),
      row('e1', WED), row('e2', WED), row('e3', WED),
      row('e1', THU),
      row('e1', FRI),
    ];
    const s = await summary();
    expect(s.periodStats.coverageGaps).toBe(2);
  });

  it('reports no coverage gaps when the window is too short to have a middle', async () => {
    workingDates = [MON, TUE].map(d);
    const s = await summary();
    // Two working days have no meaningful median; a number here would be noise.
    expect(s.periodStats.coverageGaps).toBe(0);
  });

  it('names the thinnest working day and ignores the closed ones', async () => {
    schedules = [
      row('e1', MON), row('e2', MON), row('e3', MON),
      row('e1', TUE), row('e2', TUE),
      row('e1', WED), row('e2', WED), row('e3', WED),
      row('e1', THU), row('e2', THU), row('e3', THU),
      row('e1', FRI), row('e2', FRI), row('e3', FRI),
    ];
    const s = await summary();
    // Saturday has zero, but being quiet on a closed day is not a coverage gap
    // and naming it would send somebody to fix nothing.
    expect(s.attention.thinnestDay).toEqual({
      date: TUE,
      label: 'Aug 18',
      scheduled: 2,
    });
  });

  describe('shift mix', () => {
    it('reports the six shift types the enum actually has, in reading order', async () => {
      schedules = [
        row('e1', MON, 'MORNING', ['08:00', '12:00']),
        row('e2', MON, 'MORNING', ['08:00', '12:00']),
        row('e3', MON, 'NIGHT', ['18:00', '22:00']),
        row('e4', MON, 'AFTERNOON', ['13:00', '17:00']),
      ];
      const s = await summary();
      expect(s.shiftMix.map((x: any) => x.type)).toEqual([
        'MORNING',
        'AFTERNOON',
        'NIGHT',
      ]);
      // There is no EVENING in ShiftType; the panel shows what exists.
      expect(s.shiftMix.find((x: any) => x.type === 'MORNING')).toMatchObject({
        count: 2,
        employees: 2,
        share: 50,
      });
    });
  });

  describe('staff coverage curve', () => {
    it('places a shift on every hour it spans', async () => {
      schedules = [row('e1', MON, 'MORNING', ['08:00', '12:00'])];
      workingDates = [d(MON)];
      const s = await svc.getHubSummary('today', MON).then((r: any) => r.data);
      const on = (h: number) => s.staffCoverage.hours[h].onShift;
      expect(on(7)).toBe(0);
      expect(on(8)).toBe(1);
      expect(on(11)).toBe(1);
      expect(on(12)).toBe(0); // half-open: the shift is over at 12
    });

    it('counts a night shift on both sides of midnight', async () => {
      schedules = [row('e1', MON, 'NIGHT', ['22:00', '06:00'])];
      const s = await svc.getHubSummary('today', MON).then((r: any) => r.data);
      const on = (h: number) => s.staffCoverage.hours[h].onShift;
      // A scheduler asking "who is on at 2 AM" means it literally.
      expect(on(22)).toBe(1);
      expect(on(23)).toBe(1);
      expect(on(2)).toBe(1);
      expect(on(5)).toBe(1);
      expect(on(6)).toBe(0);
      expect(on(12)).toBe(0);
    });

    it('excludes FLEXIBLE from the curve and says how many it excluded', async () => {
      schedules = [
        row('e1', MON, 'MORNING', ['08:00', '12:00']),
        row('e2', MON, 'FLEXIBLE', null),
        row('e3', MON, 'FLEXIBLE', null),
      ];
      const s = await svc.getHubSummary('today', MON).then((r: any) => r.data);
      expect(s.staffCoverage.hours[9].onShift).toBe(1);
      // Reported, not silently dropped — otherwise the morning reads as thin.
      expect(s.staffCoverage.flexibleExcluded).toBe(2);
    });

    it('carries the active headcount as the baseline to read the curve against', async () => {
      const s = await summary();
      expect(s.staffCoverage.activeBaseline).toBe(10);
    });
  });

  describe('overlap sweep', () => {
    it('allows two shifts that merely touch at the boundary', async () => {
      schedules = [
        row('e1', MON, 'MORNING', ['08:00', '12:00']),
        row('e1', MON, 'AFTERNOON', ['12:00', '17:00']),
      ];
      const s = await summary();
      // Half-open intervals: `end == start` is a split day, not an overlap.
      expect(s.periodStats.conflicts.overlaps).toBe(0);
    });

    it('catches two shifts that genuinely overlap', async () => {
      schedules = [
        row('e1', MON, 'MORNING', ['08:00', '13:00']),
        row('e1', MON, 'AFTERNOON', ['12:00', '17:00']),
      ];
      const s = await summary();
      expect(s.periodStats.conflicts.overlaps).toBe(1);
      expect(s.attention.overlaps.samples[0]).toMatchObject({
        employeeId: 'e1',
        date: MON,
      });
    });

    it('treats FLEXIBLE as exclusive for the whole date', async () => {
      schedules = [
        row('e1', MON, 'FLEXIBLE', null),
        row('e1', MON, 'MORNING', ['08:00', '12:00']),
      ];
      const s = await summary();
      // FLEXIBLE has no window for anything to fit around.
      expect(s.periodStats.conflicts.overlaps).toBe(1);
    });

    it('does not compare shifts on different dates', async () => {
      schedules = [
        row('e1', MON, 'MORNING', ['08:00', '12:00']),
        row('e1', TUE, 'MORNING', ['08:00', '12:00']),
      ];
      const s = await summary();
      expect(s.periodStats.conflicts.overlaps).toBe(0);
    });
  });

  describe('department ranking', () => {
    it('calls a department that rostered nobody 0%, because that is the fact', async () => {
      headcountByDept = [
        { departmentId: 'd1', _count: { _all: 6 } },
        { departmentId: 'd2', _count: { _all: 4 } },
      ];
      const s = await summary();
      const quiet = s.departments.find((x: any) => x.id === 'd2');
      // Unlike attendance, where "filed nothing" means the punches never
      // arrived, an absent roster row IS the answer: four people, none of them
      // scheduled. An em dash here would hide the department most in need of
      // rostering, which is the whole point of the panel.
      expect(quiet.hasData).toBe(true);
      expect(quiet.rate).toBe(0);
      expect(quiet.unscheduled).toBe(4);
      // ...and it therefore sorts to the top, ahead of the fully covered one.
      expect(s.departments[0].id).toBe('d2');
    });

    it('names a department that has no roster rows at all', async () => {
      // Caught by the first screenshot: names were learned from the ROSTER, so
      // a department with people and no shifts rendered as a bar labelled "—"
      // at 0% — which reads as broken data rather than as the department most
      // in need of rostering. They come from the department table now.
      headcountByDept = [
        { departmentId: 'd1', _count: { _all: 6 } },
        { departmentId: 'd2', _count: { _all: 4 } },
      ];
      const s = await summary();
      const quiet = s.departments.find((x: any) => x.id === 'd2');
      expect(quiet.name).toBe('Sales');
      expect(quiet.rate).toBe(0);
    });

    it('says unknown for a department with nobody active in it', async () => {
      headcountByDept = [
        { departmentId: 'd1', _count: { _all: 10 } },
        { departmentId: 'd3', _count: { _all: 0 } },
      ];
      const s = await summary();
      const empty = s.departments.find((x: any) => x.id === 'd3');
      // Nothing to divide by. Not a coverage problem — an empty row, sorted last.
      expect(empty.hasData).toBe(false);
      expect(empty.rate).toBeNull();
      expect(s.departments[s.departments.length - 1].id).toBe('d3');
    });

    it('puts the worst-covered department with data first', async () => {
      headcountByDept = [
        { departmentId: 'd1', _count: { _all: 3 } },
        { departmentId: 'd2', _count: { _all: 10 } },
      ];
      schedules = [
        row('e1', MON, 'FULL_DAY', ['08:00', '17:00'], { id: 'd1', name: 'Operations' }),
        row('e2', MON, 'FULL_DAY', ['08:00', '17:00'], { id: 'd1', name: 'Operations' }),
        row('e3', MON, 'FULL_DAY', ['08:00', '17:00'], { id: 'd1', name: 'Operations' }),
        row('e9', MON, 'FULL_DAY', ['08:00', '17:00'], { id: 'd2', name: 'Sales' }),
      ];
      const s = await summary();
      expect(s.departments[0]).toMatchObject({ id: 'd2', rate: 10, hasData: true });
      expect(s.departments[1]).toMatchObject({ id: 'd1', rate: 100 });
    });
  });

  describe('the window before it', () => {
    it('compares every window with the same window one step back', async () => {
      const s = await summary('week', MON);
      expect(s.previousRange.start).toBe('2026-08-10');
      expect(s.previousRange.end).toBe('2026-08-16');
      expect(s.previousStats).toBeDefined();
      expect(s.previousStats.activeHeadcount).toBe(10);
    });

    it('offers the anchors to page with and labels the window server-side', async () => {
      const s = await summary('week', MON);
      expect(s.range).toMatchObject({
        start: MON,
        end: SUN,
        label: 'Aug 17 – 23',
        prevAnchor: '2026-08-10',
        nextAnchor: '2026-08-24',
      });
    });

    it('rolls a year up into months', async () => {
      const s = await summary('year', '2026-08-17');
      expect(s.trendKind).toBe('month');
      expect(s.trend).toHaveLength(12);
      expect(s.trend[0].label).toBe('Jan');
      expect(s.trend[7].key).toBe('2026-08');
    });
  });

  describe('the action queue', () => {
    it('names the people with no shift at all', async () => {
      const s = await summary();
      expect(s.attention.unassigned.count).toBe(7);
      expect(s.attention.unassigned.names).toContain('Unrostered Ursula');
    });

    it('leaves the donut slices summing to something the caption can name', async () => {
      holidays = [{ date: d(THU), name: 'National Day' }];
      workingDates = [MON, TUE, WED, FRI].map(d);
      const s = await summary();
      // e1/e2/e3 are all rostered on the holiday, so none of them is cleanly
      // assigned; the slice must not double-count them.
      expect(s.status.onHoliday).toBe(3);
      expect(s.status.assigned).toBe(0);
      expect(s.status.unassigned).toBe(7);
    });
  });

  describe('an empty roster', () => {
    it('says unknown rather than 0% when nothing is scheduled at all', async () => {
      schedules = [];
      unscheduledPeople = [{ fullName: 'Asha' }];
      const s = await summary();
      expect(s.periodStats.scheduledEmployees).toBe(0);
      expect(s.periodStats.unscheduled).toBe(10);
      expect(s.shiftMix).toEqual([]);
      expect(s.attention.unassigned.count).toBe(10);
    });

    it('reports no coverage at all rather than dividing by nobody', async () => {
      headcountByBranch = [];
      headcountByDept = [];
      schedules = [];
      unscheduledPeople = [];
      const s = await summary();
      expect(s.periodStats.activeHeadcount).toBe(0);
      // Zero people cannot be 0% covered — that is a claim about nobody.
      expect(s.periodStats.coverageRate).toBeNull();
    });
  });
});
