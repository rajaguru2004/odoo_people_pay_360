'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import systemSettingsService from '@/services/systemSettingsService';
import { motion } from 'framer-motion';
import { ShieldCheck, AlertTriangle, Info, Clock, HelpCircle, ChevronRight } from 'lucide-react';
import { formatAmountWithSymbol } from '@/utils/formatters';
import type { PayrollHubSummary } from '@/types/payrollHub';

/** Returns true when system settings indicate an Oman payroll context. */
function useIsOman(): { isOman: boolean; loading: boolean } {
  const q = useQuery({
    queryKey: ['systemSettings', 'public', 'oman-detect'],
    queryFn: () => systemSettingsService.getPublic(),
    staleTime: 120_000,
  });

  const data = q.data?.data ?? {};
  const country = (data['payroll_country'] ?? '').toUpperCase();
  const currency = (data['payroll_currency'] ?? '').toUpperCase();
  const template = (data['payroll_template'] ?? '').toUpperCase();

  const isOman =
    country === 'OM' ||
    currency === 'OMR' ||
    template.includes('OMAN');

  return { isOman, loading: q.isLoading };
}

/**
 * `unknown` is the status this panel was missing.
 *
 * Every row used to be a hardcoded literal — "0 exceptions", "Validated",
 * "100% on time" — so the panel reported a clean bill of health over a database
 * it had never read. Half of these areas genuinely cannot be judged from the
 * hub aggregate (the 25%-of-net deduction cap needs every payslip line), and
 * the honest answer for those is "not measured here, and here is the screen
 * that does measure it" — not a green tick.
 */
type ComplianceStatus = 'compliant' | 'review' | 'monitoring' | 'unknown';

interface ComplianceRow {
  key: string;
  area: string;
  status: ComplianceStatus;
  /** The figure itself, or an em dash when nothing could be read. */
  metric: string;
  description: string;
  /** The screen that answers this area properly. Every row has one. */
  href: string;
  /** What to do about it, when the status is not clean. */
  action?: string;
}

const STATUS_CONFIG: Record<
  ComplianceStatus,
  { dot: string; label: string; rowBg: string; badge: string }
> = {
  compliant: {
    dot: '#22c55e',
    label: 'Compliant',
    rowBg: 'hover:bg-emerald-50/40 dark:hover:bg-emerald-900/10',
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  },
  review: {
    dot: '#f59e0b',
    label: 'Review',
    rowBg: 'hover:bg-amber-50/40 dark:hover:bg-amber-900/10',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  },
  monitoring: {
    dot: '#3b82f6',
    label: 'Monitoring',
    rowBg: 'hover:bg-blue-50/40 dark:hover:bg-blue-900/10',
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  },
  unknown: {
    dot: '#94a3b8',
    label: 'Not measured',
    rowBg: 'hover:bg-slate-50/60 dark:hover:bg-slate-800/20',
    badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300',
  },
};

function StatusDot({ status }: { status: ComplianceStatus }) {
  const c = STATUS_CONFIG[status];
  return (
    <span className="relative flex items-center gap-1.5">
      <span
        className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
        style={{ backgroundColor: c.dot, boxShadow: `0 0 0 3px ${c.dot}22` }}
      />
      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${c.badge}`}>
        {c.label}
      </span>
    </span>
  );
}

function StatusIcon({ status }: { status: ComplianceStatus }) {
  if (status === 'compliant') return <ShieldCheck size={15} className="text-emerald-500 shrink-0 mt-0.5" />;
  if (status === 'review') return <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />;
  if (status === 'monitoring') return <Clock size={15} className="text-blue-500 shrink-0 mt-0.5" />;
  return <HelpCircle size={15} className="text-slate-400 shrink-0 mt-0.5" />;
}

/**
 * The eight areas, scored against the hub aggregate the page already has.
 *
 * `summary` is undefined while the aggregate is loading and when it failed;
 * `failed` separates those two, because a failed read must not be reported as
 * "not measured yet" any more than as "compliant".
 */
function buildRows(
  summary: PayrollHubSummary | undefined,
  failed: boolean,
): ComplianceRow[] {
  const money = (n: number | null | undefined): string =>
    n === null || n === undefined ? '—' : formatAmountWithSymbol(n);

  const comp = new Map<string, number>(
    summary
      ? [...summary.composition.earnings, ...summary.composition.deductions].map((r) => [
          r.key as string,
          r.amount,
        ])
      : [],
  );

  const period = summary?.anchor.label ?? 'this period';
  const unread = failed || !summary;

  const runs = summary?.runs;
  const readiness = summary?.readiness;
  const settlements = summary?.settlements;

  const rows: ComplianceRow[] = [];

  // ── SPF ──────────────────────────────────────────────────────────────────
  const spf = summary?.money.statutory ?? null;
  rows.push({
    key: 'spf',
    area: 'SPF (Social Protection Fund)',
    status: unread ? 'unknown' : spf === null ? 'monitoring' : spf > 0 ? 'compliant' : 'review',
    metric: money(spf),
    description:
      'Employer and employee contributions at the statutory rate for Omani nationals, from locked runs.',
    action:
      !unread && spf === 0
        ? `No SPF was deducted anywhere in ${period}. Check the contribution rules.`
        : undefined,
    href: '/dashboard/payroll/reports',
  });

  // ── Timeliness ───────────────────────────────────────────────────────────
  const late = (runs?.pendingApproval ?? 0) + (runs?.draftForClosedPeriod ?? 0);
  rows.push({
    key: 'timeliness',
    area: 'Salary Timeliness',
    status: unread ? 'unknown' : late > 0 ? 'review' : 'compliant',
    metric: unread ? '—' : late > 0 ? `${late} run(s) not finalised` : 'All runs finalised',
    description:
      'Salary must be paid by the legal deadline — the last working day of the month (Labour Law Art. 51).',
    action: !unread && late > 0 ? 'Approve and lock the outstanding runs.' : undefined,
    href: '/dashboard/payroll/approvals',
  });

  // ── Overtime ─────────────────────────────────────────────────────────────
  const ot = comp.get('overtimePay') ?? null;
  rows.push({
    key: 'overtime',
    area: 'Overtime Compliance',
    status: unread ? 'unknown' : 'monitoring',
    metric: money(unread ? null : ot),
    description:
      'Overtime is paid at 1.25× basic on weekdays and 1.5× on rest days (Labour Law Art. 73).',
    action: 'Rates are set per employment type on the overtime policy.',
    href: '/dashboard/overtime',
  });

  // ── Leave ────────────────────────────────────────────────────────────────
  rows.push({
    key: 'leave',
    area: 'Leave Entitlements',
    // Nothing in the payroll aggregate measures entitlement, and pretending
    // otherwise is what this panel used to do.
    status: 'unknown',
    metric: money(unread ? null : comp.get('leaveEncashment') ?? 0),
    description:
      'Annual leave (30 days), sick leave and Eid / national holiday entitlement. Encashment shown is what payroll paid out.',
    action: 'Balances are tracked on the leave module, not in the pay run.',
    href: '/dashboard/leaves/balances',
  });

  // ── The 25% deduction cap ────────────────────────────────────────────────
  const deductions = summary?.money.deductions ?? null;
  const net = summary?.money.net ?? null;
  const capRatio =
    deductions !== null && net !== null && net > 0 ? (deductions / net) * 100 : null;
  rows.push({
    key: 'deductions',
    area: 'Salary Deductions',
    // The rule is per employee; this is the run-wide ratio, which can only ever
    // be a smoke alarm. Said plainly rather than sold as the verdict.
    status: unread ? 'unknown' : capRatio !== null && capRatio > 25 ? 'review' : 'monitoring',
    metric: capRatio === null ? '—' : `${capRatio.toFixed(0)}% of net, run-wide`,
    description:
      'Deductions must not exceed 25% of net salary per employee (Labour Law Art. 53). This is the run-wide ratio, not the per-employee test.',
    action: 'Run the pre-payroll validation for the per-employee check.',
    href: '/dashboard/payroll/validate',
  });

  // ── EOSB ─────────────────────────────────────────────────────────────────
  rows.push({
    key: 'eosb',
    area: 'Final Settlements (EOSB)',
    status: unread
      ? 'unknown'
      : (settlements?.awaitingPayment ?? 0) > 0
      ? 'review'
      : 'compliant',
    metric: unread
      ? '—'
      : (settlements?.awaitingPayment ?? 0) > 0
      ? `${settlements!.awaitingPayment} awaiting · ${formatAmountWithSymbol(settlements!.openPayout)}`
      : 'None outstanding',
    description:
      'End-of-service benefit at 15 days per year for the first 3 years and 1 month per year thereafter.',
    action:
      !unread && (settlements?.awaitingPayment ?? 0) > 0
        ? 'Settlements are approved but not paid.'
        : undefined,
    href: '/dashboard/payroll/settlements',
  });

  // ── Payment readiness ────────────────────────────────────────────────────
  const blocked = readiness ? readiness.noBankRecord + readiness.incompleteFields : null;
  rows.push({
    key: 'readiness',
    area: 'Bank Details',
    status: unread || !readiness ? 'unknown' : blocked! > 0 ? 'review' : 'compliant',
    metric:
      unread || !readiness
        ? '—'
        : readiness.readyRate === null
        ? 'Nothing could be checked'
        : `${readiness.readyRate.toFixed(0)}% ready`,
    description:
      'An employee with a missing or malformed bank record cannot be paid by transfer.',
    action: blocked ? `${blocked} employee(s) cannot be paid.` : undefined,
    href: '/dashboard/banks',
  });

  // ── PIT 2028 ─────────────────────────────────────────────────────────────
  rows.push({
    key: 'pit',
    area: 'PIT 2028 Readiness',
    status: 'monitoring',
    metric: 'Not yet in force',
    description:
      'Oman personal income tax takes effect in 2028 (draft guidance). Nothing is withheld today.',
    action: 'Income-tax rules are configured in payroll settings.',
    href: '/dashboard/settings',
  });

  return rows;
}

/**
 * Oman payroll compliance, scored against the hub aggregate.
 *
 * Two things this panel is careful about, both learned from what it used to do:
 *
 *  - **It never invents a verdict.** Every figure comes from the same aggregate
 *    the rest of the hub reads. An area the aggregate cannot judge is marked
 *    `Not measured` and points at the screen that can, instead of showing a
 *    green tick over data nobody looked at.
 *  - **Every row is a link.** An exception is only useful if the next click is
 *    the screen that clears it, so the row carries both the rule it is testing
 *    and where to go and act on it.
 */
export function OmanCompliancePanel({
  summary,
  loading = false,
  failed = false,
}: {
  summary?: PayrollHubSummary;
  loading?: boolean;
  failed?: boolean;
} = {}) {
  const { isOman, loading: detecting } = useIsOman();

  if (detecting || !isOman) return null;

  const rows = buildRows(summary, failed);
  const count = (s: ComplianceStatus) => rows.filter((r) => r.status === s).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="surface-panel rounded-[20px] overflow-hidden"
      data-testid="oman-compliance"
    >
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-surface-border">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-1.5 h-10 rounded-full bg-gradient-to-b from-[#DB161E] via-[#ffffff] to-[#007A3D]" />
            <div>
              <h3 className="text-[15px] font-bold text-text-heading tracking-tight">
                Oman Payroll Compliance
              </h3>
              <p className="text-xs text-text-muted mt-0.5">
                {summary && !failed
                  ? `Labour Law 2003 · SPF · EOSB · PIT 2028 · scored on ${summary.anchor.label}`
                  : 'Labour Law 2003 · SPF · EOSB · PIT 2028'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {(
              [
                ['compliant', ShieldCheck],
                ['review', AlertTriangle],
                ['monitoring', Clock],
                ['unknown', HelpCircle],
              ] as Array<[ComplianceStatus, typeof ShieldCheck]>
            )
              .filter(([s]) => count(s) > 0)
              .map(([s, Icon]) => (
                <span
                  key={s}
                  className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_CONFIG[s].badge}`}
                >
                  <Icon size={12} /> {count(s)} {STATUS_CONFIG[s].label}
                </span>
              ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="px-6 py-8 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-8 rounded bg-surface-page animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-page border-b border-surface-border">
                  <th className="px-6 py-3 text-start text-[11px] font-semibold text-text-muted uppercase tracking-widest w-[28%]">
                    Compliance Area
                  </th>
                  <th className="px-4 py-3 text-start text-[11px] font-semibold text-text-muted uppercase tracking-widest w-[16%]">
                    Status
                  </th>
                  <th className="px-4 py-3 text-start text-[11px] font-semibold text-text-muted uppercase tracking-widest w-[20%]">
                    Key Metric
                  </th>
                  <th className="px-4 py-3 text-start text-[11px] font-semibold text-text-muted uppercase tracking-widest">
                    What the rule says
                  </th>
                  <th className="px-4 py-3 w-10" aria-hidden />
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {rows.map((row, i) => (
                  <motion.tr
                    key={row.key}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.05 + i * 0.04 }}
                    className={`group transition-colors cursor-pointer ${STATUS_CONFIG[row.status].rowBg}`}
                    onClick={(e) => {
                      // The whole row is the target; the anchor inside it keeps
                      // the row reachable by keyboard and middle-click.
                      const link = e.currentTarget.querySelector('a');
                      if (link && e.target !== link) link.click();
                    }}
                  >
                    <td className="px-6 py-3.5">
                      <span className="text-sm font-semibold text-text-heading group-hover:text-brand-primary transition-colors">
                        {row.area}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <StatusDot status={row.status} />
                    </td>
                    <td className="px-4 py-3.5 text-sm text-text-body font-medium tabular-nums">
                      {row.metric}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-start gap-1.5">
                        <StatusIcon status={row.status} />
                        <span className="text-xs text-text-muted leading-relaxed">
                          {row.description}
                          {row.action && (
                            <span className="block mt-0.5 font-semibold text-text-body">
                              {row.action}
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-end">
                      <Link
                        href={row.href}
                        data-testid={`compliance-link-${row.key}`}
                        aria-label={`Open ${row.area}`}
                        className="inline-flex text-text-muted group-hover:text-brand-primary transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ChevronRight size={16} className="rtl:rotate-180" />
                      </Link>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden divide-y divide-surface-border">
            {rows.map((row, i) => (
              <motion.div
                key={row.key}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.05 + i * 0.04 }}
              >
                <Link
                  href={row.href}
                  className={`block px-4 py-4 ${STATUS_CONFIG[row.status].rowBg} transition-colors`}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span className="text-sm font-semibold text-text-heading leading-tight">
                      {row.area}
                    </span>
                    <StatusDot status={row.status} />
                  </div>
                  <div className="mb-1.5">
                    <span className="text-xs font-medium text-text-body">{row.metric}</span>
                  </div>
                  <div className="flex items-start gap-1.5">
                    <StatusIcon status={row.status} />
                    <p className="text-xs text-text-muted leading-relaxed">
                      {row.description}
                      {row.action && (
                        <span className="block mt-0.5 font-semibold text-text-body">
                          {row.action}
                        </span>
                      )}
                    </p>
                  </div>
                </Link>
              </motion.div>
            ))}
          </div>
        </>
      )}

      {/* Footer note */}
      <div className="px-6 py-3.5 border-t border-surface-border bg-surface-page flex items-start gap-2">
        <Info size={13} className="text-text-muted shrink-0 mt-0.5" />
        <p className="text-[11px] text-text-muted">
          Every figure here comes from the same locked-run aggregate as the cards above.
          Areas marked <span className="font-semibold">Not measured</span> are not judged by
          payroll — open the row for the screen that does. PIT 2028 status follows Oman
          Ministry of Finance draft guidance and withholds nothing today.
        </p>
      </div>
    </motion.div>
  );
}

export default OmanCompliancePanel;
