'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Calendar,
  ChevronRight,
  Loader2,
  Play,
  Sparkles,
  Trash2,
  Trophy,
  Users,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import axiosInstance from '@/lib/axios';
import appraisalService from '@/services/appraisalService';
import { AppraisalPeriodPreset, AppraisalRunSummary } from '@/types/appraisal';
import { formatDateTime } from '@/utils/formatters';
import { usePageHeader } from '@/hooks/usePageHeader';

const PRESETS: Array<{ key: AppraisalPeriodPreset; label: string }> = [
  { key: 'LAST_MONTH', label: 'Last Month' },
  { key: 'LAST_QUARTER', label: 'Last Quarter' },
  { key: 'LAST_6_MONTHS', label: 'Last 6 Months' },
  { key: 'LAST_YEAR', label: 'Last Year' },
  { key: 'CUSTOM', label: 'Custom' },
];

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-slate-50 text-slate-500 border-slate-200',
  RUNNING: 'bg-sky-50 text-sky-600 border-sky-200',
  COMPLETED: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  FAILED: 'bg-red-50 text-red-600 border-red-200',
  CANCELLED: 'bg-amber-50 text-amber-600 border-amber-200',
};

interface DeptOption {
  id: string;
  name: string;
}

export default function AppraisalPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER'] as any}>
      <AppraisalPageInner />
    </ProtectedRoute>
  );
}

function AppraisalPageInner() {
  const router = useRouter();

  // The one heading for this route, rendered by TopHeader. Kept short:
  // TopHeader's subtitle is a single truncating line, not the old hero panel's
  // wrapping paragraph — the fuller description lives just below, in the
  // "Watch the AI review real HR records..." helper text.
  usePageHeader('AI Appraisal & Ranking', 'Autonomous performance analysis by the HR Copilot');

  const [runs, setRuns] = useState<AppraisalRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [preset, setPreset] = useState<AppraisalPeriodPreset>('LAST_6_MONTHS');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [selectedDepts, setSelectedDepts] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const list = await appraisalService.listRuns();
      setRuns(Array.isArray(list) ? list : []);
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    (async () => {
      try {
        const res: any = await axiosInstance.get('/departments');
        const raw = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
        setDepartments(
          raw
            .filter((d: any) => d?.id && d?.name)
            .map((d: any) => ({ id: d.id, name: d.name })),
        );
      } catch {
        /* dept filter is optional */
      }
    })();
  }, [refresh]);

  const activeRun = useMemo(
    () => runs.find((r) => r.status === 'RUNNING' || r.status === 'PENDING'),
    [runs],
  );

  const toggleDept = (id: string) =>
    setSelectedDepts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleGenerate = async () => {
    if (activeRun) {
      router.push(`/dashboard/appraisal/runs/${activeRun.id}`);
      return;
    }
    if (preset === 'CUSTOM' && (!startDate || !endDate)) {
      toast.error('Pick a start and end date for the custom period');
      return;
    }
    setStarting(true);
    try {
      const run = await appraisalService.createRun({
        preset,
        ...(preset === 'CUSTOM' ? { startDate, endDate } : {}),
        ...(selectedDepts.size ? { departmentIds: [...selectedDepts] } : {}),
      });
      toast.success('Appraisal agent launched');
      router.push(`/dashboard/appraisal/runs/${run.id}`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to start the appraisal');
      setStarting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await appraisalService.deleteRun(id);
      toast.success('Run deleted');
      void refresh();
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to delete run');
    }
  };

  return (
    <div className="space-y-5">
      {/* Hero / generate panel */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 p-6 text-white">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 right-32 h-40 w-40 rounded-full bg-sky-400/10 blur-3xl" />
        {/* The panel keeps its period/department controls; its title and
            description moved to the sticky TopHeader via usePageHeader above. */}
        <div className="relative">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <Calendar size={13} /> Period
            </span>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  preset === p.key
                    ? 'bg-white text-slate-900'
                    : 'bg-white/10 text-slate-200 hover:bg-white/20'
                }`}
              >
                {p.label}
              </button>
            ))}
            {preset === 'CUSTOM' && (
              <span className="inline-flex items-center gap-2">
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="rounded-lg border border-white/20 bg-white/10 px-2 py-1 text-xs text-white [color-scheme:dark]"
                />
                <span className="text-xs text-slate-400">to</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="rounded-lg border border-white/20 bg-white/10 px-2 py-1 text-xs text-white [color-scheme:dark]"
                />
              </span>
            )}
          </div>

          {departments.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-medium text-slate-300">
                <Users size={13} /> Departments
              </span>
              <button
                onClick={() => setSelectedDepts(new Set())}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                  selectedDepts.size === 0
                    ? 'bg-white text-slate-900'
                    : 'bg-white/10 text-slate-200 hover:bg-white/20'
                }`}
              >
                All
              </button>
              {departments.map((d) => (
                <button
                  key={d.id}
                  onClick={() => toggleDept(d.id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                    selectedDepts.has(d.id)
                      ? 'bg-white text-slate-900'
                      : 'bg-white/10 text-slate-200 hover:bg-white/20'
                  }`}
                >
                  {d.name}
                </button>
              ))}
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              onClick={handleGenerate}
              disabled={starting}
              className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-slate-900 shadow-lg transition hover:bg-slate-100 disabled:opacity-60"
            >
              {starting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : activeRun ? (
                <Play size={16} />
              ) : (
                <Wand2 size={16} />
              )}
              {activeRun ? 'Watch the run in progress' : 'Generate Appraisal'}
            </button>
            <span className="text-xs text-slate-400">
              Watch the AI review real HR records, person by person, live.
            </span>
          </div>
        </div>
      </div>

      {/* Run history */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          <Trophy size={15} className="text-brand-primary" /> Appraisal History
        </div>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" /> Loading runs…
          </div>
        ) : runs.length === 0 ? (
          <div className="py-12 text-center">
            <Sparkles size={22} className="mx-auto text-slate-300" />
            <p className="mt-2 text-sm text-slate-400">
              No appraisals yet — generate your first one above.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2.5 font-medium">Period</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Employees</th>
                <th className="hidden px-3 py-2.5 font-medium md:table-cell">Started</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 transition hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    <div className="font-medium text-slate-800">{r.periodLabel ?? 'Custom'}</div>
                    <div className="text-xs text-slate-400">
                      {r.periodStart?.slice(0, 10)} → {r.periodEnd?.slice(0, 10)}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[r.status] ?? STATUS_STYLES.PENDING}`}
                    >
                      {r.status === 'RUNNING' && <Loader2 size={10} className="animate-spin" />}
                      {r.status}
                    </span>
                  </td>
                  <td className="hidden px-3 py-3 text-slate-500 sm:table-cell">
                    {r.completedEmployees}/{r.totalEmployees}
                  </td>
                  <td className="hidden px-3 py-3 text-xs text-slate-400 md:table-cell">
                    {r.startedAt ? formatDateTime(r.startedAt) : '—'}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {['COMPLETED', 'FAILED', 'CANCELLED'].includes(r.status) && (
                        <button
                          onClick={() => handleDelete(r.id)}
                          className="rounded-lg p-1.5 text-slate-300 transition hover:bg-red-50 hover:text-red-500"
                          title="Delete run"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => router.push(`/dashboard/appraisal/runs/${r.id}`)}
                        className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-primary hover:underline"
                      >
                        {r.status === 'RUNNING' ? 'Watch live' : 'Open'} <ChevronRight size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
