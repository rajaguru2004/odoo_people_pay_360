'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  Brain,
  CalendarDays,
  Check,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Crown,
  FileText,
  FolderKanban,
  Hourglass,
  Loader2,
  Receipt,
  Search,
  ShieldCheck,
  Sparkles,
  StopCircle,
  Timer,
  Trophy,
  UserRound,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import appraisalService from '@/services/appraisalService';
import { streamAppraisalRun } from '@/services/appraisalStream';
import { AppraisalRunSummary, AppraisalStreamEvent, scoreBg, scoreColor } from '@/types/appraisal';

const PHASES: Array<{ key: string; label: string; icon: any }> = [
  { key: 'init', label: 'Getting ready', icon: Sparkles },
  { key: 'discover', label: 'Finding your people', icon: Users },
  { key: 'plan', label: 'Planning the review', icon: ClipboardList },
  { key: 'collect', label: 'Reviewing records', icon: Search },
  { key: 'analyze', label: 'Writing insights', icon: Brain },
  { key: 'rank', label: 'Ranking performance', icon: Trophy },
  { key: 'synthesize', label: 'Executive summary', icon: Crown },
  { key: 'finalize', label: 'Wrapping up', icon: CheckCircle2 },
];

/** What each data check means in plain language — no internal names surface. */
const TOOL_STEPS: Record<string, { key: string; label: string; icon: any }> = {
  employee_get: { key: 'profile', label: 'Profile', icon: UserRound },
  attendance_employee_summary: { key: 'attendance', label: 'Attendance', icon: Clock },
  leave_employee_summary: { key: 'leave', label: 'Leave', icon: CalendarDays },
  overtime_employee_summary: { key: 'overtime', label: 'Overtime', icon: Timer },
  task_employee_stats: { key: 'tasks', label: 'Tasks', icon: ClipboardCheck },
  project_contribution_get: { key: 'projects', label: 'Projects', icon: FolderKanban },
  worklog_employee_summary: { key: 'hours', label: 'Work hours', icon: Hourglass },
  timesheet_employee_summary: { key: 'timesheets', label: 'Timesheets', icon: FileText },
  reimbursement_employee_summary: { key: 'claims', label: 'Claims', icon: Receipt },
  conduct_records_get: { key: 'conduct', label: 'Conduct', icon: ShieldCheck },
  team_membership_get: { key: 'team', label: 'Teamwork', icon: Users },
};

const stepFor = (tool: string) =>
  TOOL_STEPS[tool] ?? { key: tool, label: 'Records', icon: Search };

interface StepState {
  key: string;
  label: string;
  icon: any;
  status: 'running' | 'done';
}

interface ActiveEmp {
  id: string;
  name: string;
  department: string | null;
  steps: StepState[];
  writing: boolean; // data gathered, insights being written
}

interface DoneEmp {
  id: string;
  name: string;
  department: string | null;
  score?: number;
  failed?: boolean;
}

const NARRATOR_BY_PHASE: Record<string, string> = {
  init: 'Your AI HR analyst is warming up…',
  discover: 'Looking up everyone included in this review…',
  plan: 'Deciding which records give the fairest picture…',
  collect: 'Going through real HR records, person by person…',
  analyze: 'Turning the evidence into insights…',
  rank: 'Comparing performance across the organization…',
  synthesize: 'Writing the executive summary…',
  finalize: 'Putting the final report together…',
};

export default function AgentTheater({
  run,
  onFinished,
}: {
  run: AppraisalRunSummary;
  onFinished: (status: string) => void;
}) {
  const [phase, setPhase] = useState<string>(run.currentPhase ?? 'init');
  const [narrator, setNarrator] = useState<string>(NARRATOR_BY_PHASE.init);
  const [active, setActive] = useState<Map<string, ActiveEmp>>(new Map());
  const [done, setDone] = useState<DoneEmp[]>([]);
  const [progress, setProgress] = useState({
    completed: run.completedEmployees,
    total: run.totalEmployees,
  });
  const [checks, setChecks] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);

  const lastSeq = useRef(0);
  const finishedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const handleEvent = useCallback((e: AppraisalStreamEvent) => {
    if (e.seq <= lastSeq.current) return;
    lastSeq.current = e.seq;
    switch (e.type) {
      case 'phase': {
        const p = e.phase ?? 'init';
        setPhase(p);
        setNarrator(NARRATOR_BY_PHASE[p] ?? e.label ?? '');
        break;
      }
      case 'log': {
        const text = e.text ?? '';
        // Only surface logs that read well for non-technical viewers.
        const found = text.match(/^Found (\d+) active employee/);
        if (found) setNarrator(`Found ${found[1]} people to review — starting with their records…`);
        else if (text.startsWith('Review plan ready')) setNarrator(text);
        else if (text.startsWith('Rankings computed')) {
          setNarrator(text.replace('Rankings computed.', 'Rankings are in!'));
        }
        break;
      }
      case 'tool_call': {
        if (!e.employeeId || !e.tool) break;
        const step = stepFor(e.tool);
        setActive((prev) => {
          const next = new Map(prev);
          const emp = next.get(e.employeeId!);
          if (!emp) return prev;
          const steps = [...emp.steps];
          const idx = steps.findIndex((s) => s.key === step.key);
          if (e.phase === 'started') {
            if (idx < 0) steps.push({ ...step, status: 'running' });
            else steps[idx] = { ...steps[idx], status: 'running' };
          } else if (idx >= 0) {
            steps[idx] = { ...steps[idx], status: 'done' };
          }
          const allDone = e.phase === 'finished' && steps.length > 0 && steps.every((s) => s.status === 'done');
          next.set(e.employeeId!, { ...emp, steps, writing: allDone });
          return next;
        });
        if (e.phase === 'finished') setChecks((c) => c + 1);
        break;
      }
      case 'employee_started':
        setActive((prev) => {
          const next = new Map(prev);
          next.set(e.employeeId!, {
            id: e.employeeId!,
            name: e.name ?? 'Employee',
            department: (e.department as string) ?? null,
            steps: [],
            writing: false,
          });
          return next;
        });
        break;
      case 'employee_completed':
        setActive((prev) => {
          const next = new Map(prev);
          next.delete(e.employeeId!);
          return next;
        });
        setDone((prev) => [
          {
            id: e.employeeId!,
            name: e.name ?? 'Employee',
            department: (e.department as string) ?? null,
            score: e.overallScore,
          },
          ...prev,
        ]);
        break;
      case 'employee_failed':
        setActive((prev) => {
          const next = new Map(prev);
          next.delete(e.employeeId!);
          return next;
        });
        setDone((prev) => [
          {
            id: e.employeeId!,
            name: e.name ?? 'Employee',
            department: (e.department as string) ?? null,
            failed: true,
          },
          ...prev,
        ]);
        break;
      case 'progress':
        setProgress({ completed: e.completed ?? 0, total: e.total ?? 0 });
        break;
      case 'error':
        if (e.message) toast.error(e.message);
        break;
      case 'final':
        if (!finishedRef.current) {
          finishedRef.current = true;
          onFinishedRef.current(e.status ?? 'COMPLETED');
        }
        break;
    }
  }, []);

  // Live stream with lossless resume after any disconnect.
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    (async () => {
      while (!stopped && !finishedRef.current) {
        try {
          await streamAppraisalRun(run.id, lastSeq.current, handleEvent, controller.signal);
          if (finishedRef.current) break;
          const fresh = await appraisalService.getRun(run.id);
          if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(fresh.status)) {
            finishedRef.current = true;
            onFinishedRef.current(fresh.status);
            break;
          }
        } catch {
          if (stopped || controller.signal.aborted) break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  useEffect(() => {
    const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [run.startedAt]);

  const phaseIndex = useMemo(() => Math.max(PHASES.findIndex((p) => p.key === phase), 0), [phase]);
  const activeList = useMemo(() => [...active.values()], [active]);
  const pct = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await appraisalService.cancelRun(run.id);
      toast.info('Stopping — finishing the current employee first…');
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to cancel');
      setCancelling(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header strip */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-primary">
              <Sparkles size={20} />
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-emerald-400" />
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">
                Your AI HR analyst is on it
              </div>
              <div className="text-xs text-slate-500">
                {run.periodLabel} · {progress.completed} of {progress.total || '…'} people reviewed
                · {checks} record checks · {Math.floor(elapsed / 60)}m {elapsed % 60}s
              </div>
            </div>
          </div>
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
          >
            <StopCircle size={14} /> {cancelling ? 'Stopping…' : 'Stop review'}
          </button>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <motion.div
            className="h-full rounded-full bg-brand-primary"
            animate={{ width: `${pct}%` }}
            transition={{ ease: 'easeOut', duration: 0.6 }}
          />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        {/* Journey timeline */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
            The journey
          </div>
          <ol className="space-y-1">
            {PHASES.map((p, i) => {
              const Icon = p.icon;
              const state = i < phaseIndex ? 'done' : i === phaseIndex ? 'active' : 'todo';
              return (
                <li
                  key={p.key}
                  className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm ${
                    state === 'active'
                      ? 'bg-brand-primary/5 font-medium text-brand-primary'
                      : state === 'done'
                        ? 'text-slate-500'
                        : 'text-slate-300'
                  }`}
                >
                  {state === 'done' ? (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 20 }}
                    >
                      <CheckCircle2 size={15} className="shrink-0 text-emerald-500" />
                    </motion.span>
                  ) : state === 'active' ? (
                    <Loader2 size={15} className="shrink-0 animate-spin" />
                  ) : (
                    <Icon size={15} className="shrink-0" />
                  )}
                  {p.label}
                </li>
              );
            })}
          </ol>
        </div>

        {/* Main stage */}
        <div className="flex min-h-[360px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50/80 to-white">
          {/* Narrator */}
          <div className="flex items-center gap-2.5 border-b border-slate-100 bg-white/70 px-5 py-3">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-primary/50" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-primary" />
            </span>
            <AnimatePresence mode="wait">
              <motion.p
                key={narrator}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25 }}
                className="text-sm font-medium text-slate-700"
              >
                {narrator}
              </motion.p>
            </AnimatePresence>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {/* Completed — rises to the top with a springy check */}
            {done.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-600">
                  <CheckCircle2 size={13} /> Reviewed ({done.length})
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <AnimatePresence initial={false}>
                    {done.map((emp) => (
                      <motion.div
                        key={emp.id}
                        layout
                        initial={{ opacity: 0, y: 24, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ type: 'spring', stiffness: 350, damping: 26 }}
                        className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 ${
                          emp.failed
                            ? 'border-amber-200 bg-amber-50/60'
                            : 'border-emerald-100 bg-emerald-50/50'
                        }`}
                      >
                        <motion.span
                          initial={{ scale: 0, rotate: -90 }}
                          animate={{ scale: 1, rotate: 0 }}
                          transition={{ type: 'spring', stiffness: 500, damping: 15, delay: 0.15 }}
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                            emp.failed ? 'bg-amber-100 text-amber-600' : 'bg-emerald-500 text-white'
                          }`}
                        >
                          {emp.failed ? <AlertCircle size={14} /> : <Check size={15} strokeWidth={3} />}
                        </motion.span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-semibold text-slate-800">{emp.name}</div>
                          <div className="truncate text-[11px] text-slate-400">{emp.department ?? '—'}</div>
                        </div>
                        {!emp.failed && typeof emp.score === 'number' && (
                          <motion.span
                            initial={{ opacity: 0, scale: 0.5 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: 0.3 }}
                            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold text-white ${scoreBg(emp.score)}`}
                          >
                            {emp.score}
                          </motion.span>
                        )}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {/* In progress — friendly step chips per person */}
            {activeList.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-primary">
                  <Loader2 size={13} className="animate-spin" /> Reviewing now
                </div>
                <div className="space-y-3">
                  <AnimatePresence initial={false}>
                    {activeList.map((emp) => (
                      <motion.div
                        key={emp.id}
                        layout
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="rounded-2xl border border-brand-primary/20 bg-white p-4 shadow-sm"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-bold text-brand-primary">
                            {emp.name.split(' ').map((s) => s[0]).slice(0, 2).join('')}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-slate-800">{emp.name}</div>
                            <div className="truncate text-xs text-slate-400">{emp.department ?? '—'}</div>
                          </div>
                          {emp.writing && (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-600">
                              <Brain size={12} className="animate-pulse" /> Writing insights…
                            </span>
                          )}
                        </div>
                        {emp.steps.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {emp.steps.map((s) => {
                              const Icon = s.icon;
                              return (
                                <motion.span
                                  key={s.key}
                                  initial={{ opacity: 0, scale: 0.8 }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                                    s.status === 'done'
                                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                      : 'border-sky-200 bg-sky-50 text-sky-600'
                                  }`}
                                >
                                  {s.status === 'done' ? (
                                    <motion.span
                                      initial={{ scale: 0 }}
                                      animate={{ scale: 1 }}
                                      transition={{ type: 'spring', stiffness: 600, damping: 18 }}
                                    >
                                      <Check size={11} strokeWidth={3} />
                                    </motion.span>
                                  ) : (
                                    <Loader2 size={11} className="animate-spin" />
                                  )}
                                  <Icon size={11} className="opacity-70" />
                                  {s.label}
                                </motion.span>
                              );
                            })}
                          </div>
                        )}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {/* Empty / thinking states */}
            {activeList.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
                {phaseIndex >= 4 ? (
                  <>
                    <motion.div
                      animate={{ scale: [1, 1.08, 1] }}
                      transition={{ repeat: Infinity, duration: 1.6 }}
                      className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-50 text-violet-500"
                    >
                      {phaseIndex === 5 ? <Trophy size={24} /> : <Brain size={24} />}
                    </motion.div>
                    <p className="max-w-sm text-sm text-slate-500">
                      All records reviewed. {NARRATOR_BY_PHASE[phase] ?? 'Finishing up…'}
                    </p>
                  </>
                ) : (
                  <>
                    <motion.div
                      animate={{ rotate: [0, 8, -8, 0] }}
                      transition={{ repeat: Infinity, duration: 2 }}
                      className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-primary/10 text-brand-primary"
                    >
                      <Search size={24} />
                    </motion.div>
                    <p className="max-w-sm text-sm text-slate-500">{narrator}</p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
