'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { FeaturePending } from '@/components/payroll/FeatureGate';
import { FindingRow } from '@/components/payroll/FindingRow';
import { FindingGroup } from '@/components/payroll/FindingGroup';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
  payrollValidationService,
  type PayrollPreflightResult,
} from '@/services/payrollExtensionsService';
import { apiErrorMessage } from '@/utils/apiError';
import { toast } from '@/lib/toast';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * "Is this run safe to generate?", answered BEFORE the run exists.
 *
 * Every other check in the module answers this once a payroll has been
 * generated and locked — by which point the expensive mistakes have already
 * been made. This runs first, and writes nothing, so it can be run as often as
 * somebody wants reassurance.
 */
function PayrollValidatePageContent() {
  const features = usePayrollFeatures();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Before you generate',
    'Runs every check generation would run, plus the ones it cannot.',
  );

  const now = new Date();

  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [year, setYear] = useState(now.getUTCFullYear());
  const [result, setResult] = useState<PayrollPreflightResult | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await payrollValidationService.preflight({ month, year });
      setResult(res.data);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not run the checklist'));
    } finally {
      setLoading(false);
    }
  };

  // A flag that has not been READ yet is not a flag that is off. Every switch in
  // `brandingStore` initialises to false, so without this the screen states
  // "switched off" as a fact over a feature the admin has just turned on.
  if (!features.loaded) return <FeaturePending />;

  if (!features.preflight) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <ShieldCheck size={28} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-base font-semibold text-slate-800">
          Pre-run validation is switched off
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          Turn it on under Settings → Payroll → Payroll extensions. With it off,
          a run is still checked by its own guards at the moment it is generated —
          this screen simply lets you look first.
        </p>
      </div>
    );
  }

  const blocked = result?.byEmployee.filter((e) => e.status === 'BLOCKED') ?? [];
  const warned = result?.byEmployee.filter((e) => e.status === 'WARNING') ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-600">
            Month
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              data-testid="preflight-month"
              className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Year
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              data-testid="preflight-year"
              className="mt-1 block w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={run}
            disabled={loading}
            data-testid="preflight-run"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {loading && <Loader2 size={15} className="animate-spin" />}
            Check
          </button>
        </div>
      </div>

      {result && (
        <>
          <div
            data-testid="preflight-verdict"
            data-can-generate={String(result.canGenerate)}
            className={`rounded-xl border p-4 sm:p-5 ${
              result.canGenerate
                ? 'border-emerald-200 bg-emerald-50'
                : 'border-red-200 bg-red-50'
            }`}
          >
            <div className="flex items-start gap-3">
              {result.canGenerate ? (
                <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-600" />
              ) : (
                <XCircle size={20} className="mt-0.5 shrink-0 text-red-600" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-800">
                  {result.ready} of {result.total} employees ready
                </p>
                <p className="mt-0.5 text-xs text-slate-600">
                  {result.canGenerate
                    ? 'Nothing is blocking this run.'
                    : 'This run is blocked. Half a payroll is worse than none, so ' +
                      'generation is refused until every blocker is cleared.'}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Period {result.window.periodStart} → {result.window.periodEnd}
                  {result.window.cutOffDate && (
                    <> · cut-off {result.window.cutOffDate}</>
                  )}
                  {result.window.paymentDate && <> · pays {result.window.paymentDate}</>}
                  {!result.window.fromCalendar && (
                    <span className="ml-1 opacity-70">(calendar month — no calendar configured)</span>
                  )}
                </p>
              </div>
              {result.canGenerate && (
                <Link
                  href="/dashboard/payroll/manage"
                  className="shrink-0 rounded-lg bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm"
                >
                  Generate
                </Link>
              )}
            </div>
          </div>

          {result.runFindings.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <h2 className="mb-3 text-sm font-semibold text-slate-800">The run itself</h2>
              <div className="space-y-2">
                {result.runFindings.map((f, i) => (
                  <FindingRow key={`${f.code}-${i}`} finding={f} />
                ))}
              </div>
            </section>
          )}

          {blocked.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                <XCircle size={15} className="text-red-600" />
                Blocked — {blocked.length}
              </h2>
              <div className="space-y-2">
                {blocked.map((e) => (
                  <FindingGroup key={e.employeeId} employee={e} severity="BLOCKING" />
                ))}
              </div>
            </section>
          )}

          {warned.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                <AlertTriangle size={15} className="text-amber-600" />
                Worth knowing — {warned.length}
              </h2>
              <p className="mb-3 text-xs text-slate-500">
                None of these stops the run. They are the things people ask about
                afterwards.
              </p>
              <div className="space-y-2">
                {warned.map((e) => (
                  <FindingGroup key={e.employeeId} employee={e} severity="WARNING" />
                ))}
              </div>
            </section>
          )}

          {result.total > 0 && blocked.length === 0 && warned.length === 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              Nothing to report. Every employee in this selection is ready.
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function PayrollValidatePage() {
  return (
    <ProtectedRoute requiredPermission="MANAGE_PAYROLL">
      <PayrollValidatePageContent />
    </ProtectedRoute>
  );
}
