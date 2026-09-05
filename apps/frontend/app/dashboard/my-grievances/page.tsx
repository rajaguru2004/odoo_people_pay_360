'use client';

import { useCallback, useEffect, useState } from 'react';
import { MessageSquareWarning, Loader2, Plus, X, Lock, Ban } from 'lucide-react';
import { toast } from 'sonner';
import PageActionRow from '@/components/common/PageActionRow';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import grievanceService from '@/services/grievanceService';
import libraryService from '@/services/libraryService';
import MasterEmptyHint from '@/components/common/MasterEmptyHint';
import employeeService from '@/services/employeeService';
import { CreateGrievanceData, Grievance, GrievanceStatus } from '@/types/grievance';

const STATUS_STYLE: Record<GrievanceStatus, string> = {
  OPEN: 'bg-status-warning-bg/40 text-status-warning',
  ACKNOWLEDGED: 'bg-status-info-bg/40 text-status-info',
  INVESTIGATING: 'bg-brand-primary-light/20 text-brand-primary',
  RESOLVED: 'bg-status-success-bg/40 text-status-success',
  CLOSED: 'bg-surface-page text-text-muted',
  WITHDRAWN: 'bg-surface-page text-text-muted',
};

const inputCls =
  'w-full h-12 md:h-10 px-3 border border-surface-border rounded-lg text-base md:text-sm bg-surface-card focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/30';

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

/** ESS: raise and track a grievance. */
export default function MyGrievancesPage() {
  const [rows, setRows] = useState<Grievance[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [employees, setEmployees] = useState<
    { id: string; fullName: string; employeeCode: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateGrievanceData>({
    category: '',
    subject: '',
    description: '',
  });
  const { confirm, ConfirmDialog } = useConfirm();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('My Grievances', 'Raise a concern and follow how it is handled');

  const load = useCallback(async () => {
    try {
      const res = await grievanceService.getAll();
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to load your grievances');
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
        const [cats, emps] = await Promise.all([
          libraryService.getAll('GRIEVANCE_CATEGORY', true),
          employeeService.getDirectory(),
        ]);
        setCategories((cats.data || []).map((c: any) => c.label));
        setEmployees(
          (emps.data || []).map((e: any) => ({
            id: e.id,
            fullName: e.fullName,
            employeeCode: e.employeeCode,
          })),
        );
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  const submit = async () => {
    if (!form.category || !form.subject.trim() || !form.description.trim()) {
      toast.warning('Category, subject and description are required');
      return;
    }
    setSaving(true);
    try {
      await grievanceService.create(form);
      toast.success('Grievance raised. HR will pick it up.');
      setShowForm(false);
      setForm({ category: '', subject: '', description: '' });
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to raise the grievance');
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async (row: Grievance) => {
    const ok = await confirm({
      title: 'Withdraw grievance',
      message: 'This closes the case. You can raise a new one later if you need to.',
      type: 'warning',
      confirmText: 'Withdraw',
    });
    if (!ok) return;
    try {
      await grievanceService.withdraw(row.id);
      toast.success('Withdrawn');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to withdraw');
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6" data-testid="ess-my-grievances">
      <PageActionRow
        action={
          <button
            onClick={() => setShowForm((s) => !s)}
            className="inline-flex h-12 md:h-10 w-full md:w-auto justify-center items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-text-on-brand touch-manipulation"
          >
            <Plus size={16} /> Raise a grievance
          </button>
        }
      />

      {showForm && (
        <div className="rounded-2xl border border-surface-border bg-surface-card p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-heading">New grievance</h3>
            <button onClick={() => setShowForm(false)} className="text-text-muted">
              <X size={18} />
            </button>
          </div>
          {categories.length === 0 && (
            <MasterEmptyHint what="grievance categories" className="mb-3" />
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <select
              className={inputCls}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              <option value="">Category…</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              className={inputCls}
              value={form.againstEmployeeId ?? ''}
              onChange={(e) =>
                setForm({ ...form, againstEmployeeId: e.target.value || undefined })
              }
            >
              <option value="">This is not about a specific person</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName} ({e.employeeCode})
                </option>
              ))}
            </select>
            <input
              className={`${inputCls} md:col-span-2`}
              placeholder="Subject"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
            <textarea
              className="md:col-span-2 rounded-lg border border-surface-border px-3 py-2.5 text-base md:text-sm focus:border-brand-primary focus:outline-none"
              rows={5}
              placeholder="What happened?"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <label className="flex items-center gap-2 text-sm text-text-body md:col-span-2">
              <input
                type="checkbox"
                checked={form.isConfidential ?? false}
                onChange={(e) =>
                  setForm({ ...form, isConfidential: e.target.checked })
                }
              />
              Handle confidentially
            </label>
          </div>
          <p className="mt-2 text-xs text-text-muted">
            If you name a person, they will never be able to see this grievance —
            whatever their role.
          </p>
          <div className="mt-4 flex justify-end">
            <button
              onClick={submit}
              disabled={saving}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand-primary px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Submit
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-surface-border bg-surface-card p-8 text-text-muted shadow-sm">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-surface-border bg-surface-card p-10 text-center text-text-muted shadow-sm">
          Nothing raised.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <div
              key={row.id}
              className="rounded-2xl border border-surface-border bg-surface-card p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <MessageSquareWarning size={15} className="text-brand-primary" />
                    <p className="text-sm font-semibold text-text-heading">
                      {row.subject}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[row.status]}`}
                    >
                      {row.status}
                    </span>
                    {row.isConfidential && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-page px-2 py-0.5 text-[11px] text-text-muted">
                        <Lock size={10} /> Confidential
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {row.category} · raised {fmtDate(row.createdAt)}
                  </p>
                  <p className="mt-2 text-sm text-text-body">{row.description}</p>
                  {row.resolution && (
                    <p className="mt-2 rounded-lg bg-status-success-bg/40 px-3 py-2 text-sm text-status-success">
                      <span className="font-semibold">Resolution:</span>{' '}
                      {row.resolution}
                    </p>
                  )}
                </div>

                {['OPEN', 'ACKNOWLEDGED'].includes(row.status) && (
                  <button
                    onClick={() => withdraw(row)}
                    className="inline-flex h-11 md:h-9 items-center gap-1.5 rounded-lg border border-surface-border px-3 text-base md:text-sm font-medium text-text-muted hover:bg-surface-page"
                  >
                    <Ban size={14} /> Withdraw
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog />
    </div>
  );
}
