import type { HubDelta, HubTrendBucket, HubWindow } from './moduleHub';

/** `GET /talent/hub-summary`. */
export interface TalentHubSummary {
  window: HubWindow;
  grievances: TalentGrievances;
  training: TalentTraining;
  appraisal: TalentAppraisal;
  conduct: TalentConduct;
  trendKind: 'month';
  /** Twelve months; segments are `rewards|disciplines`. */
  trend: HubTrendBucket[];
}

export interface TalentGrievances {
  open: number;
  byStatus: Record<string, number>;
  /**
   * The one definition, published so the page cannot invent a second one. It
   * used to count four statuses that have never existed in the schema.
   */
  openStatuses: string[];
  agingDays: number;
  olderThanAgingDays: number;
  oldestOpenAt: string | null;
  unassignedOpen: number;
  raisedInWindow: number;
  resolvedInWindow: number;
  /** `null` when the event log has nothing to rewind. */
  openAsOfPrev: number | null;
  openDelta: HubDelta | null;
}

export interface TalentTraining {
  activeCourses: number;
  upcomingSessions30Days: number;
  sessionsByStatus: Record<string, number>;
  nominationsByStatus: Record<string, number>;
  /** `APPROVED + ATTENDED + NO_SHOW` — nominations that became an obligation. */
  obligations: number;
  attended: number;
  /** `null` when nothing was ever promised, never 0%. */
  completionRate: number | null;
  attendedInWindow: number;
  prevAttendedInWindow: number;
  attendedDelta: HubDelta | null;
  certificatesExpiring60: number;
  /** Sessions past their end date whose nominations still read `APPROVED`. */
  sessionsEndedUnrecorded: number;
}

export interface TalentAppraisalRun {
  id: string;
  status: string;
  periodLabel: string | null;
  periodStart: string;
  periodEnd: string;
  totalEmployees: number;
  completedEmployees: number;
  completedAt: string | null;
}

export interface TalentAppraisal {
  runsByStatus: Record<string, number>;
  runsCompleted: number;
  /**
   * The run in flight, else the last one that finished. `null` when no run has
   * ever been created — which is the state of every seeded database in this
   * repo today.
   */
  referenceRun: TalentAppraisalRun | null;
  /**
   * `null` when there is no run, AND when `totalEmployees` is 0 — a PENDING run
   * has not resolved its scope yet, so 0% would be a claim about work that has
   * not been measured rather than work not done.
   */
  completionRate: number | null;
  prevCompletionRate: number | null;
  completionDelta: HubDelta | null;
  /** `AppraisalResult.status` for the reference run. */
  resultsByStatus: Record<string, number>;
  failedOrDegraded: number;
}

export interface TalentConduct {
  rewardsCount: number;
  rewardsAmount: number;
  /**
   * Disciplinary ACTIONS recorded in the window, not open cases. `Discipline`
   * has no status, no openedAt and no closedAt — it is an immutable record, so
   * "active cases" is not a question this schema can answer.
   */
  disciplinesCount: number;
  disciplinesAmount: number;
  prevRewardsCount: number;
  prevDisciplinesCount: number;
  rewardsDelta: HubDelta | null;
  disciplinesDelta: HubDelta | null;
}
