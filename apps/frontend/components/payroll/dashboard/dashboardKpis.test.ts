import { describe, expect, it } from 'vitest';
import { buildDashboardKpis } from './dashboardKpis';
import type { PayrollDashboardSummary } from '@/types/payrollDashboard';

const summary = (
  overrides: Partial<PayrollDashboardSummary> = {},
): PayrollDashboardSummary => ({
  filters: {
    applied: {
      months: 12,
      period: '2026-08',
      departmentId: null,
      employmentType: null,
    },
    departments: [],
    employmentTypes: [],
  },
  period: { label: 'August 2026', periodStart: '2026-08-01', periodEnd: '2026-08-31' },
  previousPeriod: {
    label: 'July 2026',
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
  },
  money: {
    currency: 'OMR',
    otherCurrencies: [],
    gross: 12_000,
    net: 10_000,
    deductions: 2_000,
    employerCost: 900,
    previousNet: 8_000,
    changePct: 25,
    averageNet: 500,
  },
  payslips: { total: 20, employeesPaid: 20 },
  timeOff: { approvedDays: 14, approvedRequests: 5 },
  overtime: { approvedHours: 32 },
  coverage: {
    present: 380,
    late: 12,
    absent: 8,
    halfDay: 0,
    onLeave: 14,
    expected: 414,
    attendanceRate: 94.7,
    payrollCompletion: 90.9,
    activeEmployees: 22,
  },
  runs: {
    byStatus: { DRAFT: 1, CALCULATED: 0, APPROVED: 1, PAID: 4, CANCELLED: 0 },
    inWindow: 6,
    funnel: [],
  },
  trend: [
    {
      key: '2026-07-01',
      label: 'Jul 2026',
      gross: 9_600,
      net: 8_000,
      deductions: 1_600,
      employeeCount: 20,
      cumulativeNet: 8_000,
    },
    {
      key: '2026-08-01',
      label: 'Aug 2026',
      gross: 12_000,
      net: 10_000,
      deductions: 2_000,
      employeeCount: 20,
      cumulativeNet: 18_000,
    },
  ],
  departments: [],
  components: [],
  bridge: {
    steps: [],
    gross: 12_000,
    deductions: 2_000,
    net: 10_000,
    netFloorResidual: 0,
  },
  attendance: [],
  attention: [],
  ...overrides,
});

const find = (stats: ReturnType<typeof buildDashboardKpis>, key: string) =>
  stats.find((stat) => stat.key === key);

describe('buildDashboardKpis', () => {
  it('always builds five cards, loaded or not', () => {
    // The grid picks its column count from the array length, so a shorter
    // loading array would change the layout between the skeleton pass and the
    // loaded one.
    expect(buildDashboardKpis(undefined)).toHaveLength(5);
    expect(buildDashboardKpis(summary())).toHaveLength(5);
  });

  it('leaves every value null when there is no data', () => {
    // `null` prints an em dash. A zero here would claim the company paid
    // nothing, which is a different statement from not knowing yet.
    for (const stat of buildDashboardKpis(undefined)) {
      expect(stat.value).toBeNull();
    }
  });

  it('formats money with the response currency', () => {
    const stats = buildDashboardKpis(summary());
    expect(String(find(stats, 'net')?.value)).toContain('OMR');
    // OMR is a thousandths currency — three decimals, not two.
    expect(String(find(stats, 'net')?.value)).toContain('10,000.000');
  });

  it('shows the absolute change, not the percentage, on the money card', () => {
    const stats = buildDashboardKpis(summary());
    expect(find(stats, 'net')?.delta?.display).toContain('2,000.000');
    expect(find(stats, 'net')?.delta?.direction).toBe('up');
  });

  it('drops the delta entirely when there is nothing to compare against', () => {
    // `changePct` is null when the previous period paid nothing. "Unchanged"
    // is a claim about a comparison that cannot be made.
    const stats = buildDashboardKpis(
      summary({
        money: { ...summary().money, changePct: null, previousNet: 0 },
      }),
    );
    expect(find(stats, 'net')?.delta).toBeUndefined();
  });

  it('renders a null average as null, never as zero', () => {
    // An average of nothing is not zero.
    const stats = buildDashboardKpis(
      summary({ money: { ...summary().money, averageNet: null } }),
    );
    expect(find(stats, 'average')?.value).toBeNull();
  });

  it('renders a null attendance rate as null, never as 0.0%', () => {
    // A month nobody was rostered is not a month everybody failed to turn up.
    const stats = buildDashboardKpis(
      summary({
        coverage: {
          ...summary().coverage,
          attendanceRate: null,
          payrollCompletion: null,
        },
      }),
    );
    expect(find(stats, 'attendanceHealth')?.value).toBeNull();
    expect(
      find(stats, 'attendanceHealth')?.subStats?.[0].value,
    ).toBeNull();
  });

  it('counts time off in days and carries the request count beside it', () => {
    const stats = buildDashboardKpis(summary());
    expect(find(stats, 'timeOff')?.value).toBe('14');
    expect(find(stats, 'timeOff')?.subStats?.[0].value).toBe('5');
  });

  it('feeds the sparkline the trend series', () => {
    const stats = buildDashboardKpis(summary());
    // Two points minimum, or generateSparkPath draws nothing at all.
    expect(find(stats, 'net')?.trend).toEqual([8_000, 10_000]);
  });

  it('gives every card somewhere to drill to, or a reason not to', () => {
    const stats = buildDashboardKpis(summary());
    // The average card is the one figure with no list behind it — it is
    // derived, not a set of rows — so it carries a footnote instead.
    expect(find(stats, 'average')?.href).toBeUndefined();
    expect(find(stats, 'average')?.footnote).toBeTruthy();
    for (const key of ['net', 'payslips', 'timeOff', 'attendanceHealth']) {
      expect(find(stats, key)?.href).toBeTruthy();
    }
  });
});
