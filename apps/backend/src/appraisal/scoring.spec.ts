import {
  assignRanks,
  blendScores,
  computeOverall,
  DEFAULT_WEIGHTS,
  deterministicScores,
  fallbackRecommendation,
} from './scoring';

describe('appraisal scoring', () => {
  it('derives baseline scores from collected tool outputs', () => {
    const scores = deterministicScores({
      attendance_employee_summary: {
        attendanceRate: 96,
        punctualityRate: 88,
        lateDays: 2,
      },
      conduct_records_get: { rewardCount: 1, disciplineCount: 0 },
    });
    expect(scores.attendance).toBe(96);
    expect(scores.punctuality).toBe(88);
    expect(scores.disciplineConsistency).toBe(81); // 80 + 5 reward - 4 late
    expect(scores.productivity).toBeUndefined(); // no timesheet data
  });

  it('blends LLM scores over the baseline with neutral fill', () => {
    const blended = blendScores(
      { attendance: 90 },
      { attendance: 70, productivity: 120, punctuality: Number.NaN },
    );
    expect(blended.attendance).toBe(70); // LLM wins when finite
    expect(blended.productivity).toBe(100); // clamped
    expect(blended.punctuality).toBe(50); // NaN → baseline missing → neutral
    expect(blended.teamContribution).toBe(50); // untouched dimension → neutral
  });

  it('computes a weight-renormalized overall', () => {
    const overall = computeOverall({ attendance: 100, productivity: 50 }, DEFAULT_WEIGHTS);
    // (100*0.15 + 50*0.20) / 0.35 ≈ 71
    expect(overall).toBe(71);
  });

  it('assigns org and department ranks', () => {
    const ranks = assignRanks([
      { employeeId: 'a', departmentId: 'd1', overall: 90 },
      { employeeId: 'b', departmentId: 'd1', overall: 70 },
      { employeeId: 'c', departmentId: 'd2', overall: 80 },
    ]);
    expect(ranks.get('a')).toEqual({ rankOverall: 1, rankDepartment: 1 });
    expect(ranks.get('c')).toEqual({ rankOverall: 2, rankDepartment: 1 });
    expect(ranks.get('b')).toEqual({ rankOverall: 3, rankDepartment: 2 });
  });

  it('maps overall score bands to recommendations', () => {
    expect(fallbackRecommendation(90)).toBe('PROMOTE');
    expect(fallbackRecommendation(72)).toBe('REWARD');
    expect(fallbackRecommendation(60)).toBe('MAINTAIN');
    expect(fallbackRecommendation(45)).toBe('COACH');
    expect(fallbackRecommendation(20)).toBe('PIP');
  });
});
