import { describe, expect, it } from 'vitest';
import { buildDashboardKpis } from './dashboardKpis';
import type {
  DashboardOverview,
  DashboardSection,
} from '@/types/dashboardOverview';

/**
 * The dashboard KPI row is the only place in the app where "this figure does
 * not exist for you" and "this figure exists and is zero" have to stay apart on
 * screen, so those two claims are what these tests are about.
 */

const workforce = () => ({
  headcount: 124,
  joinersThisMonth: 6,
  leaversThisMonth: 2,
  onProbation: 9,
  byDepartment: [],
  trend: [
    { key: '2026-06', label: 'Jun 2026', joiners: 4, leavers: 1, headcountEnd: 118 },
    { key: '2026-07', label: 'Jul 2026', joiners: 3, leavers: 2, headcountEnd: null },
    { key: '2026-08', label: 'Aug 2026', joiners: 6, leavers: 2, headcountEnd: 124 },
  ],
  growthPct: 5.1,
});

const overview = (
  sections: DashboardSection[],
  overrides: Partial<DashboardOverview> = {},
): DashboardOverview => ({
  sections,
  viewer: { role: 'ADMIN', employeeId: 'emp-1' },
  today: '2026-09-05',
  periodLabel: 'August 2026',
  currency: 'OMR',
  workforce: workforce(),
  attendance: {
    present: 96,
    late: 4,
    absent: 3,
    onLeave: 7,
    notCheckedIn: 0,
    expected: 110,
    attendanceRate: 90.9,
    settled: true,
  },
  payroll: {
    lastRun: {
      id: 'run-1',
      label: 'August 2026',
      status: 'PAID',
      net: 84_000,
      periodStart: '2026-08-01',
    },
    netThisPeriod: 84_000,
    previousNet: 80_000,
    changePct: 5,
    employeesPaid: 120,
    trend: [],
    byDepartment: [],
  },
  approvals: {
    total: 11,
    items: [
      {
        key: 'leave',
        label: 'Leave requests',
        count: 8,
        href: '/dashboard/leaves/pending',
        severity: 'WARNING',
        oldestDays: 5,
      },
    ],
  },
  compliance: {
    documents: {
      count: 3,
      items: [
        {
          id: 'doc-1',
          employeeName: 'Aisha Al Balushi',
          kind: 'Work permit',
          expiryDate: '2026-09-20',
          daysLeft: 15,
          href: '/dashboard/employees/emp-2',
        },
      ],
    },
    contracts: { count: 2, items: [] },
    probation: { count: 1, items: [] },
    horizonDays: 30,
  },
  me: {
    employeeId: 'emp-1',
    todayStatus: 'PRESENT',
    leaveBalanceDays: 12,
    pendingOwnRequests: 0,
    latestPayslip: null,
  },
  ...overrides,
});

const keys = (sections: DashboardSection[], overrides?: Partial<DashboardOverview>) =>
  buildDashboardKpis(overview(sections, overrides)).map((s) => s.key);

describe('buildDashboardKpis', () => {
  it('builds one card per section the caller received', () => {
    expect(
      keys(['workforce', 'attendance', 'payroll', 'approvals', 'compliance']),
    ).toEqual(['headcount', 'attendanceToday', 'netPaid', 'approvals', 'expiring']);
  });

  it('omits the card entirely for a section that did not arrive', () => {
    // The rule the whole page rests on. The payload still CARRIES a payroll
    // block here — what decides is `sections`, because an entitled figure and a
    // fetched one are not the same claim. A card rendered with a zero would
    // tell an employee the company paid nothing; one rendered with an em dash
    // would tell them the figure exists and the page failed to get it.
    const built = buildDashboardKpis(overview(['workforce', 'attendance']));

    expect(built.map((s) => s.key)).toEqual(['headcount', 'attendanceToday']);
    expect(built.find((s) => s.key === 'netPaid')).toBeUndefined();
    expect(built.some((s) => s.value === null)).toBe(false);
  });

  it('produces no cards at all when the caller received no section', () => {
    expect(buildDashboardKpis(overview([]))).toEqual([]);
  });

  it('offers every card with a null value while nothing has loaded', () => {
    // `undefined` is the skeleton pass, not a refusal: nothing has been denied
    // yet, so the grid is drawn at full width and narrows once when the
    // response lands.
    const built = buildDashboardKpis(undefined);

    expect(built).toHaveLength(5);
    expect(built.every((s) => s.value === null)).toBe(true);
    expect(built.every((s) => s.delta === undefined)).toBe(true);
  });

  it('keeps a null netThisPeriod null rather than printing a zero', () => {
    // No run locked for the period is not a payroll of zero.
    const [card] = buildDashboardKpis(
      overview(['payroll'], {
        payroll: {
          ...overview(['payroll']).payroll!,
          netThisPeriod: null,
          changePct: null,
        },
      }),
    );

    expect(card.value).toBeNull();
    expect(card.footnote).toBe('No run is locked for this period yet.');
  });

  it('shows the money delta as the absolute change, not the percentage', () => {
    const [card] = buildDashboardKpis(overview(['payroll']));

    expect(card.delta?.direction).toBe('up');
    // 84,000 − 80,000 in OMR, which is a thousandths currency.
    expect(card.delta?.display).toContain('4,000.000');
  });

  it('drops the delta when there is no previous period to compare against', () => {
    const [card] = buildDashboardKpis(
      overview(['payroll'], {
        payroll: {
          ...overview(['payroll']).payroll!,
          previousNet: null,
          changePct: null,
        },
      }),
    );

    // A first-ever run has nothing to move against; an arrow would invent one.
    expect(card.delta).toBeUndefined();
    expect(card.value).not.toBeNull();
  });

  it('drops null headcounts from the sparkline instead of drawing them as zero', () => {
    const [card] = buildDashboardKpis(overview(['workforce']));

    // A month the backwards walk cannot reconstruct is a GAP. Zeroed, it draws
    // a cliff that says the company emptied out that month.
    expect(card.trend).toEqual([118, 124]);
  });

  it('leaves the sparkline too short to draw when only one month is known', () => {
    const [card] = buildDashboardKpis(
      overview(['workforce'], {
        workforce: {
          ...workforce(),
          trend: [
            { key: '2026-07', label: 'Jul 2026', joiners: 3, leavers: 2, headcountEnd: null },
            { key: '2026-08', label: 'Aug 2026', joiners: 6, leavers: 2, headcountEnd: 124 },
          ],
        },
      }),
    );

    // One reading is not a trend; `generateSparkPath` draws nothing below two.
    expect(card.trend).toEqual([124]);
  });

  it('renders an em dash for a null attendance rate, never 0.0%', () => {
    const [card] = buildDashboardKpis(
      overview(['attendance'], {
        attendance: {
          ...overview(['attendance']).attendance!,
          attendanceRate: null,
          expected: 0,
        },
      }),
    );

    // Nobody expected is not nobody present — a closed branch is not a failed
    // one, and the card must not report it as such.
    expect(card.value).toBe('—');
  });

  it('says whether the working day has settled', () => {
    const [open] = buildDashboardKpis(
      overview(['attendance'], {
        attendance: { ...overview(['attendance']).attendance!, settled: false },
      }),
    );
    const [closed] = buildDashboardKpis(overview(['attendance']));

    expect(open.footnote).toMatch(/still open/i);
    expect(closed.footnote).toMatch(/closed/i);
  });

  it('warns only while approvals are actually waiting', () => {
    const [waiting] = buildDashboardKpis(overview(['approvals']));
    const [clear] = buildDashboardKpis(
      overview(['approvals'], { approvals: { total: 0, items: [] } }),
    );

    expect(waiting.tone).toBe('warning');
    expect(waiting.href).toBe('/dashboard/leaves/pending');
    expect(clear.tone).toBe('default');
    expect(clear.value).toBe('0');
  });

  it('sums the three compliance groups and escalates once something has lapsed', () => {
    const [soon] = buildDashboardKpis(overview(['compliance']));
    expect(soon.value).toBe('6');
    expect(soon.tone).toBe('warning');

    const [lapsed] = buildDashboardKpis(
      overview(['compliance'], {
        compliance: {
          ...overview(['compliance']).compliance!,
          contracts: {
            count: 2,
            items: [
              {
                id: 'con-1',
                employeeName: 'Salim Al Hinai',
                kind: 'Fixed term',
                expiryDate: '2026-08-30',
                daysLeft: -6,
                href: '/dashboard/contracts/con-1',
              },
            ],
          },
        },
      }),
    );

    // A missed deadline is a different colour of problem from an approaching
    // one, and the counts alone cannot tell them apart.
    expect(lapsed.tone).toBe('danger');
  });
});
