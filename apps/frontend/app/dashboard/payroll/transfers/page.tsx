'use client';

import { useEffect, useState } from 'react';
import { ArrowRightLeft, Loader2, Plus } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { FeaturePending } from '@/components/payroll/FeatureGate';
import PageActionRow from '@/components/common/PageActionRow';
import { usePermission } from '@/hooks/usePermission';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  employeeTransferService,
  type EmployeeTransfer,
} from '@/services/payrollExtensionsService';
import employeeService from '@/services/employeeService';
import branchService from '@/services/branchService';
import { apiErrorMessage } from '@/utils/apiError';
import { toast } from '@/lib/toast';

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-blue-100 text-blue-700',
  APPLIED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-slate-100 text-slate-500',
  CANCELLED: 'bg-slate-100 text-slate-400 line-through',
};

/**
 * Moving somebody between branches.
 *
 * Approving and applying are ADMIN-only, because a transfer crosses the branch
 * isolation axis — the boundary every other guard in this system exists to hold —
 * and applying one changes which branch's payroll pays that person.
 */
function TransfersContent() {
  const { isAdmin } = usePermission();
  const features = usePayrollFeatures();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Branch transfers',
    'A move is requested, approved and then applied as three separate acts.',
  );

  const [rows, setRows] = useState<EmployeeTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [employees, setEmployees] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [form, setForm] = useState({
    employeeId: '',
    toBranchId: '',
    effectiveDate: '',
    reason: '',
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await employeeTransferService.list();
      setRows(res.data ?? []);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load transfers'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!features.transfer) {
      setLoading(false);
      return;
    }
    void load();
    employeeService
      .getAll({ limit: 500 } as never)
      .then((r: any) => setEmployees(r?.data?.data ?? r?.data ?? []))
      .catch(() => setEmployees([]));
    branchService
      .getAll()
      .then((r: any) => setBranches(r?.data ?? []))
      .catch(() => setBranches([]));
  }, [features.transfer]);

  const act = async (id: string, fn: () => Promise<unknown>, failure: string) => {
    setBusy(id);
    try {
      await fn();
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, failure));
    } finally {
      setBusy(null);
    }
  };

  // A flag that has not been READ yet is not a flag that is off. Every switch in
  // `brandingStore` initialises to false, so without this the screen states
  // "switched off" as a fact over a feature the admin has just turned on.
  if (!features.loaded) return <FeaturePending />;

  if (!features.transfer) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <ArrowRightLeft size={28} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-base font-semibold text-slate-800">
          Branch transfers are switched off
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          An employee cannot change branch. Turn it on under Settings → Payroll →
          Payroll extensions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageActionRow
        action={
          <button
            type="button"
            onClick={() => setCreating(true)}
            data-testid="transfer-new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white"
          >
            <Plus size={15} /> Request a move
          </button>
        }
      />

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No transfers requested.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Effective</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((t) => (
                <tr key={t.id} data-testid="transfer-row">
                  <td className="px-4 py-2">
                    <div className="text-slate-800">{t.employee?.fullName ?? t.employeeId}</div>
                    <div className="text-xs text-slate-400">{t.employee?.employeeCode}</div>
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {String(t.effectiveDate).slice(0, 10)}
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 text-slate-600">{t.reason}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLE[t.status] ?? ''}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {isAdmin() && t.status === 'PENDING' && (
                      <button
                        type="button"
                        disabled={busy === t.id}
                        onClick={() => act(t.id, () => employeeTransferService.approve(t.id), 'Could not approve')}
                        data-testid="transfer-approve"
                        className="rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                      >
                        Approve
                      </button>
                    )}
                    {isAdmin() && t.status === 'APPROVED' && (
                      <button
                        type="button"
                        disabled={busy === t.id}
                        onClick={() => act(t.id, () => employeeTransferService.apply(t.id), 'Could not apply')}
                        data-testid="transfer-apply"
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                      >
                        {busy === t.id && <Loader2 size={12} className="animate-spin" />}
                        Apply the move
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-800">Request a move</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              A reason is required. A transfer crosses the branch isolation axis,
              so it is recorded as a decision somebody made — not a field edit.
            </p>
            <div className="mt-4 space-y-3">
              <label className="block text-xs font-medium text-slate-600">
                Employee
                <select
                  value={form.employeeId}
                  data-testid="transfer-employee"
                  onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">Choose…</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-slate-600">
                  Moving to
                  <select
                    value={form.toBranchId}
                    data-testid="transfer-branch"
                    onChange={(e) => setForm((f) => ({ ...f, toBranchId: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">Choose…</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </label>
                <label className="block text-xs font-medium text-slate-600">
                  Effective
                  <input
                    type="date"
                    value={form.effectiveDate}
                    data-testid="transfer-date"
                    onChange={(e) => setForm((f) => ({ ...f, effectiveDate: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="block text-xs font-medium text-slate-600">
                Why
                <textarea
                  value={form.reason}
                  rows={3}
                  data-testid="transfer-reason"
                  onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                  placeholder="Opening the new site."
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-4 py-2 text-sm text-slate-600">
                Cancel
              </button>
              <button
                type="button"
                data-testid="transfer-submit"
                disabled={
                  busy === 'new' || !form.employeeId || !form.toBranchId ||
                  !form.effectiveDate || !form.reason.trim()
                }
                onClick={async () => {
                  setBusy('new');
                  try {
                    await employeeTransferService.request({ ...form, reason: form.reason.trim() });
                    setCreating(false);
                    setForm({ employeeId: '', toBranchId: '', effectiveDate: '', reason: '' });
                    await load();
                  } catch (err) {
                    toast.error(apiErrorMessage(err, 'Could not request the transfer'));
                  } finally {
                    setBusy(null);
                  }
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy === 'new' && <Loader2 size={14} className="animate-spin" />}
                Request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TransfersPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <TransfersContent />
    </ProtectedRoute>
  );
}
