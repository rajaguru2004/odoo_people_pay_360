'use client';

import { useEffect, useState } from 'react';
import { CalendarDays, Loader2 } from 'lucide-react';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { FeaturePending } from '@/components/payroll/FeatureGate';
import { usePayrollFeatures } from '@/hooks/usePayrollFeatures';
import { usePageHeader } from '@/hooks/usePageHeader';
import { payrollCalendarService } from '@/services/payrollExtensionsService';
import branchService from '@/services/branchService';
import { useBranchStore } from '@/store/branchStore';
import { apiErrorMessage } from '@/utils/apiError';
import { toast } from '@/lib/toast';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * The payroll year for one branch.
 *
 * Saved a whole year at a time, deliberately: a calendar with three of twelve
 * months configured is worse than none, because a run in an unconfigured month
 * behaves differently from its neighbours without saying so.
 */
function PayrollCalendarContent() {
  const features = usePayrollFeatures();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader(
    'Payroll calendar',
    'When each period opens, closes, cuts off and pays.',
  );

  const [branches, setBranches] = useState<any[]>([]);
  const [branchId, setBranchId] = useState('');
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [calendar, setCalendar] = useState<any>(null);
  const [cutOffDay, setCutOffDay] = useState(25);
  const [paymentDay, setPaymentDay] = useState(28);
  const [busy, setBusy] = useState(false);
  // The branch the header selector holds — the one the administrator believes
  // they are configuring. `Save the year` writes twelve periods in one press,
  // so opening on a different branch is not a cosmetic mismatch.
  const selectedBranchId = useBranchStore((s) => s.selectedBranchId);

  useEffect(() => {
    branchService
      .getAll()
      .then((r: any) => setBranches(r?.data ?? []))
      .catch(() => setBranches([]));
  }, []);

  // Follow the header. `list[0]` is whichever branch the API happened to return
  // first — on any deployment with more than one branch that is not the branch
  // named beside the page title, and the year was saved against it.
  //
  // The first branch stays the fallback for the two cases where the header has
  // nothing specific to say: no selection yet, or a persisted selection this
  // admin can no longer see.
  //
  // Deliberately NOT keyed on `branchId`: a branch picked in the select below is
  // an override for this screen and must survive a re-render.
  useEffect(() => {
    if (branches.length === 0) return;
    const fromHeader = branches.find((b: any) => b.id === selectedBranchId);
    setBranchId(fromHeader?.id ?? branches[0]?.id ?? '');
  }, [branches, selectedBranchId]);

  const load = async () => {
    if (!branchId) return;
    try {
      const res = await payrollCalendarService.forBranch(branchId, year);
      setCalendar(res.data);
    } catch {
      setCalendar(null);
    }
  };

  useEffect(() => {
    if (features.calendar && branchId) void load();
  }, [branchId, year, features.calendar]);

  const save = async () => {
    setBusy(true);
    try {
      const res = await payrollCalendarService.save({
        branchId,
        year,
        cutOffDay,
        paymentDay,
      });
      setCalendar(res.data);
      toast.success('Calendar saved');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not save the calendar'));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnforcement = async (month: number, next: boolean) => {
    if (!calendar) return;
    try {
      await payrollCalendarService.setEnforcement(calendar.id, month, next);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not change enforcement'));
    }
  };

  // A flag that has not been READ yet is not a flag that is off. Every switch in
  // `brandingStore` initialises to false, so without this the screen states
  // "switched off" as a fact over a feature the admin has just turned on.
  if (!features.loaded) return <FeaturePending />;

  if (!features.calendar) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <CalendarDays size={28} className="mx-auto mb-3 text-slate-300" />
        <h2 className="text-base font-semibold text-slate-800">
          The payroll calendar is switched off
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          A period is the calendar month, and no cut-off is checked. Turn it on
          under Settings → Payroll → Payroll extensions.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-600">
            Branch
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Year
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="mt-1 block w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Cut-off day
            <input
              type="number" min={1} max={31}
              value={cutOffDay}
              onChange={(e) => setCutOffDay(Number(e.target.value))}
              className="mt-1 block w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Pay day
            <input
              type="number" min={1} max={31}
              value={paymentDay}
              onChange={(e) => setPaymentDay(Number(e.target.value))}
              className="mt-1 block w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={save}
            disabled={busy || !branchId}
            data-testid="calendar-save"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            Save the year
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Days past the end of a short month are clamped, so February gets the 28th
          rather than a date that cannot be saved.
        </p>
      </div>

      {calendar?.periods?.length ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Month</th>
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3">Cut-off</th>
                <th className="px-4 py-3">Pays</th>
                <th className="px-4 py-3">Late inputs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {calendar.periods.map((p: any) => (
                <tr key={p.id} data-testid="calendar-period">
                  <td className="px-4 py-2 font-medium text-slate-800">{MONTHS[p.month - 1]}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {String(p.periodStart).slice(0, 10)} → {String(p.periodEnd).slice(0, 10)}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{String(p.cutOffDate).slice(0, 10)}</td>
                  <td className="px-4 py-2 text-slate-600">{String(p.paymentDate).slice(0, 10)}</td>
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={() => toggleEnforcement(p.month, !p.enforceCutOff)}
                      data-testid={`calendar-enforce-${p.month}`}
                      className={`rounded-full px-2 py-1 text-xs font-medium ${
                        p.enforceCutOff
                          ? 'bg-red-100 text-red-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {p.enforceCutOff ? 'Blocked' : 'Warned'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Enforcement is set per period, not globally, so one month can be
            tightened without changing how any other month behaves.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No calendar for {year} yet. Saving one above generates all twelve periods.
        </div>
      )}
    </div>
  );
}

export default function PayrollCalendarPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN']}>
      <PayrollCalendarContent />
    </ProtectedRoute>
  );
}
