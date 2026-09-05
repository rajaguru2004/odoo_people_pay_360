'use client';

import { useEffect, useState } from 'react';
import { Loader2, Scale } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { FeaturePending } from '@/components/payroll/FeatureGate';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import { gratuityService, type GratuityRule } from '@/services/payrollExtensionsService';
import { apiErrorMessage } from '@/utils/apiError';
import { toast } from '@/lib/toast';

const CLASSES = ['EXPAT', 'NATIONAL', 'GCC', 'ANY'];

/**
 * The bands an end-of-service entitlement is built from.
 *
 * A table rather than a single rate because the rate is not one number: Oman's
 * law changed in 2023, the previous law used a lower rate for the first three
 * years, and a state fund may carry a national's benefit instead of the
 * employer. All three are rows here; none is expressible as a percentage.
 */
function GratuityRulesContent() {
  const features = usePayrollFeatures();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'End-of-service rules',
    'One row per band — entitlement is worked out band by band.',
  );

  const [rows, setRows] = useState<GratuityRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    country: 'OM',
    nationalityClass: 'EXPAT',
    fromYears: '0',
    toYears: '',
    daysPerYear: '30',
    basis: 'BASIC',
    monthDays: '30',
    employerShare: '1',
    effectiveFrom: '2023-07-26',
  });

  const load = async () => {
    setLoading(true);
    try {
      const r = await gratuityService.rules();
      setRows(r.data ?? []);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not load rules'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (features.eosb) void load();
    else setLoading(false);
  }, [features.eosb]);

  const submit = async () => {
    setBusy(true);
    try {
      await gratuityService.createRule({
        country: form.country,
        nationalityClass: form.nationalityClass,
        fromYears: Number(form.fromYears),
        toYears: form.toYears ? Number(form.toYears) : null,
        daysPerYear: Number(form.daysPerYear),
        basis: form.basis,
        monthDays: Number(form.monthDays),
        employerShare: Number(form.employerShare),
        effectiveFrom: form.effectiveFrom,
      });
      await load();
      toast.success('Rule added');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not add the rule'));
    } finally {
      setBusy(false);
    }
  };

  // A flag that has not been READ yet is not a flag that is off. Every switch in
  // `brandingStore` initialises to false, so without this the screen states
  // "switched off" as a fact over a feature the admin has just turned on.
  if (!features.loaded) return <FeaturePending />;

  if (!features.eosb) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <Scale size={28} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-base font-semibold text-slate-800">
          End-of-service benefits are switched off
        </h2>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="text-xs font-medium text-slate-600">
            Country
            <input value={form.country} data-testid="rule-country"
              onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Applies to
            <select value={form.nationalityClass} data-testid="rule-class"
              onChange={(e) => setForm((f) => ({ ...f, nationalityClass: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              {CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            From year
            <input type="number" step="0.01" value={form.fromYears}
              onChange={(e) => setForm((f) => ({ ...f, fromYears: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            To year
            <input type="number" step="0.01" value={form.toYears} placeholder="open-ended"
              onChange={(e) => setForm((f) => ({ ...f, toYears: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Days per year
            <input type="number" step="0.01" value={form.daysPerYear} data-testid="rule-days"
              onChange={(e) => setForm((f) => ({ ...f, daysPerYear: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Priced from
            <select value={form.basis}
              onChange={(e) => setForm((f) => ({ ...f, basis: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <option value="BASIC">Basic</option>
              <option value="GROSS">Gross</option>
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Days in a month
            <input type="number" step="0.0001" value={form.monthDays}
              onChange={(e) => setForm((f) => ({ ...f, monthDays: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Employer share
            <input type="number" step="0.01" min="0" max="1" value={form.employerShare}
              onChange={(e) => setForm((f) => ({ ...f, employerShare: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            In force from
            <input type="date" value={form.effectiveFrom}
              onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <div className="flex items-end sm:col-span-2">
            <button type="button" onClick={submit} disabled={busy} data-testid="rule-create"
              className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
              {busy && <Loader2 size={14} className="animate-spin" />}
              Add band
            </button>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Employer share of 0 is how a state fund carrying the benefit is
          expressed — the employee&rsquo;s entitlement is unchanged, the employer
          provisions nothing. A band overlapping an existing one is refused,
          because two would make the entitlement depend on row order.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">No rules configured.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Country</th><th className="px-4 py-3">Applies to</th>
                <th className="px-4 py-3">Band</th><th className="px-4 py-3 text-right">Days/yr</th>
                <th className="px-4 py-3">Basis</th><th className="px-4 py-3 text-right">Employer</th>
                <th className="px-4 py-3">From</th><th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} data-testid="rule-row" className={r.isActive ? '' : 'opacity-50'}>
                  <td className="px-4 py-2 font-mono text-slate-700">{r.country}</td>
                  <td className="px-4 py-2 text-slate-600">{r.nationalityClass}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {Number(r.fromYears)} → {r.toYears === null ? '∞' : Number(r.toYears)}
                  </td>
                  <td className="px-4 py-2 text-right">{Number(r.daysPerYear)}</td>
                  <td className="px-4 py-2 text-slate-600">{r.basis}</td>
                  <td className="px-4 py-2 text-right">
                    {Number(r.employerShare) === 0 ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                        state fund
                      </span>
                    ) : `${Math.round(Number(r.employerShare) * 100)}%`}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{String(r.effectiveFrom).slice(0, 10)}</td>
                  <td className="px-4 py-2 text-right">
                    {r.isActive && (
                      <button type="button" data-testid="rule-retire"
                        onClick={async () => {
                          try { await gratuityService.retireRule(r.id); await load(); }
                          catch (err) { toast.error(apiErrorMessage(err, 'Could not retire')); }
                        }}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600">
                        Retire
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          A rule is retired, never deleted: accruals reference the rule they were
          computed under, and one whose rule has vanished cannot be explained.
        </p>
      </div>
    </div>
  );
}

export default function GratuityRulesPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN']}>
      <GratuityRulesContent />
    </ProtectedRoute>
  );
}
