'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, Coins, Loader2 } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { FeaturePending } from '@/components/payroll/FeatureGate';
import { usePermission } from '@/hooks/usePermission';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  leaveEncashmentService,
  type EncashmentRequest,
} from '@/services/payrollExtensionsService';
import employeeService from '@/services/employeeService';
import branchService from '@/services/branchService';
import { formatCurrency } from '@/utils/formatters';
import { apiErrorMessage } from '@/utils/apiError';
import { toast } from '@/lib/toast';

type Tab = 'requests' | 'policies' | 'carryForward';

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-blue-100 text-blue-700',
  PAID: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-slate-100 text-slate-500',
  CANCELLED: 'bg-slate-100 text-slate-400 line-through',
};

/**
 * Turning unused leave into money, and deciding what survives a year end.
 *
 * Two features on one screen because they answer the same question — what
 * happens to leave somebody did not take — and splitting them would mean two
 * places to look when the answer is wrong.
 */
function EncashmentContent() {
  const features = usePayrollFeatures();
  const { isAdmin } = usePermission();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Leave encashment',
    'Unused leave paid as money, and what carries into next year.',
  );

  const [tab, setTab] = useState<Tab>('requests');

  const [employees, setEmployees] = useState<any[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [rows, setRows] = useState<EncashmentRequest[]>([]);
  const [policies, setPolicies] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  // Quote-before-commit: the number is answerable before anybody submits, so
  // the form shows it rather than refusing afterwards.
  const [form, setForm] = useState({ leaveTypeKey: 'Annual Leave', year: new Date().getUTCFullYear(), days: '' });
  const [quote, setQuote] = useState<any>(null);

  const [policyForm, setPolicyForm] = useState({
    leaveTypeKey: 'Annual Leave',
    encashable: true,
    maxEncashDaysPerYear: '',
    carryForwardEnabled: false,
    carryForwardMaxDays: '',
  });
  const [carry, setCarry] = useState({ branchId: '', fromYear: new Date().getUTCFullYear() - 1 });

  useEffect(() => {
    if (!features.encashment) return;
    employeeService
      .getAll({ limit: 500 } as never)
      .then((r: any) => setEmployees(r?.data?.data ?? r?.data ?? []))
      .catch(() => setEmployees([]));
    branchService
      .getAll()
      .then((r: any) => {
        const list = r?.data ?? [];
        setBranches(list);
        if (list[0]?.id) setCarry((c) => ({ ...c, branchId: list[0].id }));
      })
      .catch(() => setBranches([]));
    void loadPolicies();
    void loadRuns();
  }, [features.encashment]);

  const loadPolicies = async () => {
    try {
      const r = await leaveEncashmentService.policies();
      setPolicies(r.data ?? []);
    } catch { setPolicies([]); }
  };
  const loadRuns = async () => {
    try {
      const r = await leaveEncashmentService.carryForwardRuns();
      setRuns(r.data ?? []);
    } catch { setRuns([]); }
  };
  const loadRequests = async (id: string) => {
    if (!id) return setRows([]);
    try {
      const r = await leaveEncashmentService.forEmployee(id);
      setRows(r.data ?? []);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load requests'));
    }
  };

  const getQuote = async () => {
    if (!employeeId) return;
    try {
      const r = await leaveEncashmentService.quote(employeeId, {
        leaveTypeKey: form.leaveTypeKey,
        year: Number(form.year),
        days: form.days ? Number(form.days) : undefined,
      });
      setQuote(r.data);
    } catch (err) {
      setQuote({ refusal: apiErrorMessage(err, 'Could not price this') });
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      await leaveEncashmentService.request({
        employeeId,
        leaveTypeKey: form.leaveTypeKey,
        year: Number(form.year),
        days: Number(form.days),
      });
      setForm((f) => ({ ...f, days: '' }));
      setQuote(null);
      await loadRequests(employeeId);
      toast.success('Requested');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not request encashment'));
    } finally { setBusy(false); }
  };

  const act = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try { await fn(); await loadRequests(employeeId); }
    catch (err) { toast.error(apiErrorMessage(err, failure)); }
    finally { setBusy(false); }
  };

  // A flag that has not been READ yet is not a flag that is off. Every switch in
  // `brandingStore` initialises to false, so without this the screen states
  // "switched off" as a fact over a feature the admin has just turned on.
  if (!features.loaded) return <FeaturePending />;

  if (!features.encashment) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <Coins size={28} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-base font-semibold text-slate-800">Leave encashment is switched off</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          No encashment is computed, in service or on exit. Turn it on under
          Settings → Payroll → Payroll extensions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1">
        {([['requests','Requests'],['policies','Per leave type'],['carryForward','Year end']] as const).map(([id,label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} data-testid={`encash-tab-${id}`}
            className={`rounded-lg px-3 py-2 text-sm font-medium ${tab===id?'bg-brand-primary text-white':'text-slate-600 hover:bg-slate-50'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'requests' && (
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs font-medium text-slate-600">
                Employee
                <select value={employeeId} data-testid="encash-employee"
                  onChange={(e) => { setEmployeeId(e.target.value); setQuote(null); void loadRequests(e.target.value); }}
                  className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="">Choose…</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                Leave type
                <input value={form.leaveTypeKey} onChange={(e) => setForm((f) => ({ ...f, leaveTypeKey: e.target.value }))}
                  className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Year
                <input type="number" value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: Number(e.target.value) }))}
                  className="mt-1 block w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Days
                <input type="number" value={form.days} data-testid="encash-days"
                  onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))}
                  className="mt-1 block w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
              <button type="button" onClick={getQuote} disabled={!employeeId} data-testid="encash-quote"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">
                What can they encash?
              </button>
              <button type="button" onClick={submit} disabled={busy || !employeeId || !form.days} data-testid="encash-submit"
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {busy && <Loader2 size={14} className="animate-spin" />}
                Request
              </button>
            </div>

            {quote && (
              <div className={`mt-4 rounded-lg p-3 text-sm ${quote.refusal ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-700'}`}
                data-testid="encash-quote-result">
                {quote.refusal ? quote.refusal : (
                  <>
                    <p className="font-medium">
                      {quote.amount !== undefined
                        ? `${quote.days} day(s) = ${formatCurrency(quote.amount)}`
                        : `Up to ${quote.maxDays} day(s) can be encashed.`}
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {(quote.reasons ?? quote.workingLines ?? []).map((r: string, i: number) => <li key={i}>· {r}</li>)}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {rows.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {employeeId ? 'No requests for this employee.' : 'Choose an employee.'}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-3">Type</th><th className="px-4 py-3">Year</th>
                    <th className="px-4 py-3 text-right">Days</th><th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">Status</th><th className="px-4 py-3" /></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id} data-testid="encash-row">
                      <td className="px-4 py-2 text-slate-700">{r.leaveTypeKey}</td>
                      <td className="px-4 py-2 text-slate-600">{r.year}</td>
                      <td className="px-4 py-2 text-right">{Number(r.days)}</td>
                      <td className="px-4 py-2 text-right">{r.amount ? formatCurrency(Number(r.amount)) : '—'}</td>
                      <td className="px-4 py-2">
                        <span className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLE[r.status] ?? ''}`}>{r.status}</span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {r.status === 'PENDING' && (
                          <button type="button" disabled={busy} data-testid="encash-approve"
                            onClick={() => act(() => leaveEncashmentService.approve(r.id), 'Could not approve')}
                            className="rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60">
                            Approve
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === 'policies' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-slate-800">Set a leave type&rsquo;s rules</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Leave the branch empty for the company-wide default; a branch rule
              overrides it.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="text-xs font-medium text-slate-600">
                Leave type
                <input value={policyForm.leaveTypeKey} data-testid="policy-type"
                  onChange={(e) => setPolicyForm((p) => ({ ...p, leaveTypeKey: e.target.value }))}
                  className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <input type="checkbox" checked={policyForm.encashable} data-testid="policy-encashable"
                  onChange={(e) => setPolicyForm((p) => ({ ...p, encashable: e.target.checked }))} />
                Encashable
              </label>
              <label className="text-xs font-medium text-slate-600">
                Max days a year
                <input type="number" value={policyForm.maxEncashDaysPerYear}
                  onChange={(e) => setPolicyForm((p) => ({ ...p, maxEncashDaysPerYear: e.target.value }))}
                  placeholder="no cap"
                  className="mt-1 block w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <input type="checkbox" checked={policyForm.carryForwardEnabled}
                  onChange={(e) => setPolicyForm((p) => ({ ...p, carryForwardEnabled: e.target.checked }))} />
                Carries forward
              </label>
              <label className="text-xs font-medium text-slate-600">
                Carry cap
                <input type="number" value={policyForm.carryForwardMaxDays}
                  onChange={(e) => setPolicyForm((p) => ({ ...p, carryForwardMaxDays: e.target.value }))}
                  placeholder="no cap"
                  className="mt-1 block w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
              <button type="button" data-testid="policy-save" disabled={busy || !isAdmin()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await leaveEncashmentService.setPolicy({
                      leaveTypeKey: policyForm.leaveTypeKey,
                      encashable: policyForm.encashable,
                      maxEncashDaysPerYear: policyForm.maxEncashDaysPerYear ? Number(policyForm.maxEncashDaysPerYear) : null,
                      carryForwardEnabled: policyForm.carryForwardEnabled,
                      carryForwardMaxDays: policyForm.carryForwardMaxDays ? Number(policyForm.carryForwardMaxDays) : null,
                    });
                    await loadPolicies();
                    toast.success('Saved');
                  } catch (err) { toast.error(apiErrorMessage(err, 'Could not save')); }
                  finally { setBusy(false); }
                }}
                className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Save
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              A cap of zero is not &ldquo;no cap&rdquo; — leave it blank for that,
              or the server refuses it.
            </p>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {policies.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">No leave type has rules yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-3">Type</th><th className="px-4 py-3">Scope</th>
                    <th className="px-4 py-3">Encashable</th><th className="px-4 py-3">Carries</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {policies.map((p) => (
                    <tr key={p.id} data-testid="policy-row">
                      <td className="px-4 py-2 text-slate-700">{p.leaveTypeKey}</td>
                      <td className="px-4 py-2 text-slate-600">{p.branchId ? 'This branch' : 'Company-wide'}</td>
                      <td className="px-4 py-2">{p.encashable ? `Yes${p.maxEncashDaysPerYear ? ` (max ${p.maxEncashDaysPerYear})` : ''}` : 'No'}</td>
                      <td className="px-4 py-2">{p.carryForwardEnabled ? `Yes${p.carryForwardMaxDays !== null ? ` (max ${p.carryForwardMaxDays})` : ''}` : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'carryForward' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <CalendarClock size={15} /> Move unused balance into next year
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              One branch and one year at a time — there is deliberately no
              all-branch sweep. Running it twice for the same years is refused
              rather than doubling every carried balance.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="text-xs font-medium text-slate-600">
                Branch
                <select value={carry.branchId} data-testid="carry-branch"
                  onChange={(e) => setCarry((c) => ({ ...c, branchId: e.target.value }))}
                  className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                From year
                <input type="number" value={carry.fromYear} data-testid="carry-year"
                  onChange={(e) => setCarry((c) => ({ ...c, fromYear: Number(e.target.value) }))}
                  className="mt-1 block w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
              <button type="button" disabled={busy || !isAdmin() || !carry.branchId} data-testid="carry-run"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await leaveEncashmentService.runCarryForward({ branchId: carry.branchId, fromYear: carry.fromYear });
                    await loadRuns();
                    toast.success('Carry-forward applied');
                  } catch (err) { toast.error(apiErrorMessage(err, 'Could not run carry-forward')); }
                  finally { setBusy(false); }
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {busy && <Loader2 size={14} className="animate-spin" />}
                Run {carry.fromYear} → {carry.fromYear + 1}
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {runs.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">No year end has been run.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-3">Years</th><th className="px-4 py-3 text-right">People</th>
                    <th className="px-4 py-3 text-right">Carried</th><th className="px-4 py-3 text-right">Lapsed</th>
                    <th className="px-4 py-3">Status</th><th className="px-4 py-3" /></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runs.map((r) => (
                    <tr key={r.id} data-testid="carry-run-row">
                      <td className="px-4 py-2 text-slate-700">{r.fromYear} → {r.toYear}</td>
                      <td className="px-4 py-2 text-right">{r.employeeCount}</td>
                      <td className="px-4 py-2 text-right">{Number(r.daysCarried)}</td>
                      <td className="px-4 py-2 text-right text-slate-500">{Number(r.daysLapsed)}</td>
                      <td className="px-4 py-2">{r.status}</td>
                      <td className="px-4 py-2 text-right">
                        {r.status === 'APPLIED' && isAdmin() && (
                          <button type="button" disabled={busy} data-testid="carry-reverse"
                            onClick={async () => {
                              setBusy(true);
                              try { await leaveEncashmentService.reverseCarryForward(r.id); await loadRuns(); }
                              catch (err) { toast.error(apiErrorMessage(err, 'Could not reverse')); }
                              finally { setBusy(false); }
                            }}
                            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 disabled:opacity-60">
                            Reverse
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function EncashmentPage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <EncashmentContent />
    </ProtectedRoute>
  );
}
