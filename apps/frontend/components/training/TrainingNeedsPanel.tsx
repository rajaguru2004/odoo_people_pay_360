'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  GraduationCap,
  Loader2,
  Sparkles,
  KeyRound,
  UserPlus,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import trainingService from '@/services/trainingService';
import { TrainingNeed, TrainingSession } from '@/types/training';

/**
 * Training needs derived from an AI appraisal run.
 *
 * The competitive differentiator: competitors claim to derive training needs
 * from appraisal results; this reads the actual `improvementsJson` and
 * `recommendation` an appraisal produced and maps them onto the course
 * catalogue.
 *
 * Suggestions only. Nominating is a separate, explicit click — an LLM match is
 * a starting point for a development conversation, not a decision to spend
 * someone's time.
 */
export default function TrainingNeedsPanel({ runId }: { runId: string }) {
  const [needs, setNeeds] = useState<TrainingNeed[]>([]);
  const [meta, setMeta] = useState<Record<string, any> | null>(null);
  const [sessions, setSessions] = useState<TrainingSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [includeAll, setIncludeAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (all: boolean) => {
      setLoading(true);
      try {
        const [needsRes, sessionsRes] = await Promise.all([
          trainingService.needsFromRun(runId, all),
          trainingService.listSessions({ status: 'SCHEDULED' }),
        ]);
        setNeeds(Array.isArray(needsRes.data) ? needsRes.data : []);
        setMeta((needsRes as any).meta ?? null);
        setSessions(Array.isArray(sessionsRes.data) ? sessionsRes.data : []);
        setLoaded(true);
      } catch (e: any) {
        toast.error(e?.response?.data?.message || 'Failed to derive training needs');
      } finally {
        setLoading(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    if (loaded) load(includeAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeAll]);

  const nominate = async (need: TrainingNeed, courseId: string) => {
    if (!need.employeeId) {
      toast.error('This appraisal result is not linked to a current employee');
      return;
    }
    // Nominate into the next scheduled session of the suggested course.
    const session = sessions.find((s) => s.courseId === courseId);
    if (!session) {
      toast.warning(
        'No scheduled session for that course yet — schedule one first in Training.',
      );
      return;
    }
    setBusy(`${need.appraisalResultId}:${courseId}`);
    try {
      await trainingService.nominate({
        sessionId: session.id,
        employeeId: need.employeeId,
        // Provenance: this nomination is traceable back to the appraisal result
        // that produced it.
        source: 'APPRAISAL',
        appraisalResultId: need.appraisalResultId,
        justification: `Derived from appraisal: ${need.improvements[0] ?? ''}`.slice(0, 500),
      });
      toast.success(`${need.employeeName} nominated for ${session.course?.title}`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Failed to nominate');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-primary">
            <GraduationCap className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-900">Training needs</h3>
            <p className="text-sm text-slate-500">
              Derived from this appraisal&apos;s development areas. Suggestions only —
              nothing is nominated until you say so.
            </p>
          </div>
        </div>
        {!loaded ? (
          <button
            onClick={() => load(includeAll)}
            disabled={loading}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />} Derive needs
          </button>
        ) : (
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={includeAll}
              onChange={(e) => setIncludeAll(e.target.checked)}
            />
            Include everyone (not just Coach / PIP)
          </label>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Matching development areas to
          the course catalogue…
        </div>
      )}

      {loaded && !loading && needs.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-400">
          No development needs found in this run
          {meta?.catalogueSize === 0
            ? ' — the course catalogue is empty, so there is nothing to match against.'
            : '.'}
        </p>
      )}

      {loaded && !loading && needs.length > 0 && (
        <div className="space-y-2">
          {needs.map((need) => {
            const key = need.appraisalResultId;
            const open = expanded === key;
            return (
              <div key={key} className="rounded-xl border border-slate-200">
                <button
                  onClick={() => setExpanded(open ? null : key)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-800">
                        {need.employeeName}
                      </span>
                      <span className="text-xs text-slate-400">
                        {need.employeeCode}
                      </span>
                      {need.recommendation && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                          {need.recommendation}
                        </span>
                      )}
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600"
                        title={
                          need.matchedBy === 'llm'
                            ? 'Matched by the language model'
                            : need.matchedBy === 'keyword'
                              ? 'Matched by keyword overlap (model unavailable)'
                              : 'No course matched'
                        }
                      >
                        {need.matchedBy === 'llm' ? (
                          <Sparkles size={10} />
                        ) : (
                          <KeyRound size={10} />
                        )}
                        {need.suggestedCourses.length} suggestion
                        {need.suggestedCourses.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {need.improvements[0]}
                    </p>
                  </div>
                  {open ? (
                    <ChevronDown size={16} className="shrink-0 text-slate-400" />
                  ) : (
                    <ChevronRight size={16} className="shrink-0 text-slate-400" />
                  )}
                </button>

                {open && (
                  <div className="border-t border-slate-100 px-4 py-3">
                    <p className="mb-1 text-xs font-semibold uppercase text-slate-500">
                      Development areas from the appraisal
                    </p>
                    <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
                      {need.improvements.map((imp, i) => (
                        <li key={i}>{imp}</li>
                      ))}
                    </ul>

                    <p className="mb-1 text-xs font-semibold uppercase text-slate-500">
                      Suggested courses
                    </p>
                    {need.suggestedCourses.length === 0 ? (
                      <p className="text-sm text-slate-400">
                        Nothing in the catalogue matches these areas.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {need.suggestedCourses.map((c) => (
                          <div
                            key={c.courseId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-800">
                                {c.title}{' '}
                                <span className="font-mono text-xs text-slate-400">
                                  {c.code}
                                </span>
                              </p>
                              <p className="text-xs text-slate-500">{c.reason}</p>
                            </div>
                            <button
                              onClick={() => nominate(need, c.courseId)}
                              disabled={busy === `${key}:${c.courseId}`}
                              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-brand-primary px-2.5 text-xs font-medium text-white disabled:opacity-50"
                            >
                              {busy === `${key}:${c.courseId}` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <UserPlus size={12} />
                              )}
                              Nominate
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
