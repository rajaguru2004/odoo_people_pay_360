'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Award,
  Brain,
  Building2,
  ChevronRight,
  Crown,
  Medal,
  TrendingDown,
  Trophy,
  Users,
  Wrench,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AppraisalResult,
  AppraisalRunDetail,
  RECOMMENDATION_STYLES,
  scoreBg,
  scoreColor,
} from '@/types/appraisal';

const overallOf = (r: AppraisalResult): number => r.scoresJson?.overall ?? 0;

export default function ResultsDashboard({ run }: { run: AppraisalRunDetail }) {
  const results = useMemo(
    () =>
      run.results
        .filter((r) => r.status === 'COMPLETED' || r.status === 'DEGRADED')
        .sort((a, b) => (a.rankOverall ?? 9999) - (b.rankOverall ?? 9999)),
    [run.results],
  );
  const failed = run.results.filter((r) => r.status === 'FAILED');
  const avg = results.length
    ? Math.round(results.reduce((s, r) => s + overallOf(r), 0) / results.length)
    : 0;
  const top3 = results.slice(0, 3);
  const needsAttention = results.filter((r) => overallOf(r) < 55);
  const deptAverages = run.orgInsightsJson?.departmentAverages ?? [];
  const insights = run.orgInsightsJson;

  const distribution = useMemo(() => {
    const buckets = [
      { name: '0–39', min: 0, max: 39, count: 0 },
      { name: '40–54', min: 40, max: 54, count: 0 },
      { name: '55–69', min: 55, max: 69, count: 0 },
      { name: '70–84', min: 70, max: 84, count: 0 },
      { name: '85–100', min: 85, max: 100, count: 0 },
    ];
    for (const r of results) {
      const v = overallOf(r);
      const b = buckets.find((x) => v >= x.min && v <= x.max);
      if (b) b.count += 1;
    }
    return buckets;
  }, [results]);

  const durationMin =
    run.startedAt && run.completedAt
      ? Math.max(1, Math.round((+new Date(run.completedAt) - +new Date(run.startedAt)) / 60000))
      : null;

  return (
    <div className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard icon={Users} label="Employees evaluated" value={`${results.length}`} sub={failed.length ? `${failed.length} failed` : undefined} />
        <KpiCard icon={Award} label="Average score" value={`${avg}/100`} valueClass={scoreColor(avg)} />
        <KpiCard icon={Crown} label="Top performer" value={top3[0]?.employeeName ?? '—'} sub={top3[0] ? `${overallOf(top3[0])}/100` : undefined} small />
        <KpiCard icon={Wrench} label="Record checks" value={`${run.toolCallCount}`} sub={durationMin ? `completed in ~${durationMin} min` : undefined} />
      </div>

      {/* Executive summary */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Brain size={16} className="text-brand-primary" /> AI Executive Summary
        </div>
        <p className="whitespace-pre-line text-sm leading-relaxed text-slate-600">
          {run.executiveSummary ?? 'No summary was generated for this run.'}
        </p>
        {!!insights?.organizationInsights?.length && (
          <ul className="mt-3 space-y-1.5">
            {insights.organizationInsights.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-primary" />
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Department rankings */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Building2 size={16} className="text-brand-primary" /> Department Rankings
          </div>
          {deptAverages.length ? (
            <ResponsiveContainer width="100%" height={Math.max(160, deptAverages.length * 44)}>
              <BarChart data={deptAverages} layout="vertical" margin={{ left: 8, right: 24 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <YAxis type="category" dataKey="department" width={120} tick={{ fontSize: 12, fill: '#475569' }} />
                <Tooltip formatter={(v: any) => [`${v}/100`, 'Avg score']} cursor={{ fill: '#f8fafc' }} />
                <Bar dataKey="avgScore" radius={[0, 6, 6, 0]} barSize={18}>
                  {deptAverages.map((d, i) => (
                    <Cell key={i} fill={d.avgScore >= 70 ? '#0ea5e9' : d.avgScore >= 55 ? '#94a3b8' : '#f59e0b'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty text="No department data" />
          )}
          {!!insights?.departmentInsights?.length && (
            <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
              {insights.departmentInsights.map((d, i) => (
                <p key={i} className="text-xs text-slate-500">
                  <span className="font-semibold text-slate-700">{d.department}:</span> {d.insight}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Score distribution */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Trophy size={16} className="text-brand-primary" /> Score Distribution
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={distribution}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} />
              <Tooltip formatter={(v: any) => [v, 'Employees']} cursor={{ fill: '#f8fafc' }} />
              <Bar dataKey="count" radius={[6, 6, 0, 0]} barSize={36}>
                {distribution.map((b, i) => (
                  <Cell key={i} fill={['#ef4444', '#f59e0b', '#94a3b8', '#0ea5e9', '#10b981'][i]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          {/* Top performers podium */}
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-4">
            {top3.map((r, i) => (
              <Link
                key={r.id}
                href={`/dashboard/appraisal/runs/${run.id}/results/${r.id}`}
                className={`rounded-xl border p-3 text-center transition hover:shadow-sm ${
                  i === 0 ? 'border-amber-200 bg-amber-50/60' : 'border-slate-100 bg-slate-50/60'
                }`}
              >
                <Medal size={16} className={`mx-auto ${i === 0 ? 'text-amber-500' : i === 1 ? 'text-slate-400' : 'text-orange-400'}`} />
                <div className="mt-1 truncate text-xs font-semibold text-slate-800">{r.employeeName}</div>
                <div className={`text-sm font-bold ${scoreColor(overallOf(r))}`}>{overallOf(r)}</div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Needs attention */}
      {(needsAttention.length > 0 || !!insights?.needsAttention?.length) && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-5">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800">
            <TrendingDown size={16} /> Employees Needing Attention
          </div>
          <div className="flex flex-wrap gap-2">
            {needsAttention.map((r) => (
              <Link
                key={r.id}
                href={`/dashboard/appraisal/runs/${run.id}/results/${r.id}`}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-amber-50"
              >
                {r.employeeName}
                <span className={`font-bold ${scoreColor(overallOf(r))}`}>{overallOf(r)}</span>
              </Link>
            ))}
          </div>
          {!!insights?.needsAttention?.length && (
            <ul className="mt-3 space-y-1">
              {insights.needsAttention.map((s, i) => (
                <li key={i} className="text-xs text-amber-800/80">
                  • {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Full ranking table */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
          Organization Ranking
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2.5 font-medium">Rank</th>
                <th className="px-3 py-2.5 font-medium">Employee</th>
                <th className="hidden px-3 py-2.5 font-medium md:table-cell">Department</th>
                <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Score profile</th>
                <th className="px-3 py-2.5 font-medium">Overall</th>
                <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Recommendation</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const overall = overallOf(r);
                const rec = r.recommendation ? RECOMMENDATION_STYLES[r.recommendation] : null;
                return (
                  <tr key={r.id} className="border-b border-slate-50 transition hover:bg-slate-50/60">
                    <td className="px-5 py-2.5 font-bold text-slate-400">#{r.rankOverall ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-800">{r.employeeName}</div>
                      <div className="text-xs text-slate-400">{r.position ?? r.employeeCode}</div>
                    </td>
                    <td className="hidden px-3 py-2.5 text-slate-500 md:table-cell">
                      {r.departmentName ?? '—'}
                      {r.rankDepartment === 1 && (
                        <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-700">
                          dept #1
                        </span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 lg:table-cell">
                      <MiniBars result={r} />
                    </td>
                    <td className={`px-3 py-2.5 font-bold ${scoreColor(overall)}`}>{overall}</td>
                    <td className="hidden px-3 py-2.5 sm:table-cell">
                      {rec && (
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${rec.className}`}>
                          {rec.label}
                        </span>
                      )}
                      {r.status === 'DEGRADED' && (
                        <span className="ml-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-400" title="Scored directly from HR records">
                          record-based
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        href={`/dashboard/appraisal/runs/${run.id}/results/${r.id}`}
                        className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-primary hover:underline"
                      >
                        Details <ChevronRight size={13} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  valueClass,
  small,
}: {
  icon: any;
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
        <Icon size={14} /> {label}
      </div>
      <div className={`mt-1.5 truncate font-bold text-slate-900 ${small ? 'text-base' : 'text-2xl'} ${valueClass ?? ''}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

function MiniBars({ result }: { result: AppraisalResult }) {
  const dims: Array<[string, number | undefined]> = [
    ['Att', result.scoresJson?.attendance],
    ['Pun', result.scoresJson?.punctuality],
    ['Prod', result.scoresJson?.productivity],
    ['Task', result.scoresJson?.taskCompletion],
    ['Proj', result.scoresJson?.projectContribution],
    ['Disc', result.scoresJson?.disciplineConsistency],
    ['Team', result.scoresJson?.teamContribution],
  ];
  return (
    <div className="flex items-end gap-1">
      {dims.map(([label, v]) => (
        <div key={label} className="flex flex-col items-center gap-0.5" title={`${label}: ${v ?? '—'}`}>
          <div className="flex h-7 w-2 items-end overflow-hidden rounded-sm bg-slate-100">
            <div className={`w-full rounded-sm ${scoreBg(v ?? 0)}`} style={{ height: `${v ?? 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="py-8 text-center text-xs text-slate-400">{text}</div>;
}
