'use client';

import { useEffect, useState } from 'react';
import { BarChart3, Info } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { FeaturePending } from '@/components/payroll/FeatureGate';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import { payrollReportService } from '@/services/payrollExtensionsService';
import { formatCurrency } from '@/utils/formatters';
import { apiErrorMessage } from '@/utils/apiError';

type Tab = 'register' | 'cost' | 'statutory' | 'gratuity' | 'variance';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'register', label: 'Register' },
  { id: 'cost', label: 'Cost by department' },
  { id: 'statutory', label: 'Statutory' },
  { id: 'gratuity', label: 'Gratuity liability' },
  { id: 'variance', label: 'Variance' },
];

/**
 * Per-tab empty states.
 *
 * An empty Variance is good news, an empty Register means nothing has been
 * locked. One generic "no data" makes those two indistinguishable.
 */
const EMPTY: Record<Tab, string> = {
  register: 'No payroll has been LOCKED for this period yet, so nobody has been paid.',
  cost: 'Nothing has been locked in this period, so there is no cost to attribute.',
  statutory: 'Nothing has been locked in this period, so nothing was withheld.',
  gratuity: 'No gratuity has been provisioned. Either the feature is new, or no payroll has locked since it was turned on.',
  variance: 'Nothing changed between the two periods — which is good news, not missing data.',
};

function PayrollReportsContent() {
  const features = usePayrollFeatures();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Payroll reports',
    'Every figure here reads LOCKED runs only. A run still in draft has not paid anybody.',
  );

  const now = new Date();
  const [tab, setTab] = useState<Tab>('register');
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [year, setYear] = useState(now.getUTCFullYear());
  /**
   * The payload AND the tab it belongs to.
   *
   * Clicking a tab re-renders before the effect runs, so a plain `data` state
   * leaves exactly one frame in which `tab` is the new one and `data` is still
   * the old one's — and the five tabs have five different row shapes. That
   * frame is what rendered register rows through the cost table.
   */
  const [result, setResult] = useState<{ tab: Tab; payload: any } | null>(null);
  /** Only ever the payload for the tab on screen. Never the previous tab's. */
  const data = result?.tab === tab ? result.payload : null;
  const [loading, setLoading] = useState(false);
  /** A 403 is not an empty result, and must not be shown as one. */
  const [failed, setFailed] = useState<string | null>(null);

  /**
   * One report, and only the one the reader is still looking at.
   *
   * The five tabs return five DIFFERENT row shapes, and this effect re-runs on
   * every keystroke in the month and year fields — typing "10" fires a request
   * for month 1 and then for month 10. Without a cancellation token the slower
   * response wins whenever two overlap, so `data` ends up holding one tab's
   * payload while `tab` names another and `ReportBody` renders the wrong report
   * against the wrong columns. It surfaced as a React "unique key" warning,
   * because register and variance rows carry no `key` field for the cost
   * table's `key={r.key}` to read — but the warning was the symptom. The defect
   * is a screen quietly showing the wrong numbers under the right heading.
   */
  useEffect(() => {
    if (!features.reports) return;

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setFailed(null);
      setResult(null);
      try {
        const res =
          tab === 'register'
            ? await payrollReportService.register(month, year)
            : tab === 'cost'
              ? await payrollReportService.cost(year, 'department', month)
              : tab === 'statutory'
                ? await payrollReportService.statutory(month, year)
                : tab === 'gratuity'
                  ? await payrollReportService.gratuityLiability()
                  : await payrollReportService.variance(month, year);
        if (!cancelled) setResult({ tab, payload: res.data });
      } catch (err) {
        // A 403 is not an empty result, and `lib/axios` rejects with a FLAT
        // object — `err.response.data.message` is always undefined here.
        if (!cancelled) setFailed(apiErrorMessage(err, 'Could not load this report'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [tab, month, year, features.reports]);

  // A flag that has not been READ yet is not a flag that is off. Every switch in
  // `brandingStore` initialises to false, so without this the screen states
  // "switched off" as a fact over a feature the admin has just turned on.
  if (!features.loaded) return <FeaturePending />;

  if (!features.reports) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <BarChart3 size={28} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-base font-semibold text-slate-800">
          Payroll reports are switched off
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          Turn them on under Settings → Payroll → Payroll extensions. The
          spreadsheet export on each run is unaffected either way.
        </p>
      </div>
    );
  }

  const openRuns = data?.meta?.openPayrolls ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-600">
            Month
            <input
              type="number"
              min={1}
              max={12}
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="mt-1 block w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Year
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="mt-1 block w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`report-tab-${t.id}`}
            className={`rounded-lg px-3 py-2 text-sm font-medium ${
              tab === t.id ? 'bg-brand-primary text-white' : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {openRuns.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <Info size={15} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">
              {openRuns.length} run{openRuns.length === 1 ? '' : 's'} still open.
            </span>{' '}
            Those figures are not in the numbers below, and will move them when they lock:{' '}
            {openRuns
              .slice(0, 5)
              .map((p: any) => `${p.month}/${p.year} (${p.status})`)
              .join(', ')}
            {openRuns.length > 5 ? ', …' : ''}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">Loading…</div>
        ) : failed ? (
          <div className="p-8 text-center text-sm text-red-600" data-testid="report-failed">
            {failed}
          </div>
        ) : (
          <ReportBody tab={tab} data={data} />
        )}
      </div>
    </div>
  );
}

function ReportBody({ tab, data }: { tab: Tab; data: any }) {
  const empty = (
    <div className="p-8 text-center text-sm text-slate-500" data-testid="report-empty">
      {EMPTY[tab]}
    </div>
  );

  if (!data) return empty;

  if (tab === 'register') {
    const rows = data.rows ?? [];
    if (rows.length === 0) return empty;
    return (
      <table className="w-full text-sm" data-testid="report-register">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">Employee</th>
            <th className="px-4 py-3">Department</th>
            <th className="px-4 py-3 text-right">Gross</th>
            <th className="px-4 py-3 text-right">Deductions</th>
            <th className="px-4 py-3 text-right">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r: any, i: number) => (
            <tr key={i}>
              <td className="px-4 py-2">
                <div className="text-slate-800">{r.fullName}</div>
                <div className="text-xs text-slate-400">{r.employeeCode}</div>
              </td>
              <td className="px-4 py-2 text-slate-600">{r.department ?? '—'}</td>
              <td className="px-4 py-2 text-right">{formatCurrency(r.gross)}</td>
              <td className="px-4 py-2 text-right text-red-600">-{formatCurrency(r.deductions)}</td>
              <td className="px-4 py-2 text-right font-semibold">{formatCurrency(r.netSalary)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-slate-50 font-semibold">
          <tr>
            <td className="px-4 py-3" colSpan={2}>{data.totals.employees} employees</td>
            <td className="px-4 py-3 text-right">{formatCurrency(data.totals.gross)}</td>
            <td className="px-4 py-3 text-right">-{formatCurrency(data.totals.deductions)}</td>
            <td className="px-4 py-3 text-right">{formatCurrency(data.totals.net)}</td>
          </tr>
        </tfoot>
      </table>
    );
  }

  if (tab === 'cost') {
    const rows = data.rows ?? [];
    if (rows.length === 0) return empty;
    return (
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">Department</th>
            <th className="px-4 py-3 text-right">People</th>
            <th className="px-4 py-3 text-right">Gross</th>
            <th className="px-4 py-3 text-right">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r: any, i: number) => (
            // The index is a fallback, not the key: `r.key` is the department
            // or branch id and is what keeps a row identified across a re-sort.
            <tr key={r.key ?? i}>
              <td className="px-4 py-2 text-slate-800">{r.label}</td>
              <td className="px-4 py-2 text-right">{r.employees}</td>
              <td className="px-4 py-2 text-right">{formatCurrency(r.gross)}</td>
              <td className="px-4 py-2 text-right font-semibold">{formatCurrency(r.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (tab === 'statutory') {
    const c = data.combined ?? {};
    const itemised = data.itemised ?? [];
    return (
      <div className="p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          {Object.entries(c).map(([k, v]) => (
            <div key={k} className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">{k}</p>
              <p className="text-lg font-semibold text-slate-800">
                {formatCurrency(Number(v))}
              </p>
            </div>
          ))}
        </div>
        {itemised.length > 0 ? (
          <div className="mt-5">
            <h3 className="mb-2 text-sm font-semibold text-slate-800">Broken down</h3>
            <div className="space-y-1">
              {itemised.map((r: any, i: number) => (
                <div key={r.code ?? i} className="flex justify-between border-b border-slate-100 py-1.5 text-sm">
                  <span className="text-slate-600">{r.code}</span>
                  <span className="font-medium">{formatCurrency(r.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-4 text-xs text-slate-500">
            The combined figures above are all that is available: insurance is PF
            plus ESI and tax is income tax plus professional tax, and the columns
            cannot say which is which. Turn on itemised payslips to split them.
          </p>
        )}
      </div>
    );
  }

  if (tab === 'gratuity') {
    const rows = data.rows ?? [];
    if (rows.length === 0) return empty;
    return (
      <div className="p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Provisioned</p>
            <p className="text-xl font-semibold text-slate-800">
              {formatCurrency(data.totals.provisioned)}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">Set aside month by month.</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Settled</p>
            <p className="text-xl font-semibold text-slate-800">
              {formatCurrency(data.totals.settled)}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">Already paid out on exit.</p>
          </div>
        </div>
      </div>
    );
  }

  const t = data.totals ?? {};
  return (
    <div className="p-4 sm:p-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">From pay changes</p>
          <p className="text-lg font-semibold">{formatCurrency(t.fromPayChanges ?? 0)}</p>
        </div>
        <div className="rounded-lg bg-emerald-50 p-3">
          <p className="text-xs uppercase tracking-wide text-emerald-700">From joiners</p>
          <p className="text-lg font-semibold">{formatCurrency(t.fromJoiners ?? 0)}</p>
        </div>
        <div className="rounded-lg bg-red-50 p-3">
          <p className="text-xs uppercase tracking-wide text-red-700">From leavers</p>
          <p className="text-lg font-semibold">{formatCurrency(t.fromLeavers ?? 0)}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Headcount is kept apart from pay on purpose: a month that looks 8% more
        expensive because two people joined is not a pay rise, and reading it as
        one is the most common way a variance report misleads.
      </p>
      {(data.changed ?? []).length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-slate-800">Who changed</h3>
          <div className="space-y-1">
            {data.changed.map((r: any, i: number) => (
              <div key={r.employeeCode ?? i} className="flex justify-between border-b border-slate-100 py-1.5 text-sm">
                <span className="text-slate-700">{r.fullName}</span>
                <span className={r.delta < 0 ? 'text-red-600' : 'text-emerald-700'}>
                  {r.delta > 0 ? '+' : ''}{formatCurrency(r.delta)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PayrollReportsPage() {
  return (
    <ProtectedRoute requiredPermission="VIEW_ALL_PAYROLL">
      <PayrollReportsContent />
    </ProtectedRoute>
  );
}
