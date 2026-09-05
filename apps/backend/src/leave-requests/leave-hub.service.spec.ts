import { BadRequestException } from '@nestjs/common';
import { LeaveHubService } from './leave-hub.service';

/**
 * The Leave & Overtime module hub.
 *
 * The cases that matter are the ones the endpoints this replaces got wrong or
 * never had to face:
 *
 *  1. A request straddling the window boundary is PRORATED. `company-overview`
 *     is year-scoped so it never met the question; a month view that charged
 *     August for September's days would be a confident wrong answer.
 *  2. CANCELLED is counted. `getCompanyLeaveOverview` counts only
 *     PENDING/APPROVED/REJECTED, so the donut's four slices would not sum to
 *     the caption above them.
 *  3. Overtime averages divide by employees WITH overtime, not by headcount —
 *     "the average person did 0.4 hours" is not a sentence anybody wanted.
 *  4. `overtime_enabled` off means the block says so, rather than reporting
 *     zeros that read as "nobody worked late".
 *  5. Balance is a YEAR fact scoped to the year the window ends in, and
 *     `remaining` is computed, because there is no such column.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const AUG = '2026-08-15'; // an anchor inside August 2026
/**
 * A MONDAY. Deliberately not the anchor: 2026-08-15 is a Saturday, and "on
 * leave today" counts working days — you are not on leave on a day the branch
 * was closed. A fixture that picked a weekend would report nobody on leave and
 * look like a counting bug.
 */
const TODAY = '2026-08-17';

interface LeaveRow {
  id: string;
  employeeId: string;
  leaveType: string;
  startDate: Date;
  endDate: Date;
  totalDays: number;
  status: string;
  createdAt: Date;
  approvedAt: Date | null;
  employee: {
    fullName: string;
    branchId: string | null;
    department: { id: string; name: string } | null;
  };
}

function leave(
  over: Partial<LeaveRow> & { start: string; end: string; days: number },
): LeaveRow {
  return {
    id: over.id ?? `l-${over.start}`,
    employeeId: over.employeeId ?? 'e1',
    leaveType: over.leaveType ?? 'Annual Leave',
    startDate: d(over.start),
    endDate: d(over.end),
    totalDays: over.days,
    status: over.status ?? 'APPROVED',
    createdAt: over.createdAt ?? d('2026-08-01'),
    approvedAt: over.approvedAt ?? null,
    employee: over.employee ?? {
      fullName: over.employeeId ?? 'Asha',
      branchId: 'b1',
      department: { id: 'd1', name: 'Operations' },
    },
  };
}

function ot(employeeId: string, date: string, hours: number, status = 'APPROVED', dept = { id: 'd1', name: 'Operations' }) {
  return {
    employeeId,
    date: d(date),
    hours,
    status,
    employee: { fullName: employeeId, department: dept },
  };
}

describe('LeaveHubService', () => {
  let requests: LeaveRow[];
  let overtimeRows: any[];
  let balances: any[];
  let headcount: number;
  let workingDates: Date[];
  let overtimeEnabled: string;

  const prisma: any = {
    leaveRequest: { findMany: jest.fn(async () => requests) },
    overtimeRequest: { findMany: jest.fn(async () => overtimeRows) },
    leaveTypeBalance: { groupBy: jest.fn(async () => balances) },
    employee: { count: jest.fn(async () => headcount) },
  };
  const holidaysSvc: any = {
    // Returns the working days inside whatever window it is handed — the same
    // service `leave-requests.service.ts` uses to compute `totalDays`.
    getWorkingDatesBetween: jest.fn(async (from: Date, to: Date) =>
      workingDates.filter((x) => x >= from && x <= to),
    ),
  };
  const settings: any = {
    getSetting: jest.fn(async (_k: string, dflt: string) => overtimeEnabled ?? dflt),
  };

  const svc = new LeaveHubService(prisma, holidaysSvc, settings);
  const summary = (period: any = 'month', anchor = AUG) =>
    svc.getHubSummary(period, anchor).then((r: any) => r.data);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(d(TODAY));
    headcount = 20;
    overtimeEnabled = 'true';
    requests = [];
    overtimeRows = [];
    balances = [
      {
        leaveTypeKey: 'Annual Leave',
        _sum: { allocated: 240, used: 60, carriedOver: 20 },
        _count: { employeeId: 20 },
      },
      {
        leaveTypeKey: 'Sick Leave',
        _sum: { allocated: 600, used: 30, carriedOver: 0 },
        _count: { employeeId: 20 },
      },
    ];
    // Every weekday of Aug and Sep 2026 is a working day.
    workingDates = [];
    for (let m = 6; m <= 9; m++) {
      for (let day = 1; day <= 31; day++) {
        const x = new Date(Date.UTC(2026, m, day));
        if (x.getUTCMonth() !== m) continue;
        if (x.getUTCDay() === 0 || x.getUTCDay() === 6) continue;
        workingDates.push(x);
      }
    }
  });

  afterEach(() => jest.useRealTimers());

  it('refuses a period it does not understand instead of guessing', async () => {
    await expect(svc.getHubSummary('quarter' as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses an anchor that is not a real date', async () => {
    await expect(svc.getHubSummary('month', '2026-13-45')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  describe('status counts', () => {
    it('counts all four statuses, CANCELLED included', async () => {
      requests = [
        leave({ start: '2026-08-03', end: '2026-08-05', days: 3, status: 'APPROVED' }),
        leave({ start: '2026-08-06', end: '2026-08-06', days: 1, status: 'PENDING', id: 'p1' }),
        leave({ start: '2026-08-07', end: '2026-08-07', days: 1, status: 'REJECTED', id: 'r1' }),
        leave({ start: '2026-08-10', end: '2026-08-10', days: 1, status: 'CANCELLED', id: 'c1' }),
      ];
      const s = await summary();
      // The endpoint this replaces drops the cancelled one, so its four slices
      // never summed to the caption above them.
      expect(s.status).toEqual({ approved: 1, pending: 1, rejected: 1, cancelled: 1 });
      expect(s.periodStats.requests).toBe(4);
      expect(s.periodStats.approvalRate).toBe(25);
    });

    it('says unknown rather than 0% approval when nothing was submitted', async () => {
      const s = await summary();
      expect(s.periodStats.requests).toBe(0);
      expect(s.periodStats.approvalRate).toBeNull();
    });
  });

  describe('leave days', () => {
    it('keeps the number the request itself carries when it fits inside the window', async () => {
      requests = [leave({ start: '2026-08-03', end: '2026-08-07', days: 5 })];
      const s = await summary();
      // Not a recount: a branch whose calendar changed since the leave was
      // filed would otherwise disagree with the number on the request.
      expect(s.periodStats.leaveDays).toBe(5);
    });

    it('prorates a request that straddles the window boundary', async () => {
      // 28 Aug → 4 Sep. August's working part is 28, 31 (29/30 are a weekend).
      requests = [leave({ start: '2026-08-28', end: '2026-09-04', days: 6 })];
      const s = await summary();
      expect(s.periodStats.leaveDays).toBe(2);

      // ...and September gets the rest, so the two halves add back to six.
      const sep = await summary('month', '2026-09-15');
      expect(sep.periodStats.leaveDays).toBe(4);
    });

    it('counts only APPROVED leave as days taken', async () => {
      requests = [
        leave({ start: '2026-08-03', end: '2026-08-07', days: 5, status: 'PENDING' }),
      ];
      const s = await summary();
      // A pending request is a request, not an absence. It shows in the donut
      // and the trend; it has not been taken.
      expect(s.periodStats.leaveDays).toBe(0);
      expect(s.periodStats.pending).toBe(1);
    });

    it('counts nobody on leave on a day the branch was closed', async () => {
      jest.setSystemTime(d('2026-08-15')); // a Saturday
      requests = [
        leave({ start: '2026-08-13', end: '2026-08-18', days: 4, employeeId: 'e1' }),
      ];
      const s = await summary();
      // Being off on a Saturday is not leave, and counting it would inflate
      // "on leave today" every weekend.
      expect(s.periodStats.onLeaveToday).toBe(0);
    });

    it('counts who is on leave TODAY and what share of the workforce that is', async () => {
      requests = [
        leave({ start: '2026-08-13', end: '2026-08-18', days: 4, employeeId: 'e1' }),
        leave({ start: '2026-08-14', end: '2026-08-17', days: 2, employeeId: 'e2', id: 'l2' }),
        leave({ start: '2026-08-03', end: '2026-08-05', days: 3, employeeId: 'e3', id: 'l3' }),
      ];
      const s = await summary();
      expect(s.periodStats.onLeaveToday).toBe(2);
      expect(s.periodStats.onLeaveTodayRate).toBe(10); // 2 of 20
      expect(s.attention.onLeaveToday.names).toHaveLength(2);
    });
  });

  describe('balance', () => {
    it('computes remaining, because there is no such column', async () => {
      const s = await summary();
      // allocated 840 + carried 20 - used 90
      expect(s.balance.allocated).toBe(840);
      expect(s.balance.carriedOver).toBe(20);
      expect(s.balance.used).toBe(90);
      expect(s.balance.remaining).toBe(770);
    });

    it('divides utilisation by allocation PLUS carry-over', async () => {
      const s = await summary();
      // 90 / (840 + 20) = 10.5%. Ignoring carry-over would overstate it.
      expect(s.periodStats.utilisation).toBe(10.5);
    });

    it('says unknown rather than 0% when nothing is allocated', async () => {
      balances = [
        { leaveTypeKey: 'Annual Leave', _sum: { allocated: 0, used: 0, carriedOver: 0 }, _count: { employeeId: 0 } },
      ];
      const s = await summary();
      expect(s.periodStats.utilisation).toBeNull();
    });

    it('scopes the balance to the year the window ENDS in', async () => {
      // A balance is a year fact — a week does not have an entitlement.
      await summary('week', '2026-12-30'); // that week runs into 2027
      const call = prisma.leaveTypeBalance.groupBy.mock.calls[0][0];
      expect(call.where.year).toBe(2027);
    });

    it('reports an average balance per active employee', async () => {
      const s = await summary();
      expect(s.periodStats.averageBalance).toBe(38.5); // 770 / 20
    });
  });

  describe('the pending queue', () => {
    it('counts the requests that have been waiting more than two days', async () => {
      requests = [
        leave({ start: '2026-08-20', end: '2026-08-20', days: 1, status: 'PENDING', createdAt: d('2026-08-01'), id: 'old' }),
        leave({ start: '2026-08-21', end: '2026-08-21', days: 1, status: 'PENDING', createdAt: d('2026-08-16'), id: 'new' }),
      ];
      const s = await summary();
      expect(s.periodStats.pending).toBe(2);
      // Three requests waiting a fortnight is a worse state than ten waiting an
      // hour, and a count alone cannot say so.
      expect(s.periodStats.pendingOlderThan2Days).toBe(1);
      expect(s.attention.stale.count).toBe(1);
    });
  });

  describe('overtime', () => {
    it('totals APPROVED hours only', async () => {
      overtimeRows = [
        ot('e1', '2026-08-03', 4),
        ot('e2', '2026-08-04', 6),
        ot('e3', '2026-08-05', 40, 'PENDING'),
      ];
      const s = await summary();
      // A mistaken 40-hour submission must not move the number the whole
      // company is judged on before anybody has looked at it.
      expect(s.periodStats.overtimeHours).toBe(10);
      // ...but the queue is a queue whatever it is going to become.
      expect(s.periodStats.overtimeRequests).toBe(3);
    });

    it('averages over employees WITH overtime, not over headcount', async () => {
      overtimeRows = [ot('e1', '2026-08-03', 6), ot('e1', '2026-08-04', 4), ot('e2', '2026-08-05', 5)];
      const s = await summary();
      expect(s.periodStats.overtimeEmployees).toBe(2);
      // 15h / 2 people = 7.5, not 15/20 = 0.75.
      expect(s.periodStats.avgOvertimePerEmployee).toBe(7.5);
    });

    it('says unknown rather than zero when nobody worked overtime', async () => {
      const s = await summary();
      expect(s.periodStats.avgOvertimePerEmployee).toBeNull();
    });

    it('names the department and the person carrying the most', async () => {
      overtimeRows = [
        ot('e1', '2026-08-03', 12, 'APPROVED', { id: 'd1', name: 'Operations' }),
        ot('e2', '2026-08-04', 20, 'APPROVED', { id: 'd2', name: 'Sales' }),
        ot('e3', '2026-08-05', 5, 'APPROVED', { id: 'd2', name: 'Sales' }),
      ];
      const s = await summary();
      expect(s.overtime.topDepartment).toMatchObject({ name: 'Sales', hours: 25 });
      expect(s.overtime.topEmployee).toMatchObject({ name: 'e2', hours: 20 });
    });

    it('flags the people past a month of overtime as a welfare signal', async () => {
      overtimeRows = [ot('e1', '2026-08-03', 34), ot('e2', '2026-08-04', 4)];
      const s = await summary();
      expect(s.attention.highOvertime.count).toBe(1);
      expect(s.attention.highOvertime.names).toEqual(['e1']);
    });

    it('says overtime is switched off rather than reporting zeros', async () => {
      overtimeEnabled = 'false';
      overtimeRows = [ot('e1', '2026-08-03', 12)];
      const s = await summary();
      // Zeros would read as "nobody worked late"; `enabled: false` lets the page
      // drop the card instead of drawing a hole.
      expect(s.overtime.enabled).toBe(false);
      expect(s.periodStats.overtimeHours).toBe(0);
      expect(prisma.overtimeRequest.findMany).not.toHaveBeenCalled();
    });

    it('reads the overtime table when the switch is on', async () => {
      const s = await summary();
      expect(s.overtime.enabled).toBe(true);
      expect(prisma.overtimeRequest.findMany).toHaveBeenCalled();
    });
  });

  describe('the trend', () => {
    it('puts one bar on the axis per day of the month, zeros included', async () => {
      const s = await summary('month', AUG);
      expect(s.trendKind).toBe('day');
      expect(s.trend).toHaveLength(31);
      expect(s.trend[0]).toMatchObject({ key: '2026-08-01', total: 0 });
    });

    it('counts each request exactly once, on the bucket it starts in', async () => {
      requests = [leave({ start: '2026-08-03', end: '2026-08-07', days: 5 })];
      const s = await summary();
      const total = s.trend.reduce((a: number, b: any) => a + b.total, 0);
      // Spreading one request across five bars would make the chart disagree
      // with the KPI above it.
      expect(total).toBe(1);
      expect(s.trend.find((b: any) => b.key === '2026-08-03').approved).toBe(1);
    });

    it('clamps a request that began before the window onto the first bucket', async () => {
      requests = [leave({ start: '2026-07-28', end: '2026-08-04', days: 6 })];
      const s = await summary();
      expect(s.trend[0].approved).toBe(1);
    });

    it('rolls a year up into twelve months', async () => {
      const s = await summary('year', AUG);
      expect(s.trendKind).toBe('month');
      expect(s.trend).toHaveLength(12);
      expect(s.trend[7].key).toBe('2026-08');
    });
  });

  describe('leave types', () => {
    it('ranks the types by days consumed and gives each a share', async () => {
      requests = [
        leave({ start: '2026-08-03', end: '2026-08-07', days: 5, leaveType: 'Annual Leave' }),
        leave({ start: '2026-08-10', end: '2026-08-11', days: 2, leaveType: 'Sick Leave', id: 's1' }),
      ];
      const s = await summary();
      expect(s.leaveTypes[0]).toMatchObject({ key: 'Annual Leave', days: 5 });
      expect(s.leaveTypes[0].share).toBeCloseTo(71.4, 1);
      expect(s.periodStats.topLeaveType).toBe('Annual Leave');
    });

    it('keeps a type whose library row was deleted rather than dropping its days', async () => {
      requests = [
        leave({ start: '2026-08-03', end: '2026-08-04', days: 2, leaveType: 'Retired Leave Type' }),
      ];
      const s = await summary();
      // Dropping it would make the totals disagree with the sum of the rows.
      expect(s.leaveTypes[0].name).toBe('Retired Leave Type');
      expect(s.periodStats.leaveDays).toBe(2);
    });
  });

  describe('the window before it', () => {
    it('compares every window with the same window one step back', async () => {
      const s = await summary('month', AUG);
      expect(s.previousRange).toMatchObject({
        start: '2026-07-01',
        end: '2026-07-31',
        label: 'Jul 2026',
      });
      expect(s.previousStats).toBeDefined();
    });

    it('offers the anchors to page with and labels the window server-side', async () => {
      const s = await summary('month', AUG);
      expect(s.range).toMatchObject({
        start: '2026-08-01',
        end: '2026-08-31',
        label: 'Aug 2026',
        prevAnchor: '2026-07-01',
        nextAnchor: '2026-09-01',
        isCurrent: true,
      });
    });

    it('lets the reader page one window ahead, because leave is filed ahead', async () => {
      const s = await summary('month', AUG);
      expect(s.range.hasNext).toBe(true);
    });
  });
});
