export type AppraisalRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type AppraisalPeriodPreset =
  | 'LAST_MONTH'
  | 'LAST_QUARTER'
  | 'LAST_6_MONTHS'
  | 'LAST_YEAR'
  | 'CUSTOM';

export const SCORE_DIMENSIONS = [
  'attendance',
  'punctuality',
  'productivity',
  'taskCompletion',
  'projectContribution',
  'disciplineConsistency',
  'teamContribution',
] as const;

export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<ScoreDimension, string> = {
  attendance: 'Attendance',
  punctuality: 'Punctuality',
  productivity: 'Productivity',
  taskCompletion: 'Task Completion',
  projectContribution: 'Project Contribution',
  disciplineConsistency: 'Discipline & Consistency',
  teamContribution: 'Team Contribution',
};

export type ScoreSet = Partial<Record<ScoreDimension, number>> & { overall?: number };

export type Recommendation = 'PROMOTE' | 'REWARD' | 'MAINTAIN' | 'COACH' | 'PIP';

export interface AppraisalRunSummary {
  id: string;
  status: AppraisalRunStatus;
  periodStart: string;
  periodEnd: string;
  periodLabel: string | null;
  branchId: string | null;
  totalEmployees: number;
  completedEmployees: number;
  toolCallCount: number;
  currentPhase: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AppraisalResult {
  id: string;
  runId: string;
  employeeId: string | null;
  employeeCode: string;
  employeeName: string;
  position: string | null;
  departmentId: string | null;
  departmentName: string | null;
  scoresJson: ScoreSet | null;
  strengthsJson: string[] | null;
  improvementsJson: string[] | null;
  risksJson: string[] | null;
  summary: string | null;
  recommendation: Recommendation | null;
  rankOverall: number | null;
  rankDepartment: number | null;
  metricsJson: Record<string, unknown> | null;
  toolCallCount: number;
  status: 'PENDING' | 'COMPLETED' | 'DEGRADED' | 'FAILED';
  error: string | null;
}

export interface OrgInsights {
  departmentInsights?: Array<{ department: string; insight: string }>;
  organizationInsights?: string[];
  needsAttention?: string[];
  departmentAverages?: Array<{ department: string; avgScore: number; count: number }>;
}

export interface AppraisalRunDetail extends AppraisalRunSummary {
  executiveSummary: string | null;
  orgInsightsJson: OrgInsights | null;
  toolPlanJson: { source: 'ai' | 'default'; tools: Array<{ tool: string; reason?: string }> } | null;
  weightsJson: Record<string, number> | null;
  scopeJson: { departmentIds?: string[]; employeeIds?: string[] } | null;
  model: string | null;
  results: AppraisalResult[];
}

export type AppraisalStreamEventType =
  | 'phase'
  | 'log'
  | 'tool_call'
  | 'employee_started'
  | 'employee_completed'
  | 'employee_failed'
  | 'progress'
  | 'final'
  | 'error';

export interface AppraisalStreamEvent {
  seq: number;
  type: AppraisalStreamEventType;
  at: string;
  // type-specific fields
  phase?: string;
  label?: string;
  text?: string;
  tool?: string;
  ok?: boolean;
  durationMs?: number;
  resultSummary?: string;
  employeeId?: string;
  employeeName?: string;
  name?: string;
  department?: string | null;
  position?: string | null;
  overallScore?: number;
  recommendation?: string;
  degraded?: boolean;
  completed?: number;
  total?: number;
  status?: string;
  message?: string;
  error?: string;
  runId?: string;
}

export const RECOMMENDATION_STYLES: Record<
  Recommendation,
  { label: string; className: string }
> = {
  PROMOTE: { label: 'Promote', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  REWARD: { label: 'Reward', className: 'bg-sky-50 text-sky-700 border-sky-200' },
  MAINTAIN: { label: 'Maintain', className: 'bg-slate-50 text-slate-600 border-slate-200' },
  COACH: { label: 'Coach', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  PIP: { label: 'Needs Plan', className: 'bg-red-50 text-red-700 border-red-200' },
};

export function scoreColor(score: number): string {
  if (score >= 85) return 'text-emerald-600';
  if (score >= 70) return 'text-sky-600';
  if (score >= 55) return 'text-slate-600';
  if (score >= 40) return 'text-amber-600';
  return 'text-red-600';
}

export function scoreBg(score: number): string {
  if (score >= 85) return 'bg-emerald-500';
  if (score >= 70) return 'bg-sky-500';
  if (score >= 55) return 'bg-slate-400';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-red-500';
}
