import { AttendanceStatus, SalaryComponentType } from '@prisma/client';
import {
  addSegment,
  attendanceHealth,
  ATTENDANCE_EVENT_STATUSES,
  buildBridge,
  buildComponentMix,
  buildCumulativeTrend,
  buildFunnel,
  emptySegments,
  payrollCompletion,
  segmentTotal,
  type TrendInput,
} from './payroll-dashboard.util';

const bucket = (key: string, net: number, gross = net): TrendInput => ({
  key,
  label: key,
  gross,
  net,
  deductions: gross - net,
  employeeCount: 1,
});

describe('buildCumulativeTrend', () => {
  it('walks a running total in window order', () => {
    const out = buildCumulativeTrend([
      bucket('2026-06-01', 100),
      bucket('2026-07-01', 250),
      bucket('2026-08-01', 50),
    ]);
    expect(out.map((b) => b.cumulativeNet)).toEqual([100, 350, 400]);
  });

  it('carries empty months without restarting the total', () => {
    // The failure this guards: a month nobody was paid in resetting the line
    // back to its own bar, which reads as the company having spent nothing to
    // date rather than nothing that month.
    const out = buildCumulativeTrend([
      bucket('2026-06-01', 100),
      bucket('2026-07-01', 0),
      bucket('2026-08-01', 40),
    ]);
    expect(out.map((b) => b.cumulativeNet)).toEqual([100, 100, 140]);
  });

  it('rounds to the money precision at every step', () => {
    const out = buildCumulativeTrend([
      bucket('2026-06-01', 0.0005),
      bucket('2026-07-01', 0.0005),
    ]);
    // Thousandths, because that is what Decimal(18,3) stores. A running total
    // carrying float noise diverges from the column it claims to sum.
    out.forEach((b) => {
      expect(Number.isInteger(b.cumulativeNet * 1000)).toBe(true);
    });
  });

  it('returns an empty window rather than throwing on one', () => {
    expect(buildCumulativeTrend([])).toEqual([]);
  });
});

describe('buildBridge', () => {
  it('closes gross minus deductions onto net in the ordinary case', () => {
    const bridge = buildBridge({ gross: 1000, deductions: 150, net: 850 });
    expect(bridge.netFloorResidual).toBe(0);
    expect(bridge.steps.map((s) => s.key)).toEqual([
      'GROSS',
      'DEDUCTIONS',
      'NET',
    ]);
  });

  it('renders the net floor as its own step when a payslip was floored', () => {
    // One employee: gross 100, deductions 130. Their net floors at 0 rather
    // than -30, so the run's net is 30 more than gross minus deductions. The
    // bridge has to show that or its bars do not reach its own final column.
    const bridge = buildBridge({ gross: 100, deductions: 130, net: 0 });
    expect(bridge.netFloorResidual).toBe(30);

    const floor = bridge.steps.find((s) => s.key === 'NET_FLOOR');
    expect(floor).toBeDefined();
    expect(floor?.kind).toBe('add');
    expect(floor?.amount).toBe(30);
  });

  it('has bars that reconcile to the stated net', () => {
    const bridge = buildBridge({ gross: 5000, deductions: 5200, net: 100 });
    const walked = bridge.steps.reduce((running, step) => {
      if (step.key === 'GROSS') return step.amount;
      if (step.kind === 'add') return running + step.amount;
      if (step.kind === 'subtract') return running - step.amount;
      return running;
    }, 0);
    expect(walked).toBe(bridge.net);
  });

  it('omits the floor step entirely when it is zero', () => {
    // A permanent "floor adjustment: 0" column teaches the reader to ignore
    // the one mark that means somebody's deductions exceeded their pay.
    const bridge = buildBridge({ gross: 900, deductions: 100, net: 800 });
    expect(bridge.steps.some((s) => s.key === 'NET_FLOOR')).toBe(false);
  });
});

describe('buildComponentMix', () => {
  const line = (code: string, type: SalaryComponentType, amount: number) => ({
    code,
    type,
    amount,
  });

  it('splits basic from the other earnings', () => {
    const mix = buildComponentMix([
      line('BASIC', SalaryComponentType.EARNING, 600),
      line('HRA', SalaryComponentType.EARNING, 200),
      line('TRANSPORT', SalaryComponentType.EARNING, 100),
      line('PENSION', SalaryComponentType.DEDUCTION, 70),
    ]);
    expect(mix).toEqual([
      { key: 'BASIC', label: 'Basic', amount: 600 },
      { key: 'ALLOWANCES', label: 'Allowances', amount: 300 },
      { key: 'DEDUCTIONS', label: 'Deductions', amount: 70 },
    ]);
  });

  it('matches the basic code whatever case it arrives in', () => {
    const mix = buildComponentMix([
      line('basic', SalaryComponentType.EARNING, 500),
    ]);
    expect(mix[0].amount).toBe(500);
    expect(mix[1].amount).toBe(0);
  });

  it('leaves employer contributions out of the stack', () => {
    // They are recorded and never paid. Stacking them beside earnings makes
    // the column taller than the gross it claims to decompose.
    const mix = buildComponentMix([
      line('BASIC', SalaryComponentType.EARNING, 500),
      line('SOCIAL', SalaryComponentType.EMPLOYER_CONTRIBUTION, 55),
    ]);
    expect(mix.reduce((a, b) => a + b.amount, 0)).toBe(500);
  });

  it('counts LOP as an ordinary deduction here', () => {
    const mix = buildComponentMix([
      line('BASIC', SalaryComponentType.EARNING, 600),
      line('LOP', SalaryComponentType.DEDUCTION, 60),
    ]);
    expect(mix[2].amount).toBe(60);
  });

  it('returns three named buckets for no lines at all', () => {
    // A chart that received an empty array would have no bars to label; three
    // zeroed buckets let the caller render its own no-data state instead.
    expect(buildComponentMix([]).map((b) => b.key)).toEqual([
      'BASIC',
      'ALLOWANCES',
      'DEDUCTIONS',
    ]);
  });
});

describe('attendance segments', () => {
  it('excludes HOLIDAY and WEEKEND from the event statuses', () => {
    // They are calendar facts, not things anybody did. Counting them shrinks
    // every real rate by however many days the branch was shut.
    expect(ATTENDANCE_EVENT_STATUSES).not.toContain(AttendanceStatus.HOLIDAY);
    expect(ATTENDANCE_EVENT_STATUSES).not.toContain(AttendanceStatus.WEEKEND);
    expect(ATTENDANCE_EVENT_STATUSES).toHaveLength(5);
  });

  it('ignores a status outside the event set rather than bucketing it', () => {
    const segments = emptySegments();
    addSegment(segments, AttendanceStatus.WEEKEND, 8);
    addSegment(segments, AttendanceStatus.HOLIDAY, 2);
    expect(segmentTotal(segments)).toBe(0);
  });

  it('adds a counted group in one call', () => {
    const segments = emptySegments();
    addSegment(segments, AttendanceStatus.PRESENT, 18);
    addSegment(segments, AttendanceStatus.LATE, 3);
    expect(segments.present).toBe(18);
    expect(segments.late).toBe(3);
  });
});

describe('attendanceHealth', () => {
  it('counts a half day as worked and leave as accounted for', () => {
    const segments = {
      present: 15,
      late: 3,
      absent: 2,
      halfDay: 0,
      onLeave: 0,
    };
    expect(attendanceHealth(segments)).toBe(90);
  });

  it('keeps approved leave in the denominator', () => {
    // Dropping it would let a team improve its own rate by taking holiday.
    const withLeave = attendanceHealth({
      present: 9,
      late: 0,
      absent: 0,
      halfDay: 0,
      onLeave: 1,
    });
    expect(withLeave).toBe(90);
  });

  it('is null, never zero, when there were no event days', () => {
    // A month nobody was rostered is not a month everybody failed to turn up.
    expect(attendanceHealth(emptySegments())).toBeNull();
  });
});

describe('payrollCompletion', () => {
  it('is the share of the active workforce that was paid', () => {
    expect(payrollCompletion(45, 50)).toBe(90);
  });

  it('is null with nobody active to pay', () => {
    expect(payrollCompletion(0, 0)).toBeNull();
  });
});

describe('buildFunnel', () => {
  const run = (
    status: string,
    calculatedAt: Date | null = null,
    approvedAt: Date | null = null,
    paidAt: Date | null = null,
  ) => ({ status, calculatedAt, approvedAt, paidAt });

  const now = new Date('2026-08-10T00:00:00Z');

  it('is monotonically decreasing', () => {
    // The whole reason reach is used instead of current status: counting the
    // status a run is in RIGHT NOW gives a shape that goes up and down, which
    // is not a funnel.
    const stages = buildFunnel([
      run('PAID', now, now, now),
      run('APPROVED', now, now),
      run('CALCULATED', now),
      run('DRAFT'),
    ]);
    expect(stages.map((s) => s.reached)).toEqual([4, 3, 2, 1]);
    for (let i = 1; i < stages.length; i += 1) {
      expect(stages[i].reached).toBeLessThanOrEqual(stages[i - 1].reached);
    }
  });

  it('still counts a rejected run as having been computed', () => {
    // Reject sends a CALCULATED run back to DRAFT, but it genuinely WAS
    // calculated and `calculatedAt` still says so. Reading reach off the
    // current status would un-count it and make the first gate look wider.
    const stages = buildFunnel([run('DRAFT', now)]);
    expect(stages[0].reached).toBe(1);
    expect(stages[1].reached).toBe(1);
    expect(stages[2].reached).toBe(0);
  });

  it('leaves cancelled runs out of every stage', () => {
    // A withdrawal is not a stage and not a failure. Counting it in the first
    // bar would make that bar disagree with the run list.
    const stages = buildFunnel([
      run('CANCELLED', now, now),
      run('PAID', now, now, now),
    ]);
    expect(stages[0].reached).toBe(1);
    expect(stages[3].reached).toBe(1);
  });

  it('names all four stages even with no runs at all', () => {
    const stages = buildFunnel([]);
    expect(stages.map((s) => s.stage)).toEqual([
      'DRAFT',
      'CALCULATED',
      'APPROVED',
      'PAID',
    ]);
    expect(stages.every((s) => s.reached === 0)).toBe(true);
  });
});
