'use client';

import { useEffect, useState } from 'react';
import { HandCoins, Loader2 } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { FeaturePending } from '@/components/payroll/FeatureGate';
import { usePermission } from '@/hooks/usePermission';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  employeeRecoveryService,
  type EmployeeRecovery,
} from '@/services/payrollExtensionsService';
import employeeService from '@/services/employeeService';
import { formatCurrency } from '@/utils/formatters';
import { apiErrorMessage } from '@/utils/apiError';
import { toast } from '@/lib/toast';

const KINDS = [
  ['ASSET_DAMAGE', 'Asset damage'],
  ['ASSET_LOSS', 'Unreturned asset'],
  ['TRAINING_BOND', 'Training bond'],
  ['NOTICE_SHORTFALL', 'Short notice'],
  ['OTHER', 'Other'],
] as const;

const STATUS_STYLE: Record<string, string> = {
  ACTIVE: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  RECEIVABLE: 'bg-amber-100 text-amber-800',
  WAIVED: 'bg-slate-100 text-slate-500',
  CANCELLED: 'bg-slate-100 text-slate-400 line-through',
};

/**
 * Money the employer is recovering from an employee.
 *
 * Clearance already blocks an exit while an asset is out; this is where the
 * money actually moves. Never recovered below the take-home floor — this is a
 * claim the employer asserted, not one the employee agreed to.
 */
function RecoveriesContent() {
  const features = usePayrollFeatures();
  const { isAdmin } = usePermission();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Recoveries',
    'Asset damage, unreturned equipment, training bonds and short notice.',
  );

  const [employees, setEmployees] = useState<any[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [rows, setRows] = useState<EmployeeRecovery[]>([]);
  const [busy, setBusy] = useState(false);
  const [waiving, setWaiving] = useState<EmployeeRecovery | null>(null);
  const [waiveReason, setWaiveReason] = useState('');
  const [form, setForm] = useState({
    kind: 'ASSET_DAMAGE',
    totalAmount: '',
    instalmentAmount: '',
    reference: '',
  });

  useEffect(() => {
    if (!features.recovery) return;
    employeeService
      .getAll({ limit: 500 } as never)
      .then((r: any) => setEmployees(r?.data?.data ?? r?.data ?? []))
      .catch(() => setEmployees([]));
  }, [features.recovery]);

  const load = async (id: string) => {
    if (!id) {
      setRows([]);
      return;
    }
    try {
      const r = await employeeRecoveryService.forEmployee(id);
      setRows(r.data ?? []);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load recoveries'));
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      await employeeRecoveryService.create({
        employeeId,
        kind: form.kind,
        totalAmount: Number(form.totalAmount),
        instalmentAmount: form.instalmentAmount ? Number(form.instalmentAmount) : undefined,
        reference: form.reference || undefined,
      });
      setForm((f) => ({ ...f, totalAmount: '', instalmentAmount: '', reference: '' }));
      await load(employeeId);
      toast.success('Recovery raised');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not raise the recovery'));
    } finally {
      setBusy(false);
    }
  };

  // A flag that has not been READ yet is not a flag that is off. Every switch in
  // `brandingStore` initialises to false, so without this the screen states
  // "switched off" as a fact over a feature the admin has just turned on.
  if (!features.loaded) return <FeaturePending />;

  if (!features.recovery) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <HandCoins size={28} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-base font-semibold text-slate-800">Recoveries are switched off</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          Recovering money stays a manual salary component, unlinked to the
          asset. Turn it on under Settings → Payroll → Payroll extensions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-600">
            Employee
            <select
              value={employeeId}
              data-testid="recovery-employee"
              onChange={(e) => {
                setEmployeeId(e.target.value);
                void load(e.target.value);
              }}
              className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Choose…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            What for
            <select
              value={form.kind}
              data-testid="recovery-kind"
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Total
            <input
              type="number"
              value={form.totalAmount}
              data-testid="recovery-total"
              onChange={(e) => setForm((f) => ({ ...f, totalAmount: e.target.value }))}
              className="mt-1 block w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Per payslip
            <input
              type="number"
              value={form.instalmentAmount}
              placeholder="all available"
              onChange={(e) => setForm((f) => ({ ...f, instalmentAmount: e.target.value }))}
              className="mt-1 block w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Reference
            <input
              value={form.reference}
              onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
              className="mt-1 block w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={submit}
            data-testid="recovery-create"
            disabled={busy || !employeeId || !form.totalAmount}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Raise
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Leave &ldquo;per payslip&rdquo; blank to take whatever the pay can bear
          each month; the balance carries forward when it cannot.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {employeeId ? 'Nothing being recovered from this employee.' : 'Choose an employee.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">What for</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Recovered</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const total = Number(r.totalAmount);
                const got = Number(r.amountRecovered);
                return (
                  <tr key={r.id} data-testid="recovery-row">
                    <td className="px-4 py-2 text-slate-700">
                      {KINDS.find(([v]) => v === r.kind)?.[1] ?? r.kind}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{r.reference ?? '—'}</td>
                    <td className="px-4 py-2 text-right">{formatCurrency(total)}</td>
                    <td className="px-4 py-2 text-right">
                      {formatCurrency(got)}
                      <span className="ml-1 text-xs text-slate-400">
                        ({total > 0 ? Math.round((got / total) * 100) : 0}%)
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLE[r.status] ?? ''}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {r.status === 'ACTIVE' && isAdmin() && (
                        <button
                          type="button"
                          data-testid="recovery-waive"
                          onClick={() => { setWaiving(r); setWaiveReason(''); }}
                          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600"
                        >
                          Forgive
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {waiving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-800">Forgive this balance</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              This is the only thing that erases a balance, so the reason is
              required and is kept on the record.
            </p>
            <textarea
              value={waiveReason}
              onChange={(e) => setWaiveReason(e.target.value)}
              rows={3}
              data-testid="recovery-waive-reason"
              placeholder="Damage was pre-existing."
              className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setWaiving(null)} className="rounded-lg px-4 py-2 text-sm text-slate-600">
                Keep it
              </button>
              <button
                type="button"
                disabled={busy || !waiveReason.trim()}
                data-testid="recovery-waive-confirm"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await employeeRecoveryService.waive(waiving.id, waiveReason.trim());
                    setWaiving(null);
                    await load(employeeId);
                  } catch (err) {
                    toast.error(apiErrorMessage(err, 'Could not forgive'));
                  } finally {
                    setBusy(false);
                  }
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Forgive
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RecoveriesPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <RecoveriesContent />
    </ProtectedRoute>
  );
}
