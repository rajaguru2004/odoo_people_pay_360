'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Award,
  Brain,
  CalendarDays,
  Check,
  ClipboardCheck,
  Clock,
  FolderKanban,
  Gauge,
  Loader2,
  Minus,
  ShieldCheck,
  ThumbsUp,
  TrendingUp,
  Trophy,
  Users,
} from 'lucide-react';
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from 'recharts';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { buildEvidence, EvidenceFact } from '@/components/appraisal/evidence';
import appraisalService from '@/services/appraisalService';
import {
  AppraisalResult,
  DIMENSION_LABELS,
  RECOMMENDATION_STYLES,
  SCORE_DIMENSIONS,
  ScoreDimension,
  scoreBg,
  scoreColor,
} from '@/types/appraisal';

const DIMENSION_ICONS: Record<ScoreDimension, any> = {
  attendance: Clock,
  punctuality: CalendarDays,
  productivity: Gauge,
  taskCompletion: ClipboardCheck,
  projectContribution: FolderKanban,
  disciplineConsistency: ShieldCheck,
  teamContribution: Users,
};

export default function AppraisalResultPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER'] as any}>
      <ResultPageInner />
    </ProtectedRoute>
  );
}

function ResultPageInner() {
  const params = useParams<{ id: string; resultId: string }>();
  const [result, setResult] = useState<AppraisalResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!params?.id || !params?.resultId) return;
    (async () => {
      try {
        setResult(await appraisalService.getResult(params.id, params.resultId));
      } catch {
        /* handled by empty state */
      } finally {
        setLoading(false);
      }
    })();
  }, [params?.id, params?.resultId]);

  const evidence = useMemo(
    () => buildEvidence(result?.metricsJson as Record<string, any> | null),
    [result?.metricsJson],
  );

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 size={18} className="animate-spin" /> Loading appraisal…
      </div>
    );
  }
  if (!result) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-slate-400">
        <AlertCircle size={22} />
        <p className="text-sm">Appraisal result not found.</p>
      </div>
    );
  }

  const overall = result.scoresJson?.overall ?? 0;
  const rec = result.recommendation ? RECOMMENDATION_STYLES[result.recommendation] : null;
  const radarData = SCORE_DIMENSIONS.map((d) => ({
    dimension: DIMENSION_LABELS[d],
    score: result.scoresJson?.[d] ?? 0,
  }));

  return (
    <div className="space-y-4 pb-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href={`/dashboard/appraisal/runs/${result.runId}`}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50"
          >
            <ArrowLeft size={13} /> Report
          </Link>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-primary/10 text-sm font-bold text-brand-primary">
            {result.employeeName.split(' ').map((s) => s[0]).slice(0, 2).join('')}
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">{result.employeeName}</h1>
            <p className="text-xs text-slate-500">
              {result.position ?? '—'} · {result.departmentName ?? 'No department'} ·{' '}
              {result.employeeCode}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {result.rankOverall != null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
              <Trophy size={13} className="text-amber-500" /> Org rank #{result.rankOverall}
            </span>
          )}
          {result.rankDepartment != null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
              <Award size={13} className="text-sky-500" /> Dept rank #{result.rankDepartment}
            </span>
          )}
          {rec && (
            <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${rec.className}`}>
              {rec.label}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[380px_1fr]">
        {/* Radar + overall */}
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="text-center">
            <div className={`text-5xl font-black ${scoreColor(overall)}`}>{overall}</div>
            <div className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-400">
              Overall performance score
            </div>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={radarData} outerRadius="72%">
              <PolarGrid stroke="#e2e8f0" />
              <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10, fill: '#64748b' }} />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              <Radar dataKey="score" stroke="#4f46e5" fill="#4f46e5" fillOpacity={0.25} />
            </RadarChart>
          </ResponsiveContainer>
          <div className="space-y-2">
            {SCORE_DIMENSIONS.map((d) => {
              const v = result.scoresJson?.[d] ?? 0;
              return (
                <div key={d} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 text-xs text-slate-500">{DIMENSION_LABELS[d]}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div className={`h-full rounded-full ${scoreBg(v)}`} style={{ width: `${v}%` }} />
                  </div>
                  <span className={`w-8 text-right text-xs font-bold ${scoreColor(v)}`}>{v}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Narrative */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Brain size={15} className="text-brand-primary" /> AI Performance Summary
              {result.status === 'DEGRADED' && (
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-normal text-slate-400">
                  scored directly from records
                </span>
              )}
            </div>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-600">
              {result.summary ?? 'No summary available.'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <InsightList
              icon={ThumbsUp}
              title="Strengths"
              items={result.strengthsJson ?? []}
              accent="text-emerald-600"
            />
            <InsightList
              icon={TrendingUp}
              title="Areas for Improvement"
              items={result.improvementsJson ?? []}
              accent="text-sky-600"
            />
            <InsightList
              icon={AlertTriangle}
              title="Risks"
              items={result.risksJson ?? []}
              accent="text-amber-600"
            />
          </div>
        </div>
      </div>

      {/* Why these scores — the evidence */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
          <ShieldCheck size={15} className="text-brand-primary" /> Why these scores
        </div>
        <p className="mb-4 text-xs text-slate-400">
          Every score below is backed by {result.employeeName.split(' ')[0]}&apos;s own HR records
          from this period{evidence.sources ? ` (${evidence.sources} record types reviewed)` : ''}.
          Where no records exist, the score stays neutral — nobody is penalized for missing data.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {SCORE_DIMENSIONS.map((d) => {
            const v = result.scoresJson?.[d] ?? 0;
            const facts = evidence.byDimension[d];
            const Icon = DIMENSION_ICONS[d];
            return (
              <div key={d} className="rounded-xl border border-slate-100 bg-slate-50/40 p-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm">
                    <Icon size={15} />
                  </span>
                  <span className="flex-1 text-sm font-semibold text-slate-800">
                    {DIMENSION_LABELS[d]}
                  </span>
                  <span className={`rounded-full px-2.5 py-0.5 text-sm font-bold text-white ${scoreBg(v)}`}>
                    {v}
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${scoreBg(v)}`} style={{ width: `${v}%` }} />
                </div>
                <ul className="mt-3 space-y-1.5">
                  {facts.length ? (
                    facts.map((f, i) => <FactRow key={i} fact={f} />)
                  ) : (
                    <li className="flex items-start gap-2 text-xs text-slate-400">
                      <Minus size={13} className="mt-0.5 shrink-0" />
                      No records for this period — scored neutrally, not counted against them.
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
        {evidence.extras.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="mb-1.5 text-xs font-semibold text-slate-500">Also on record</div>
            <ul className="space-y-1">
              {evidence.extras.map((f, i) => (
                <FactRow key={i} fact={f} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function FactRow({ fact }: { fact: EvidenceFact }) {
  return (
    <li className="flex items-start gap-2 text-xs leading-relaxed text-slate-600">
      {fact.tone === 'good' ? (
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <Check size={10} strokeWidth={3} />
        </span>
      ) : fact.tone === 'bad' ? (
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
          <AlertTriangle size={10} />
        </span>
      ) : (
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <Minus size={10} />
        </span>
      )}
      {fact.text}
    </li>
  );
}

function InsightList({
  icon: Icon,
  title,
  items,
  accent,
}: {
  icon: any;
  title: string;
  items: string[];
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className={`mb-2 flex items-center gap-1.5 text-xs font-semibold ${accent}`}>
        <Icon size={14} /> {title}
      </div>
      {items.length ? (
        <ul className="space-y-1.5">
          {items.map((s, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-600">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
              {s}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-300">None identified.</p>
      )}
    </div>
  );
}
