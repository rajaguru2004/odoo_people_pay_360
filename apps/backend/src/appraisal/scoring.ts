import {
  Recommendation,
  SCORE_DIMENSIONS,
  ScoreDimension,
  ScoreSet,
  Weights,
} from './appraisal.types';

export const DEFAULT_WEIGHTS: Weights = {
  attendance: 0.15,
  punctuality: 0.1,
  productivity: 0.2,
  disciplineConsistency: 0.1,
  teamContribution: 0.1,
};

const clamp = (v: number, lo = 0, hi = 100): number =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * Reproducible baseline scores from the collected tool outputs (keyed by tool
 * name). Used to ground the LLM analysis and as the fallback when the LLM
 * response is unusable. Dimensions with no data stay undefined — the blender
 * fills them with a neutral 50.
 */
export function deterministicScores(collected: Record<string, any>): ScoreSet {
  const att = collected['attendance_employee_summary'];
  const timesheet = collected['timesheet_employee_summary'];
  const conduct = collected['conduct_records_get'];
  const teams = collected['team_membership_get'];
  const leave = collected['leave_employee_summary'];

  const scores: ScoreSet = {};

  if (att?.attendanceRate != null) scores.attendance = clamp(att.attendanceRate);
  if (att?.punctualityRate != null) scores.punctuality = clamp(att.punctualityRate);

  if (timesheet) {
    const parts: number[] = [];
    if (timesheet.approvalRate != null) parts.push(clamp(timesheet.approvalRate));
    if (timesheet.totalEntries === 0) parts.push(30);
    if (parts.length) {
      scores.productivity = clamp(parts.reduce((sum, v) => sum + v, 0) / parts.length);
    }
  }

  if (conduct || att || leave) {
    let base = 80;
    base += Math.min(20, (conduct?.rewardCount ?? 0) * 5);
    base -= (conduct?.disciplineCount ?? 0) * 20;
    base -= Math.min(20, (att?.lateDays ?? 0) * 2);
    base -= Math.min(10, (leave?.rejectedRequests ?? 0) * 5);
    scores.disciplineConsistency = clamp(base);
  }

  if (teams) {
    const count = teams.teams?.length ?? 0;
    scores.teamContribution = clamp(40 + count * 20 + (teams.leadRoles ?? 0) * 15);
  }

  return scores;
}

/** Blend LLM scores over the deterministic baseline; neutral 50 for gaps. */
export function blendScores(det: ScoreSet, llm: ScoreSet | null): ScoreSet {
  const out: ScoreSet = {};
  for (const dim of SCORE_DIMENSIONS) {
    const l = llm?.[dim];
    const d = det[dim];
    const v = typeof l === 'number' && Number.isFinite(l) ? l : d;
    out[dim] = clamp(typeof v === 'number' ? v : 50);
  }
  return out;
}

/** Weighted overall — weights renormalized over the dimensions present. */
export function computeOverall(scores: ScoreSet, weights: Weights): number {
  let sum = 0;
  let wsum = 0;
  for (const dim of SCORE_DIMENSIONS) {
    const v = scores[dim];
    if (typeof v !== 'number') continue;
    sum += v * weights[dim];
    wsum += weights[dim];
  }
  return wsum > 0 ? clamp(sum / wsum) : 50;
}

export function fallbackRecommendation(overall: number): Recommendation {
  if (overall >= 85) return 'PROMOTE';
  if (overall >= 70) return 'REWARD';
  if (overall >= 55) return 'MAINTAIN';
  if (overall >= 40) return 'COACH';
  return 'PIP';
}

export interface Rankable {
  employeeId: string | null;
  departmentId: string | null;
  overall: number;
}

/** Stable ranks: org-wide and within each department (1 = best). */
export function assignRanks<T extends Rankable>(
  results: T[],
): Map<string, { rankOverall: number; rankDepartment: number }> {
  const sorted = [...results].sort((a, b) => b.overall - a.overall);
  const ranks = new Map<string, { rankOverall: number; rankDepartment: number }>();
  const deptCounters = new Map<string, number>();
  sorted.forEach((r, i) => {
    const deptKey = r.departmentId ?? 'none';
    const deptRank = (deptCounters.get(deptKey) ?? 0) + 1;
    deptCounters.set(deptKey, deptRank);
    ranks.set(r.employeeId ?? `i${i}`, { rankOverall: i + 1, rankDepartment: deptRank });
  });
  return ranks;
}

export { clamp };
