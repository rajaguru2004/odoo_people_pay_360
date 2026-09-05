'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Loader2,
  Plus,
  Trash2,
  AlertTriangle,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import PageActionRow from '@/components/common/PageActionRow';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ExportButton from '@/components/common/ExportButton';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import budgetService from '@/services/budgetService';
import libraryService from '@/services/libraryService';
import MasterEmptyHint from '@/components/common/MasterEmptyHint';
import departmentService from '@/services/departmentService';
import { UpsertBudgetLineData, VarianceReport } from '@/types/budget';
import { apiErrorMessage } from '@/utils/apiError';

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30';

function money(v: number, currency: string) {
  return `${currency} ${v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Green under 80%, amber to 100%, red over. */
function utilizationStyle(u: number) {
  if (u > 1) return 'bg-red-500';
  if (u >= 0.8) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function VariancePageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const budgetId = params?.id as string;

  const [report, setReport] = useState<VarianceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<string[]>([]);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [showLineForm, setShowLineForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lineForm, setLineForm] = useState<UpsertBudgetLineData>({
    category: '',
    plannedAmount: 0,
  });
  const { confirm, ConfirmDialog, closeModal } = useConfirm();

  /**
   * The heading is the record's own name, so it is only known once the report
   * lands. Until then this falls back to a static "Budget" rather than an empty
   * string: TopHeader resolves the declared title with `??`, which an empty
   * string satisfies, so `''` would paint a blank heading while loading instead
   * of falling through to the static map.
   */
  const budgetName = report?.budget.name ?? 'Budget';

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    budgetName,
    report
      ? `FY${report.budget.fiscalYear} · ${report.budget.status} · ${report.budget.branch?.name ?? ''}`
      : undefined,
  );

  const load = useCallback(async () => {
    if (!budgetId) return;
    setLoading(true);
    try {
      const res = await budgetService.variance(budgetId);
      setReport(res.data);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load the variance report'));
    } finally {
      setLoading(false);
    }
  }, [budgetId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const [cats, depts] = await Promise.all([
          libraryService.getAll('BUDGET_CATEGORY', true),
          departmentService.getAll(),
        ]);
        setCategories((cats.data || []).map((c: any) => c.label));
        setDepartments(
          (depts.data || []).map((d: any) => ({ id: d.id, name: d.name })),
        );
      } catch {
        // Non-fatal — the pickers are just empty.
      }
    })();
  }, []);

  const submitLine = async () => {
    if (!lineForm.category) {
      toast.warning('Pick a category');
      return;
    }
    setSaving(true);
    try {
      await budgetService.upsertLine(budgetId, lineForm);
      toast.success('Budget line saved');
      setShowLineForm(false);
      setLineForm({ category: '', plannedAmount: 0 });
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to save the line'));
    } finally {
      setSaving(false);
    }
  };

  const removeLine = async (lineId: string, label: string) => {
    const ok = await confirm({
      title: 'Delete budget line',
      message: `Delete the ${label} line? This is blocked while approved requests still hold commitments against it.`,
      type: 'danger',
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      await budgetService.removeLine(budgetId, lineId);
      toast.success('Budget line deleted');
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to delete the line'));
    } finally {
      // `confirm()` leaves the dialog up so the caller can paint "Processing…"
      // over its own work, so every exit owes it a close — and the refusal path
      // most of all, since a line WITH commitments is refused and that is the
      // case a reader is most likely to hit.
      closeModal();
    }
  };

  const currency = report?.budget.currency ?? 'OMR';

  /** Client-side CSV — the report is already fully loaded, so no round-trip. */
  const exportCsv = async () => {
    if (!report) return;
    const header = [
      'Department',
      'Category',
      'Planned',
      'Committed',
      'Actual',
      'Remaining',
      'Utilization %',
    ];
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      header.join(','),
      ...report.rows.map((r) =>
        [
          escape(r.departmentName),
          escape(r.category),
          r.planned,
          r.committed,
          r.actual,
          r.remaining,
          Math.round(r.utilization * 100),
        ].join(','),
      ),
      // Spend with no line belongs in the export too, or the CSV understates it.
      ...report.unbudgeted.map((u) =>
        [escape('(unbudgeted)'), escape(u.category), 0, 0, u.actual, -u.actual, ''].join(
          ',',
        ),
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `budget-variance-FY${report.budget.fiscalYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 space-y-6">
      <PageActionRow
        // Back goes to the list this record was opened from, which is where the
        // old "All budgets" link went — not `router.back()`, which can leave the
        // dashboard entirely when the page was reached by a direct link.
        onBack={() => router.push('/dashboard/budgets')}
        action={
          <div className="flex items-center gap-2">
            {report && (
              <ExportButton
                onExport={exportCsv}
                label="Export CSV"
                testId="budget-export"
              />
            )}
            <button
              data-testid="budget-line-new"
              onClick={() => setShowLineForm((s) => !s)}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white"
            >
              <Plus size={16} /> Budget line
            </button>
          </div>
        }
      />

      {showLineForm && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">
              Add or update a budget line
            </h3>
            <button onClick={() => setShowLineForm(false)} className="text-slate-400">
              <X size={18} />
            </button>
          </div>
          {categories.length === 0 && (
            <MasterEmptyHint what="budget categories" className="mb-3" />
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <select
              data-testid="budget-line-category"
              className={inputCls}
              value={lineForm.category}
              onChange={(e) => setLineForm({ ...lineForm, category: e.target.value })}
            >
              <option value="">Category…</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              data-testid="budget-line-department"
              className={inputCls}
              value={lineForm.departmentId ?? ''}
              onChange={(e) =>
                setLineForm({
                  ...lineForm,
                  departmentId: e.target.value || undefined,
                })
              }
            >
              <option value="">Company-wide (fallback)</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <input
              data-testid="budget-line-amount"
              type="number"
              min={0}
              className={inputCls}
              placeholder="Planned amount"
              value={lineForm.plannedAmount}
              onChange={(e) =>
                setLineForm({ ...lineForm, plannedAmount: Number(e.target.value) })
              }
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            A company-wide line catches spend from departments with no line of their
            own.
          </p>
          <div className="mt-4 flex justify-end">
            <button
              data-testid="budget-line-save"
              onClick={submitLine}
              disabled={saving}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : !report ? null : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[
              { label: 'Planned', value: report.totals.planned, tone: 'text-slate-900' },
              {
                label: 'Committed',
                value: report.totals.committed,
                tone: 'text-amber-600',
                hint: 'Approved but not yet paid',
              },
              {
                label: 'Actual',
                value: report.totals.actual,
                tone: 'text-blue-600',
                hint: 'Money that has been paid',
              },
              {
                label: 'Remaining',
                value: report.totals.remaining,
                tone:
                  report.totals.remaining < 0 ? 'text-red-600' : 'text-emerald-600',
              },
            ].map((tile) => (
              <div
                key={tile.label}
                data-testid={`budget-total-${tile.label.toLowerCase()}`}
                // The rendered figure is currency- and locale-formatted, so the
                // raw number is published beside it — a test that parsed
                // "OMR 1,250.00" would be asserting `toLocaleString`.
                data-amount={tile.value}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <p className="text-xs font-medium text-slate-500">{tile.label}</p>
                <p className={`mt-1 text-xl font-bold ${tile.tone}`}>
                  {money(tile.value, currency)}
                </p>
                {tile.hint && (
                  <p className="mt-0.5 text-[11px] text-slate-400">{tile.hint}</p>
                )}
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Department</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Planned</th>
                  <th className="px-4 py-3 text-right">Committed</th>
                  <th className="px-4 py-3 text-right">Actual</th>
                  <th className="px-4 py-3 text-right">Remaining</th>
                  <th className="px-4 py-3">Used</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.rows.length === 0 ? (
                  <tr>
                    <td
                      data-testid="budget-variance-empty"
                      colSpan={8}
                      className="px-4 py-10 text-center text-slate-400"
                    >
                      No budget lines yet.
                    </td>
                  </tr>
                ) : (
                  report.rows.map((r) => (
                    <tr
                      key={r.budgetLineId}
                      data-testid="budget-line-row"
                      data-line-id={r.budgetLineId}
                      // Same reason as the totals tiles: the cells are formatted
                      // money, these are the numbers behind them.
                      data-planned={r.planned}
                      data-committed={r.committed}
                      className="hover:bg-slate-50/60"
                    >
                      <td className="px-4 py-3 text-slate-800">{r.departmentName}</td>
                      <td className="px-4 py-3 text-slate-600">{r.category}</td>
                      <td className="px-4 py-3 text-right text-slate-800">
                        {money(r.planned, currency)}
                      </td>
                      <td className="px-4 py-3 text-right text-amber-700">
                        {money(r.committed, currency)}
                      </td>
                      <td className="px-4 py-3 text-right text-blue-700">
                        {money(r.actual, currency)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-medium ${r.remaining < 0 ? 'text-red-600' : 'text-emerald-700'}`}
                      >
                        {money(r.remaining, currency)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-full ${utilizationStyle(r.utilization)}`}
                              style={{
                                width: `${Math.min(r.utilization * 100, 100)}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs text-slate-500">
                            {Math.round(r.utilization * 100)}%
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          data-testid="budget-line-delete"
                          onClick={() =>
                            removeLine(
                              r.budgetLineId,
                              `${r.departmentName} / ${r.category}`,
                            )
                          }
                          className="inline-flex h-8 items-center rounded-lg border border-red-200 px-2 text-red-600 hover:bg-red-50"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {report.unbudgeted.length > 0 && (
            <div
              data-testid="budget-unbudgeted"
              className="rounded-2xl border border-amber-200 bg-amber-50 p-4"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div className="w-full">
                  <p className="text-sm font-semibold text-amber-900">
                    Spend with no budget line
                  </p>
                  <p className="mb-2 text-xs text-amber-800">
                    Real money went out against these headings, but nothing was
                    budgeted for them — this is an over-run, not an under-spend.
                  </p>
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-amber-200/60">
                      {report.unbudgeted.map((u, i) => (
                        <tr key={`${u.departmentId}-${u.category}-${i}`}>
                          <td className="py-1.5 text-amber-900">{u.category}</td>
                          <td className="py-1.5 text-right font-medium text-amber-900">
                            {money(u.actual, currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <ConfirmDialog />
    </div>
  );
}

export default function BudgetVariancePage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <VariancePageInner />
    </ProtectedRoute>
  );
}
