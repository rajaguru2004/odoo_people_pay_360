'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Edit,
  Info,
  Save,
  Search,
  X,
} from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { impliedDailyRate, isDailyWage } from '@/utils/payBasis';
import type { PayrollItem } from '@/types/payroll';

/**
 * One payroll run's payslips.
 *
 * Replaces an eleven-column grid that put Basic, Work days, Absence, Allowance,
 * Bonus, Overtime, SPF, Tax and Net side by side. At six employees it was
 * already wrapping employee names onto three lines; at a real headcount it is
 * a horizontal scroll with no row the eye can follow across.
 *
 * The shape here is the one the reader actually asks for, in the order they ask
 * it: **who, how many days, what it totalled, what came off, what they get** —
 * with every component figure one click away in the row's own detail panel
 * rather than crushed into a 90px column. The columns that survived are the
 * four a payroll officer reconciles against the bank; the rest are breakdown,
 * and breakdown belongs under a disclosure.
 *
 * Two things the old table could not do and this one must:
 *
 *  - **An exception is a link.** "3 absent" and "no salary structure" were
 *    printed as red text with nowhere to go. Each one now names the screen that
 *    explains or fixes it.
 *  - **A row that does not reconcile says so.** Earnings − deductions is net,
 *    always; three earning columns (`siteAllowance`, `leaveEncashment`,
 *    `gratuityPayout`) are absent from most gross formulas in this codebase, so
 *    a row where the sum disagrees with the stored net is a real defect and is
 *    flagged rather than rounded away.
 */

/** A payslip amount that is an earning. Order is the order the panel lists them. */
const EARNING_KEYS = [
  'baseSalary',
  'allowances',
  'bonus',
  'overtimePay',
  'foodAllowance',
  'siteAllowance',
  'leaveEncashment',
  'gratuityPayout',
] as const;

/** A payslip amount that comes off. `deduction` is discipline + loss of pay. */
const DEDUCTION_KEYS = [
  'deduction',
  'insurance',
  'tax',
  'garnishment',
  'otherRecovery',
] as const;

/** Where each payslip line is decided, for the detail panel's links. */
const LINE_LINKS: Partial<Record<string, string>> = {
  baseSalary: '/dashboard/payroll/salary-structure',
  allowances: '/dashboard/payroll/salary-structure',
  bonus: '/dashboard/payroll/salary-structure',
  overtimePay: '/dashboard/overtime',
  foodAllowance: '/dashboard/overtime',
  siteAllowance: '/dashboard/overtime',
  leaveEncashment: '/dashboard/payroll/encashment',
  gratuityPayout: '/dashboard/payroll/settlements',
  deduction: '/dashboard/attendance',
  garnishment: '/dashboard/garnishments',
  otherRecovery: '/dashboard/payroll/recoveries',
};

const num = (v: unknown): number => Number(v) || 0;

export interface RowException {
  /** Translated by the component through `exception.<key>` — never a literal. */
  key: 'zeroNet' | 'residual' | 'noStructure' | 'absent';
  /** Only `absent` carries one. */
  count?: number;
  href: string;
  severity: 'critical' | 'warning';
}

export interface RunRow {
  item: PayrollItem;
  daily: boolean;
  gross: number;
  deductions: number;
  net: number;
  /** `gross − deductions − net`. Non-zero is a defect, not a rounding artefact. */
  residual: number;
  absentDays: number;
  exceptions: RowException[];
}

/** The whole run's arithmetic, computed once for the table and the cards above it. */
export function buildRunRows(items: PayrollItem[]): RunRow[] {
  return items.map((item) => {
    const daily = isDailyWage(item.employee?.salaryType);
    const gross = EARNING_KEYS.reduce(
      (a, k) => a + num((item as unknown as Record<string, unknown>)[k]),
      0,
    );
    const deductions = DEDUCTION_KEYS.reduce(
      (a, k) => a + num((item as unknown as Record<string, unknown>)[k]),
      0,
    );
    const net = num(item.netSalary);
    // Absence is a MONTHLY concept: a daily-wage worker can exceed the month's
    // nominal work days, so the difference is noise for them.
    const absentDays = daily ? 0 : num(item.workDays) - num(item.actualWorkDays);
    const residual = gross - deductions - net;

    const exceptions: RowException[] = [];
    if (net <= 0) {
      exceptions.push({ key: 'zeroNet', href: '/dashboard/payroll/validate', severity: 'critical' });
    }
    if (Math.abs(residual) >= 0.01) {
      exceptions.push({ key: 'residual', href: '/dashboard/payroll/reports', severity: 'critical' });
    }
    if (!daily && num(item.baseSalary) <= 0) {
      exceptions.push({
        key: 'noStructure',
        href: '/dashboard/payroll/salary-structure',
        severity: 'critical',
      });
    }
    if (absentDays > 0) {
      exceptions.push({
        key: 'absent',
        count: absentDays,
        href: '/dashboard/attendance',
        severity: 'warning',
      });
    }
    return { item, daily, gross, deductions, net, residual, absentDays, exceptions };
  });
}

/** The run totals the summary cards print. Same arithmetic, summed once. */
export function runTotals(rows: RunRow[]) {
  const sum = (pick: (r: RunRow) => number) => rows.reduce((a, r) => a + pick(r), 0);
  const column = (key: string) =>
    rows.reduce((a, r) => a + num((r.item as unknown as Record<string, unknown>)[key]), 0);
  return {
    employees: rows.length,
    gross: sum((r) => r.gross),
    deductions: sum((r) => r.deductions),
    net: sum((r) => r.net),
    statutory: column('insurance'),
    tax: column('tax'),
    lop: column('deduction'),
    /** How many rows carry at least one exception — the filter's badge. */
    withExceptions: rows.filter((r) => r.exceptions.length > 0).length,
  };
}

function ExceptionChips({ exceptions }: { exceptions: RowException[] }) {
  const t = useTranslations('payrollDetailPage');
  if (exceptions.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {exceptions.map((e) => (
        <Link
          key={e.key}
          href={e.href}
          data-testid="payroll-row-exception"
          data-exception={e.key}
          onClick={(ev) => ev.stopPropagation()}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${
            e.severity === 'critical'
              ? 'bg-status-error-bg text-status-error hover:brightness-95'
              : 'bg-status-warning-bg text-status-warning hover:brightness-95'
          }`}
        >
          <AlertTriangle size={10} />
          {(t as unknown as (k: string, v?: Record<string, unknown>) => string)(
            `exception.${e.key}`,
            { count: e.count ?? 0 },
          )}
          <ChevronRight size={10} className="rtl:rotate-180" />
        </Link>
      ))}
    </span>
  );
}

/** One earning or deduction, with the screen that decides it. */
function LineRow({
  label,
  amount,
  href,
  tone,
}: {
  label: string;
  amount: number;
  href?: string;
  tone: 'earning' | 'deduction';
}) {
  const body = (
    <>
      <span className="text-[12px] text-text-body group-hover/line:text-brand-primary transition-colors">
        {label}
      </span>
      <span
        className={`ms-auto text-[12px] font-semibold tabular-nums ${
          tone === 'earning' ? 'text-status-success' : 'text-status-error'
        }`}
      >
        {tone === 'deduction' && amount > 0 ? '− ' : ''}
        {formatCurrency(amount)}
      </span>
    </>
  );
  return href ? (
    <Link
      href={href}
      className="group/line flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-card transition-colors"
    >
      {body}
      <ChevronRight size={11} className="text-text-muted rtl:rotate-180" />
    </Link>
  ) : (
    <div className="flex items-center gap-2 px-2 py-1">{body}</div>
  );
}

export default function PayrollRunTable({
  rows,
  labels,
  canEdit,
  editingItem,
  editValues,
  onEdit,
  onCancelEdit,
  onChangeEdit,
  onSave,
}: {
  rows: RunRow[];
  /** The tenant's own words for its statutory lines — SPF, EPF, CPF. */
  labels: { pf: string; tax: string; netSalary: string };
  canEdit: boolean;
  editingItem: string | null;
  editValues: Record<string, number | string>;
  onEdit: (item: PayrollItem) => void;
  onCancelEdit: () => void;
  onChangeEdit: (patch: Record<string, number | string>) => void;
  onSave: (itemId: string) => void;
}) {
  const t = useTranslations('payrollDetailPage');
  const tc = useTranslations('common');
  const [query, setQuery] = useState('');
  const [onlyExceptions, setOnlyExceptions] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const totals = useMemo(() => runTotals(rows), [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (onlyExceptions && r.exceptions.length === 0) return false;
      if (!q) return true;
      const e = r.item.employee;
      return (
        (e?.fullName ?? '').toLowerCase().includes(q) ||
        (e?.employeeCode ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, query, onlyExceptions]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const labelFor = (key: string): string => {
    if (key === 'insurance') return labels.pf;
    if (key === 'tax') return labels.tax;
    return t(`line.${key}` as never);
  };

  return (
    <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden">
      {/* Toolbar — a run with a real headcount is unusable without one */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-surface-border bg-surface-page">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search
            size={15}
            className="absolute start-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            data-testid="payroll-run-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full ps-9 pe-3 py-2 text-sm rounded-[--radius-input] border border-surface-border bg-surface-card text-text-body"
          />
        </div>

        <button
          type="button"
          data-testid="payroll-run-only-exceptions"
          aria-pressed={onlyExceptions}
          onClick={() => setOnlyExceptions((v) => !v)}
          disabled={totals.withExceptions === 0}
          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-[--radius-button] text-xs font-semibold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            onlyExceptions
              ? 'bg-status-error-bg text-status-error border-status-error/40'
              : 'bg-surface-card text-text-body border-surface-border hover:bg-surface-page'
          }`}
        >
          <AlertTriangle size={13} />
          {t('onlyExceptions', { count: totals.withExceptions })}
        </button>

        <span className="ms-auto text-xs text-text-muted">
          {t('showingCount', { shown: visible.length, total: rows.length })}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-surface-page border-b border-surface-border">
            <tr>
              <th className="w-8 px-2 py-3" aria-hidden />
              <th className="px-4 py-3 text-start text-xs font-semibold text-text-heading">
                {tc('employee')}
              </th>
              <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                <span className="inline-flex items-center gap-1">
                  {t('colWorkDays')}
                  <span className="relative group/th">
                    <Info size={12} className="text-text-muted cursor-help" />
                    <span className="absolute end-0 top-full mt-1 w-52 bg-gray-900 text-white text-xs rounded-lg p-2 shadow-xl z-30 pointer-events-none opacity-0 group-hover/th:opacity-100 transition-opacity whitespace-normal leading-relaxed font-normal">
                      {t('absenceLopTooltip')}
                    </span>
                  </span>
                </span>
              </th>
              {/* 4.1 — the total first, then what comes off it, then the net.
                  A table that jumped straight from six component columns to Net
                  never showed the figure the two sides are reconciled against. */}
              <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                {t('colTotalEarnings')}
              </th>
              <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                {t('colTotalDeductions')}
              </th>
              <th className="px-4 py-3 text-end text-xs font-semibold text-text-heading">
                {labels.netSalary}
              </th>
              {canEdit && (
                <th className="px-4 py-3 text-center text-xs font-semibold text-text-heading">
                  {tc('actions')}
                </th>
              )}
            </tr>
          </thead>

          <tbody className="divide-y divide-surface-border">
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={canEdit ? 7 : 6}
                  className="px-4 py-10 text-center text-sm text-text-muted"
                >
                  {rows.length === 0 ? t('noItems') : t('noMatches')}
                </td>
              </tr>
            )}

            {visible.map((row) => {
              const item = row.item;
              const isOpen = expanded.has(item.id);
              const isEditing = editingItem === item.id;

              return (
                // A keyed Fragment: the row and its detail row are siblings in
                // <tbody>, and React needs the key on the outermost node.
                <Fragment key={item.id}>
                  <tr
                    data-testid="payroll-run-row"
                    data-item-id={item.id}
                    data-exceptions={row.exceptions.length}
                    onClick={() => toggle(item.id)}
                    className="hover:bg-surface-page transition-colors cursor-pointer"
                  >
                    <td className="px-2 py-3 text-center align-top">
                      <span className="inline-flex text-text-muted">
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} className="rtl:rotate-180" />}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/employees/${item.employeeId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-semibold text-text-heading text-sm hover:text-brand-primary transition-colors"
                      >
                        {item.employee?.fullName}
                      </Link>
                      {row.daily && (
                        <span className="ms-2 inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 align-middle">
                          {t('dailyWageBadge')}
                        </span>
                      )}
                      <p className="text-xs text-text-muted">{item.employee?.employeeCode}</p>
                      <div className="mt-1">
                        <ExceptionChips exceptions={row.exceptions} />
                      </div>
                    </td>

                    <td className="px-4 py-3 text-end text-sm text-text-body align-top">
                      {/* The nominal-month denominator is meaningless for daily
                          wage — those staff can work more days than the month
                          nominally holds. */}
                      {row.daily
                        ? t('daysPaidOnly', { days: num(item.actualWorkDays) })
                        : `${item.actualWorkDays}/${item.workDays}`}
                    </td>

                    <td className="px-4 py-3 text-end text-sm font-semibold text-status-success tabular-nums align-top">
                      {formatCurrency(row.gross)}
                    </td>

                    <td className="px-4 py-3 text-end text-sm font-semibold text-status-error tabular-nums align-top">
                      {row.deductions > 0 ? '− ' : ''}
                      {formatCurrency(row.deductions)}
                    </td>

                    <td className="px-4 py-3 text-end align-top">
                      <span className="font-bold text-text-heading tabular-nums">
                        {formatCurrency(row.net)}
                      </span>
                    </td>

                    {canEdit && (
                      <td className="px-4 py-3 text-center align-top" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => {
                            onEdit(item);
                            setExpanded((prev) => new Set(prev).add(item.id));
                          }}
                          className="p-1 hover:bg-brand-primary/10 rounded-[--radius-button] text-brand-primary"
                          title={tc('edit')}
                          data-testid="payroll-run-edit"
                        >
                          <Edit size={16} />
                        </button>
                      </td>
                    )}
                  </tr>

                  {isOpen && (
                    <tr className="bg-surface-page/60">
                      <td colSpan={canEdit ? 7 : 6} className="px-4 pb-5 pt-1">
                        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                          {/* Earnings */}
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">
                              {t('colTotalEarnings')}
                            </p>
                            <div className="rounded-[--radius-card] border border-surface-border bg-surface-card/60 p-1">
                              {EARNING_KEYS.filter(
                                (k) => num((item as unknown as Record<string, unknown>)[k]) !== 0,
                              ).map((k) => (
                                <LineRow
                                  key={k}
                                  label={labelFor(k)}
                                  amount={num((item as unknown as Record<string, unknown>)[k])}
                                  href={LINE_LINKS[k]}
                                  tone="earning"
                                />
                              ))}
                              {row.daily && (
                                <p className="px-2 py-1 text-[11px] text-text-muted">
                                  {t('daysTimesRate', {
                                    days: num(item.actualWorkDays),
                                    rate: formatCurrency(
                                      impliedDailyRate(item.baseSalary, item.actualWorkDays) ?? 0,
                                    ),
                                  })}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Deductions */}
                          <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">
                              {t('colTotalDeductions')}
                            </p>
                            <div className="rounded-[--radius-card] border border-surface-border bg-surface-card/60 p-1">
                              {DEDUCTION_KEYS.filter(
                                (k) => num((item as unknown as Record<string, unknown>)[k]) !== 0,
                              ).map((k) => (
                                <LineRow
                                  key={k}
                                  label={labelFor(k)}
                                  amount={num((item as unknown as Record<string, unknown>)[k])}
                                  href={LINE_LINKS[k]}
                                  tone="deduction"
                                />
                              ))}
                              {row.deductions === 0 && (
                                <p className="px-2 py-1 text-[12px] text-text-muted">
                                  {row.daily ? t('noLopForDailyWage') : t('noDeductions')}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Reconciliation + notes */}
                          <div className="space-y-3">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">
                                {t('reconciliation')}
                              </p>
                              <div className="rounded-[--radius-card] border border-surface-border bg-surface-card/60 px-3 py-2 text-[12px] space-y-1">
                                <div className="flex justify-between">
                                  <span className="text-text-body">{t('colTotalEarnings')}</span>
                                  <span className="font-semibold tabular-nums text-status-success">
                                    {formatCurrency(row.gross)}
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-text-body">{t('colTotalDeductions')}</span>
                                  <span className="font-semibold tabular-nums text-status-error">
                                    − {formatCurrency(row.deductions)}
                                  </span>
                                </div>
                                <div className="flex justify-between border-t border-surface-border pt-1">
                                  <span className="font-semibold text-text-heading">
                                    {labels.netSalary}
                                  </span>
                                  <span className="font-bold tabular-nums text-text-heading">
                                    {formatCurrency(row.net)}
                                  </span>
                                </div>
                                {Math.abs(row.residual) >= 0.01 && (
                                  <Link
                                    href="/dashboard/payroll/reports"
                                    className="flex items-start gap-1 pt-1 text-[11px] text-status-error hover:underline"
                                  >
                                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                                    {t('residualWarning', {
                                      amount: formatCurrency(Math.abs(row.residual)),
                                    })}
                                  </Link>
                                )}
                              </div>
                            </div>

                            {item.notes && (
                              <div>
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">
                                  {t('notesLabel')}
                                </p>
                                <p className="rounded-[--radius-card] border border-surface-border bg-surface-card/60 px-3 py-2 text-[12px] text-text-body leading-relaxed">
                                  {item.notes}
                                </p>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Editing lives here now: every editable figure in one
                            form, instead of six inputs wedged into six columns
                            that pushed the table past the viewport. */}
                        {isEditing && (
                          <div
                            className="mt-4 rounded-[--radius-card] border-2 border-brand-primary/40 bg-surface-card p-4"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                              {(
                                [
                                  ['allowances', t('line.allowances')],
                                  ['bonus', t('line.bonus')],
                                  ['deduction', t('line.deduction')],
                                  ['overtimeHours', t('overtimeHoursLabel')],
                                  ['foodAllowance', t('line.foodAllowance')],
                                ] as Array<[string, string]>
                              ).map(([field, label]) => (
                                <label key={field} className="block">
                                  <span className="block text-[11px] font-semibold text-text-muted mb-1">
                                    {label}
                                  </span>
                                  <input
                                    type="number"
                                    data-testid={`payroll-run-edit-${field}`}
                                    value={String(editValues[field] ?? 0)}
                                    onChange={(e) =>
                                      onChangeEdit({ [field]: Number(e.target.value) })
                                    }
                                    className="w-full px-2 py-1.5 border border-surface-border rounded-[--radius-input] bg-surface-card text-text-body text-end text-sm"
                                  />
                                </label>
                              ))}
                            </div>
                            <label className="block mt-3">
                              <span className="block text-[11px] font-semibold text-text-muted mb-1">
                                {t('notesLabel')}
                              </span>
                              <input
                                type="text"
                                data-testid="payroll-run-edit-notes"
                                value={String(editValues.notes ?? '')}
                                onChange={(e) => onChangeEdit({ notes: e.target.value })}
                                className="w-full px-2 py-1.5 border border-surface-border rounded-[--radius-input] bg-surface-card text-text-body text-sm"
                              />
                            </label>
                            <div className="mt-3 flex justify-end gap-2">
                              <button
                                onClick={onCancelEdit}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-[--radius-button] border border-surface-border text-sm font-semibold text-text-body"
                              >
                                <X size={14} />
                                {tc('cancel')}
                              </button>
                              <button
                                data-testid="payroll-run-edit-save"
                                onClick={() => onSave(item.id)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-[--radius-button] bg-brand-primary text-text-on-brand text-sm font-semibold"
                              >
                                <Save size={14} />
                                {tc('save')}
                              </button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>

          {visible.length > 0 && (
            <tfoot className="border-t-2 border-surface-border bg-surface-page">
              <tr>
                <td />
                <td className="px-4 py-3 text-sm font-bold text-text-heading">
                  {t('totalsRow', { count: visible.length })}
                </td>
                <td />
                <td className="px-4 py-3 text-end text-sm font-bold text-status-success tabular-nums">
                  {formatCurrency(visible.reduce((a, r) => a + r.gross, 0))}
                </td>
                <td className="px-4 py-3 text-end text-sm font-bold text-status-error tabular-nums">
                  − {formatCurrency(visible.reduce((a, r) => a + r.deductions, 0))}
                </td>
                <td className="px-4 py-3 text-end text-sm font-extrabold text-text-heading tabular-nums">
                  {formatCurrency(visible.reduce((a, r) => a + r.net, 0))}
                </td>
                {canEdit && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
