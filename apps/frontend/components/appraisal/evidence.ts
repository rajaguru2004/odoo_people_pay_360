import { SCORE_DIMENSIONS, ScoreDimension } from '@/types/appraisal';

export interface EvidenceFact {
  text: string;
  tone: 'good' | 'bad' | 'neutral';
}

export type EvidenceMap = Record<ScoreDimension, EvidenceFact[]>;

const good = (text: string): EvidenceFact => ({ text, tone: 'good' });
const bad = (text: string): EvidenceFact => ({ text, tone: 'bad' });
const info = (text: string): EvidenceFact => ({ text, tone: 'neutral' });

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const plural = (v: number, word: string) => `${v} ${word}${v === 1 ? '' : 's'}`;

/**
 * Turns the raw data snapshot collected during the appraisal into plain-language,
 * per-dimension proof points a non-technical reader can verify. This is the
 * "why should I trust this score" layer — every number quoted comes straight
 * from the employee's own HR records for the period.
 */
export function buildEvidence(metrics: Record<string, any> | null | undefined): {
  byDimension: EvidenceMap;
  sources: number;
} {
  const byDimension = Object.fromEntries(
    SCORE_DIMENSIONS.map((d) => [d, [] as EvidenceFact[]]),
  ) as EvidenceMap;
  const m = metrics ?? {};
  const get = (tool: string): any => {
    const p = m[tool];
    return p && typeof p === 'object' && !p.truncated ? p : null;
  };

  // ── Attendance & punctuality ────────────────────────────────────────────
  const att = get('attendance_employee_summary');
  if (att) {
    const present = n(att.presentDays);
    const recorded = n(att.recordedDays);
    const rate = n(att.attendanceRate);
    if (present != null && recorded != null && recorded > 0) {
      byDimension.attendance.push(
        (rate ?? 100) >= 90
          ? good(`Present ${present} of ${recorded} recorded working days${rate != null ? ` (${rate}%)` : ''}`)
          : bad(`Present only ${present} of ${recorded} recorded working days${rate != null ? ` (${rate}%)` : ''}`),
      );
    }
    const absent = n(att.absentDays);
    if (absent != null && absent > 0) byDimension.attendance.push(bad(`${plural(absent, 'day')} marked absent`));
    else if (recorded) byDimension.attendance.push(good('No absences recorded'));
    const hours = n(att.totalWorkHours);
    if (hours != null && hours > 0) {
      byDimension.attendance.push(info(`${hours} hours worked in total${att.avgWorkHoursPerDay ? `, averaging ${att.avgWorkHoursPerDay}h a day` : ''}`));
    }

    const late = n(att.lateDays);
    if (late != null) {
      byDimension.punctuality.push(
        late === 0 ? good('No late arrivals in the whole period') : bad(`Arrived late on ${plural(late, 'day')}`),
      );
    }
    const early = n(att.earlyLeaveDays);
    if (early != null && early > 0) byDimension.punctuality.push(bad(`Left early on ${plural(early, 'day')}`));
    const punc = n(att.punctualityRate);
    if (punc != null) {
      byDimension.punctuality.push(
        punc >= 90 ? good(`On time ${punc}% of working days`) : info(`On time ${punc}% of working days`),
      );
    }
  }

  // ── Productivity (logged hours, timesheets, overtime) ──────────────────
  const worklog = get('worklog_employee_summary');
  if (worklog) {
    const hours = n(worklog.totalHoursLogged);
    const days = n(worklog.distinctDaysWithLogs);
    if (hours != null && hours > 0) {
      byDimension.productivity.push(
        good(`${hours} hours of work logged across ${plural(days ?? 0, 'day')}${worklog.avgHoursPerActiveDay ? ` (~${worklog.avgHoursPerActiveDay}h per active day)` : ''}`),
      );
    } else {
      byDimension.productivity.push(bad('No working hours logged against any task this period'));
    }
  }
  const timesheet = get('timesheet_employee_summary');
  if (timesheet) {
    const total = n(timesheet.totalEntries);
    if (total != null && total > 0) {
      const approved = n(timesheet.approvedEntries) ?? 0;
      byDimension.productivity.push(
        info(`${plural(total, 'timesheet entry').replace('entrys', 'entries')} filed, ${approved} approved${timesheet.approvalRate != null ? ` (${timesheet.approvalRate}% approval rate)` : ''}`),
      );
    } else {
      byDimension.productivity.push(bad('No timesheets filed this period'));
    }
  }
  const ot = get('overtime_employee_summary');
  if (ot) {
    const hours = n(ot.approvedHours);
    if (hours != null && hours > 0) {
      byDimension.productivity.push(good(`${hours} hours of approved overtime — extra effort beyond regular hours`));
    }
  }

  // ── Task completion ─────────────────────────────────────────────────────
  const tasks = get('task_employee_stats');
  if (tasks) {
    const total = n(tasks.totalTasks);
    const done = n(tasks.completedTasks);
    if (total != null && total > 0) {
      byDimension.taskCompletion.push(
        (n(tasks.completionRate) ?? 0) >= 70
          ? good(`Completed ${done} of ${plural(total, 'assigned task')} (${tasks.completionRate}%)`)
          : bad(`Completed only ${done} of ${plural(total, 'assigned task')}${tasks.completionRate != null ? ` (${tasks.completionRate}%)` : ''}`),
      );
      if (tasks.onTimeRate != null) {
        byDimension.taskCompletion.push(
          n(tasks.onTimeRate)! >= 70
            ? good(`${tasks.onTimeRate}% of completed work delivered on or before the deadline`)
            : bad(`Only ${tasks.onTimeRate}% of completed work delivered by the deadline`),
        );
      }
      const overdue = n(tasks.overdueOpenTasks);
      if (overdue != null && overdue > 0) byDimension.taskCompletion.push(bad(`${plural(overdue, 'task')} currently overdue`));
      const sp = n(tasks.storyPointsCompleted);
      if (sp != null && sp > 0) byDimension.taskCompletion.push(info(`${sp} story points of work delivered`));
      const hp = n(tasks.highPriorityCompleted);
      if (hp != null && hp > 0) byDimension.taskCompletion.push(good(`${plural(hp, 'high-priority task')} completed`));
    } else {
      byDimension.taskCompletion.push(info('No tasks were assigned during this period'));
    }
  }

  // ── Project contribution ────────────────────────────────────────────────
  const proj = get('project_contribution_get');
  if (proj) {
    const active = n(proj.activeInPeriod) ?? 0;
    const totalP = n(proj.totalProjects) ?? 0;
    if (totalP > 0) {
      byDimension.projectContribution.push(good(`Member of ${plural(totalP, 'project')}${active ? ` (${active} active this period)` : ''}`));
      const names = Array.isArray(proj.projects)
        ? proj.projects.slice(0, 4).map((p: any) => `${p.name}${p.role && p.role !== 'MEMBER' ? ` (${String(p.role).toLowerCase()})` : ''}`)
        : [];
      if (names.length) byDimension.projectContribution.push(info(`Projects: ${names.join(', ')}`));
      const lead = n(proj.leadRoles);
      if (lead != null && lead > 0) byDimension.projectContribution.push(good(`Holds ${plural(lead, 'leadership role')} in projects`));
      const owned = n(proj.ownedProjects);
      if (owned != null && owned > 0) byDimension.projectContribution.push(good(`Owns ${plural(owned, 'project')}`));
    } else {
      byDimension.projectContribution.push(bad('Not a member of any project this period'));
    }
  }

  // ── Discipline & consistency ────────────────────────────────────────────
  const conduct = get('conduct_records_get');
  if (conduct) {
    const rewards = n(conduct.rewardCount) ?? 0;
    const disc = n(conduct.disciplineCount) ?? 0;
    if (rewards > 0) byDimension.disciplineConsistency.push(good(`Earned ${plural(rewards, 'reward/recognition')} this period`));
    if (disc > 0) byDimension.disciplineConsistency.push(bad(`${plural(disc, 'disciplinary action')} on record`));
    if (rewards === 0 && disc === 0) byDimension.disciplineConsistency.push(good('Clean record — no disciplinary actions'));
  }
  const leave = get('leave_employee_summary');
  if (leave) {
    const days = n(leave.approvedDays) ?? 0;
    const reqs = n(leave.approvedRequests) ?? 0;
    if (reqs > 0) byDimension.disciplineConsistency.push(info(`Took ${plural(days, 'approved leave day')} across ${plural(reqs, 'request')}`));
    else byDimension.disciplineConsistency.push(info('No leave taken this period'));
    const rejected = n(leave.rejectedRequests);
    if (rejected != null && rejected > 0) byDimension.disciplineConsistency.push(bad(`${plural(rejected, 'leave request')} rejected`));
  }
  if (att) {
    const late = n(att.lateDays);
    if (late != null && late > 5) byDimension.disciplineConsistency.push(bad(`Frequent lateness (${late} late days) affects consistency`));
  }

  // ── Team contribution ───────────────────────────────────────────────────
  const team = get('team_membership_get');
  if (team) {
    const teams = Array.isArray(team.teams) ? team.teams : [];
    if (teams.length) {
      byDimension.teamContribution.push(
        good(`Active in ${plural(teams.length, 'team')}: ${teams.slice(0, 4).map((t: any) => t.team).join(', ')}`),
      );
      const lead = n(team.leadRoles);
      if (lead != null && lead > 0) byDimension.teamContribution.push(good(`Leads ${plural(lead, 'team')}`));
    } else {
      byDimension.teamContribution.push(bad('Not part of any team this period'));
    }
  }

  return { byDimension, sources: Object.keys(m).length };
}
