'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Wallet, Loader2, Plus, X, BarChart3 } from 'lucide-react';
import { toast } from 'sonner';
import PageActionRow from '@/components/common/PageActionRow';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { usePageHeader } from '@/hooks/usePageHeader';
import budgetService from '@/services/budgetService';
import branchService from '@/services/branchService';
import { Budget, BudgetStatus, CreateBudgetData } from '@/types/budget';
import { apiErrorMessage } from '@/utils/apiError';

const STATUS_STYLE: Record<BudgetStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-600',
  ACTIVE: 'bg-emerald-50 text-emerald-700',
  CLOSED: 'bg-blue-50 text-blue-700',
};

const inputCls =
  'w-full h-10 px-3 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30';

function fmtDate(d?: string | null) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(d);
  }
}

function BudgetsPageInner() {
  const [rows, setRows] = useState<Budget[]>([]);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const thisYear = new Date().getFullYear();
  const [form, setForm] = useState<CreateBudgetData>({
    name: `FY${thisYear} Operating Budget`,
    fiscalYear: thisYear,
    startDate: `${thisYear}-01-01`,
    endDate: `${thisYear}-12-31`,
    branchId: '',
  });

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('HR Budgets', 'Planned, committed and actual spend by department and category');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await budgetService.getAll();
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to load budgets'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const res = await branchService.getAll();
        const list = (res.data || []).map((b: any) => ({ id: b.id, name: b.name }));
        setBranches(list);
        if (list.length === 1) setForm((f) => ({ ...f, branchId: list[0].id }));
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  const submit = async () => {
    if (!form.name.trim() || !form.branchId) {
      toast.warning('Name and branch are required');
      return;
    }
    setSaving(true);
    try {
      await budgetService.create(form);
      toast.success('Budget created as DRAFT — activate it to start committing');
      setShowForm(false);
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to create budget'));
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (budget: Budget, status: BudgetStatus) => {
    setBusyId(budget.id);
    try {
      await budgetService.setStatus(budget.id, status);
      toast.success(`Budget ${status.toLowerCase()}`);
      await load();
    } catch (e: any) {
      toast.error(apiErrorMessage(e, 'Failed to change status'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <PageActionRow
        action={
          <button
            data-testid="budget-new"
            onClick={() => setShowForm((s) => !s)}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white"
          >
            <Plus size={16} /> New budget
          </button>
        }
      />

      {showForm && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">New budget</h3>
            <button onClick={() => setShowForm(false)} className="text-slate-400">
              <X size={18} />
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <input
              data-testid="budget-name"
              className={`${inputCls} md:col-span-2`}
              placeholder="Budget name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              data-testid="budget-year"
              type="number"
              className={inputCls}
              placeholder="Fiscal year"
              value={form.fiscalYear}
              onChange={(e) =>
                setForm({ ...form, fiscalYear: Number(e.target.value) })
              }
            />
            <select
              data-testid="budget-branch"
              className={inputCls}
              value={form.branchId}
              onChange={(e) => setForm({ ...form, branchId: e.target.value })}
            >
              <option value="">Branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              Period start (fiscal, not calendar)
              <input
                data-testid="budget-start"
                type="date"
                className={inputCls}
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              Period end
              <input
                data-testid="budget-end"
                type="date"
                className={inputCls}
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              data-testid="budget-submit"
              onClick={submit}
              disabled={saving}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Create
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-slate-500 shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          data-testid="budget-empty"
          className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400 shadow-sm"
        >
          No budgets yet.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((b) => (
            <div
              key={b.id}
              data-testid="budget-row"
              data-budget-id={b.id}
              data-status={b.status}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Wallet size={15} className="text-brand-primary" />
                    <p className="text-sm font-semibold text-slate-800">{b.name}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[b.status]}`}
                    >
                      {b.status}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                      {b.currency}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    FY{b.fiscalYear} · {fmtDate(b.startDate)} → {fmtDate(b.endDate)}
                    {b.branch ? ` · ${b.branch.name}` : ''} · {b._count?.lines ?? 0}{' '}
                    line(s)
                  </p>
                  {b.status === 'DRAFT' && (
                    <p className="mt-1 text-xs text-amber-700">
                      Draft budgets do not receive commitments — activate it once the
                      lines are set.
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Link
                    data-testid="budget-variance-link"
                    href={`/dashboard/budgets/${b.id}`}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <BarChart3 size={14} /> Variance
                  </Link>
                  {b.status === 'DRAFT' && (
                    <button
                      data-testid="budget-activate"
                      onClick={() => setStatus(b, 'ACTIVE')}
                      disabled={busyId === b.id}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Activate
                    </button>
                  )}
                  {b.status === 'ACTIVE' && (
                    <button
                      data-testid="budget-close"
                      onClick={() => setStatus(b, 'CLOSED')}
                      disabled={busyId === b.id}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 disabled:opacity-50"
                    >
                      Close
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BudgetsPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER']}>
      <BudgetsPageInner />
    </ProtectedRoute>
  );
}
