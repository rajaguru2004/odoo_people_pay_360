import { Banknote, CalendarCheck, ClipboardCheck, Gauge, Users } from 'lucide-react';
import type { KpiStat } from '@/components/module-landing/StatCard';
import { formatCurrency, formatNumber, formatPercent } from '@/utils/formatters';
import type { PayrollDashboardSummary } from '@/types/payrollDashboard';

/**
 * The five KPI cards, built from one response.
 *
 * Pure and separate from any component so the rules below can be tested without
 * a DOM. The rule that matters most, and the one a card gets wrong most easily:
 *
 * **`null` is not zero.** `averageNet` is `null` when nobody was paid and
 * `attendanceRate` is `null` when there were no attendance events at all.
 * `StatCard` prints `null` as an em dash. Coercing either to `0` would tell the
 * reader that the average salary was nothing, or that nobody turned up — both
 * false, and both indistinguishable from a real zero once printed.
 *
 * Cards are built with their values in place whether or not the data has
 * arrived; the page passes `loading` to `KpiRow` and lets it draw skeletons, so
 * the grid never changes shape between the loading pass and the loaded one.
 */
export function buildDashboardKpis(
  summary: PayrollDashboardSummary | undefined,
): KpiStat[] {
  const currency = summary?.money.currency ?? 'OMR';
  const net = summary?.money.net ?? null;
  const previousNet = summary?.money.previousNet ?? 0;
  const changePct = summary?.money.changePct ?? null;

  return [
    {
      key: 'net',
      label: 'Total net salary paid',
      value: net === null ? null : formatCurrency(net, currency),
      icon: Banknote,
      tone: 'default',
      // The absolute change, not the percentage: for money the reader was
      // going to work out the difference anyway, and a percentage of a small
      // base reads as drama that is not there.
      delta:
        changePct === null || net === null
          ? undefined
          : {
              value: Math.abs(changePct),
              direction: net >= previousNet ? 'up' : 'down',
              // Neither direction is good news on its own — payroll rising can
              // be hiring or can be overtime — so the arrow is left neutral by
              // pointing `goodDirection` at whichever way it went.
              goodDirection: net >= previousNet ? 'up' : 'down',
              display: formatCurrency(Math.abs(net - previousNet), currency),
              label: 'vs previous period',
            },
      // Two points minimum, or `generateSparkPath` draws nothing: one reading
      // is not a trend, and a flat line through it would claim "steady".
      trend: summary?.trend.map((bucket) => bucket.net),
      subStats: [
        {
          key: 'gross',
          label: 'Gross',
          value: summary ? formatCurrency(summary.money.gross, currency) : null,
        },
        {
          key: 'deductions',
          label: 'Deductions',
          value: summary
            ? formatCurrency(summary.money.deductions, currency)
            : null,
        },
      ],
      href: '/dashboard/payroll/payslips',
      footnote: 'Approved and paid runs only.',
    },
    {
      key: 'payslips',
      label: 'Payslips generated',
      value: summary ? formatNumber(summary.payslips.total) : null,
      icon: ClipboardCheck,
      tone: 'info',
      subStats: [
        {
          key: 'active',
          label: 'Active employees',
          value: summary ? formatNumber(summary.coverage.activeEmployees) : null,
        },
      ],
      href: '/dashboard/payroll/payslips',
    },
    {
      key: 'average',
      label: 'Average salary',
      value:
        summary?.money.averageNet === null || summary === undefined
          ? null
          : formatCurrency(summary.money.averageNet, currency),
      icon: Users,
      tone: 'default',
      footnote: 'Net, across the payslips in this period.',
    },
    {
      key: 'timeOff',
      label: 'Approved time off',
      value: summary ? formatNumber(summary.timeOff.approvedDays) : null,
      icon: CalendarCheck,
      tone: 'info',
      subStats: [
        {
          key: 'requests',
          label: 'Requests',
          value: summary ? formatNumber(summary.timeOff.approvedRequests) : null,
        },
      ],
      href: '/dashboard/leave',
      // Working days, already netted of the branch calendar and its holidays by
      // `LeaveRequest.totalDays` — which is stored, not recomputed, so it keeps
      // the number the approver agreed to.
      footnote: 'Working days on approved requests starting this period.',
    },
    {
      key: 'attendanceHealth',
      label: 'Attendance health',
      value:
        summary?.coverage.attendanceRate === null || summary === undefined
          ? null
          : formatPercent(summary.coverage.attendanceRate),
      icon: Gauge,
      tone: 'success',
      subStats: [
        {
          key: 'completion',
          label: 'Payroll completion',
          value:
            summary?.coverage.payrollCompletion === null ||
            summary === undefined
              ? null
              : formatPercent(summary.coverage.payrollCompletion),
        },
      ],
      href: '/dashboard/attendance',
      footnote: 'Days worked over days that were attendance events.',
    },
  ];
}
