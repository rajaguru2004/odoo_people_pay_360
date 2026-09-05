'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Loader2, Plus } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { FeaturePending } from '@/components/payroll/FeatureGate';
import PageActionRow from '@/components/common/PageActionRow';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  finalSettlementService,
  type FinalSettlement,
} from '@/services/payrollExtensionsService';
import employeeService from '@/services/employeeService';
import { formatCurrency } from '@/utils/formatters';
import { apiErrorMessage } from '@/utils/apiError';
import { toast } from '@/lib/toast';

const VARIANTS = ['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'DEATH', 'CONTRACT_END'];

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  PAID: 'bg-emerald-100 text-emerald-700',
  CANCELLED: 'bg-slate-100 text-slate-400 line-through',
};

function SettlementsPageContent() {
  const router = useRouter();
  const features = usePayrollFeatures();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Final settlements', 'What a leaver is owed, and the working behind every figure.');

  const [rows, setRows] = useState<FinalSettlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [employees, setEmployees] = useState<any[]>([]);
  const [form, setForm] = useState({
    employeeId: '',
    variant: 'RESIGNATION',
    lastWorkingDate: '',
    pendingSalary: '',
    noticePay: '',
  });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await finalSettlementService.list();
      setRows(res.data ?? []);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load settlements'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (features.eosb) void load();
    else setLoading(false);
  }, [features.eosb]);

  const openCreate = async () => {
    setCreating(true);
    try {
      const res = await employeeService.getAll({ limit: 500 } as never);
      setEmployees((res as any)?.data?.data ?? (res as any)?.data ?? []);
    } catch {
      setEmployees([]);
    }
  };

  const submit = async () => {
    if (!form.employeeId || !form.lastWorkingDate) {
      toast.error('An employee and a last working date are required.');
      return;
    }
    setBusy(true);
    try {
      const res = await finalSettlementService.create({
        employeeId: form.employeeId,
        variant: form.variant,
        lastWorkingDate: form.lastWorkingDate,
        pendingSalary: Number(form.pendingSalary) || 0,
        noticePay: Number(form.noticePay) || 0,
      });
      setCreating(false);
      router.push(`/dashboard/payroll/settlements/${res.data.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not prepare the settlement'));
    } finally {
      setBusy(false);
    }
  };

  // BOTH switches, because the server needs both: `FinalSettlementsService`
  // refuses every route unless `payroll_eosb_enabled` AND
  // `payroll_eosb_settlement_enabled` are on. Gated on the master alone, this
  // screen rendered its list, its "Prepare a settlement" form and its approve
  // buttons over an API answering 404 to all of them — the admin turns EOSB on,
  // the screen looks finished, and nothing works.
  // A flag that has not been READ yet is not a flag that is off. Every switch in
  // `brandingStore` initialises to false, so without this the screen states
  // "switched off" as a fact over a feature the admin has just turned on.
  if (!features.loaded) return <FeaturePending />;

  if (!features.eosbSettlement) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <FileText size={28} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-base font-semibold text-slate-800">
          {features.eosb
            ? 'Final settlements are switched off'
            : 'End-of-service benefits are switched off'}
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          {features.eosb ? (
            <>
              End-of-service benefits are on, but preparing settlement documents
              is its own switch. Turn on <strong>Final settlements</strong> under
              Settings → Payroll → Payroll extensions.
            </>
          ) : (
            <>
              Turn them on under Settings → Payroll → Payroll extensions. Until
              then an exit works exactly as it does today, and no settlement can
              be prepared.
            </>
          )}
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
            onClick={openCreate}
            data-testid="settlement-new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white"
          >
            <Plus size={15} />
            Prepare
          </button>
        }
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No settlements yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Last day</th>
                <th className="px-4 py-3 text-right">Net</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((s) => {
                const net = Number(s.netPayable);
                return (
                  <tr
                    key={s.id}
                    data-testid="settlement-row"
                    onClick={() => router.push(`/dashboard/payroll/settlements/${s.id}`)}
                    className="cursor-pointer hover:bg-slate-50"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">
                        {s.employee?.fullName ?? s.employeeId}
                      </div>
                      <div className="text-xs text-slate-400">{s.employee?.employeeCode}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{s.variant}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {String(s.lastWorkingDate).slice(0, 10)}
                    </td>
                    <td className={`px-4 py-3 text-right font-medium ${net < 0 ? 'text-red-600' : 'text-slate-800'}`}>
                      {formatCurrency(net)}
                      {net < 0 && (
                        // A leaver can genuinely owe money, and the list has to
                        // say so rather than showing a plausible positive.
                        <span className="ml-1 text-[11px] font-normal">receivable</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLE[s.status] ?? ''}`}>
                        {s.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-800">Prepare a settlement</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Gratuity, unused leave and outstanding balances are computed for you.
              Everything is adjustable afterwards, with a reason.
            </p>

            <div className="mt-4 space-y-3">
              <label className="block text-xs font-medium text-slate-600">
                Employee
                <select
                  value={form.employeeId}
                  onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
                  data-testid="settlement-employee"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">Choose…</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.fullName} ({e.employeeCode})
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-slate-600">
                  Reason for leaving
                  <select
                    value={form.variant}
                    onChange={(e) => setForm((f) => ({ ...f, variant: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {VARIANTS.map((v) => (
                      <option key={v} value={v}>{v.replace('_', ' ')}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs font-medium text-slate-600">
                  Last working day
                  <input
                    type="date"
                    value={form.lastWorkingDate}
                    onChange={(e) => setForm((f) => ({ ...f, lastWorkingDate: e.target.value }))}
                    data-testid="settlement-last-day"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-medium text-slate-600">
                  Pending salary
                  <input
                    type="number"
                    value={form.pendingSalary}
                    onChange={(e) => setForm((f) => ({ ...f, pendingSalary: e.target.value }))}
                    placeholder="0"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs font-medium text-slate-600">
                  Pay in lieu of notice
                  <input
                    type="number"
                    value={form.noticePay}
                    onChange={(e) => setForm((f) => ({ ...f, noticePay: e.target.value }))}
                    placeholder="0"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-lg px-4 py-2 text-sm text-slate-600"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                data-testid="settlement-create"
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                Prepare
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettlementsPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <SettlementsPageContent />
    </ProtectedRoute>
  );
}
