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

export type ScoreSet = Partial<Record<ScoreDimension, number>> & { overall?: number };

export type Weights = Record<ScoreDimension, number>;

export const RECOMMENDATIONS = ['PROMOTE', 'REWARD', 'MAINTAIN', 'COACH', 'PIP'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export interface RunPeriod {
  start: Date;
  end: Date;
  label: string;
}

export interface DiscoveredEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
  position: string | null;
  departmentId: string | null;
  departmentName: string | null;
  startDate: Date;
}

export interface PlannedTool {
  tool: string;
  reason?: string;
}

export interface ToolPlan {
  source: 'ai' | 'default';
  tools: PlannedTool[];
}

export interface EmployeeAnalysis {
  scores: ScoreSet;
  strengths: string[];
  improvements: string[];
  risks: string[];
  summary: string;
  recommendation: Recommendation;
  degraded: boolean;
}

/** SSE / persisted progress event. `payload` is event-type specific. */
export interface AppraisalStreamEvent {
  seq: number;
  type:
    | 'phase'
    | 'log'
    | 'tool_call'
    | 'employee_started'
    | 'employee_completed'
    | 'employee_failed'
    | 'progress'
    | 'final'
    | 'error';
  at: string;
  [key: string]: unknown;
}

export type RunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export const TERMINAL_STATUSES: RunStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
