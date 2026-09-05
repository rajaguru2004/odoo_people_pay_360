'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import TrainingNeedsPanel from '@/components/training/TrainingNeedsPanel';
import { AlertCircle, ArrowLeft, Award, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import AgentTheater from '@/components/appraisal/AgentTheater';
import ResultsDashboard from '@/components/appraisal/ResultsDashboard';
import appraisalService from '@/services/appraisalService';
import { AppraisalRunDetail } from '@/types/appraisal';

export default function AppraisalRunPage() {
  return (
    <ProtectedRoute requiredRoles={['ADMIN', 'HR_MANAGER'] as any}>
      <RunPageInner />
    </ProtectedRoute>
  );
}

function RunPageInner() {
  const params = useParams<{ id: string }>();
  const runId = params?.id;
  const [run, setRun] = useState<AppraisalRunDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const detail = await appraisalService.getRun(runId);
      setRun(detail);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to load the run');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleFinished = useCallback(
    (status: string) => {
      if (status === 'COMPLETED') toast.success('Appraisal complete — report ready');
      else if (status === 'CANCELLED') toast.info('Appraisal run cancelled');
      else toast.error('Appraisal run failed');
      void load();
    },
    [load],
  );

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 size={18} className="animate-spin" /> Loading appraisal run…
      </div>
    );
  }
  if (!run) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-slate-400">
        <AlertCircle size={22} />
        <p className="text-sm">Run not found or not accessible.</p>
        <BackLink />
      </div>
    );
  }

  const isLive = run.status === 'RUNNING' || run.status === 'PENDING';

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BackLink />
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-primary">
            <Award size={19} />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">
              {isLive ? 'Appraisal in progress' : 'Appraisal Report'}
            </h1>
            <p className="text-xs text-slate-500">
              {run.periodLabel} · {run.periodStart?.slice(0, 10)} → {run.periodEnd?.slice(0, 10)}
              {run.model ? ` · ${run.model}` : ''}
            </p>
          </div>
        </div>
      </div>

      {isLive ? (
        <div className="min-h-0 flex-1">
          <AgentTheater run={run} onFinished={handleFinished} />
        </div>
      ) : run.status === 'COMPLETED' ? (
        <div className="min-h-0 flex-1 overflow-y-auto pb-6">
          <ResultsDashboard run={run} />
          {/* The differentiator: turn this run's development areas into
              concrete course nominations, with the provenance kept. */}
          <TrainingNeedsPanel runId={run.id} />
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <AlertCircle size={22} className="mx-auto text-amber-400" />
          <p className="mt-2 text-sm font-medium text-slate-700">
            Run {run.status.toLowerCase()}
            {run.error ? ` — ${run.error}` : ''}
          </p>
          {run.results?.length > 0 && (
            <div className="mx-auto mt-4 max-w-4xl text-left">
              <ResultsDashboard run={run} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/dashboard/appraisal"
      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50"
    >
      <ArrowLeft size={13} /> All runs
    </Link>
  );
}
