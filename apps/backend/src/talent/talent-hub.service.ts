import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  GRIEVANCE_AGING_DAYS,
  GrievancesService,
  OPEN_GRIEVANCE_STATUSES,
} from '../grievances/grievances.service';
import { TrainingService } from '../training/training.service';
import { AppraisalService } from '../appraisal/appraisal.service';
import { roundMoney } from '../common/utils/money.util';
import {
  buildSeriesBuckets,
  HUB_TREND_MONTHS,
  pct,
  resolveMonthWindow,
  tallyByMonth,
  windowDelta,
} from '../common/utils/hub-window.util';

/**
 * One aggregate behind `/dashboard/talent`.
 *
 * The hub it replaces counted rewards and disciplinary actions IN THE BROWSER,
 * over one page of each list, and rendered a panel telling the reader so
 * (`app/dashboard/talent/page.tsx:168-173`). That panel was honest about a
 * number that should never have been approximate: `Reward.rewardDate` and
 * `Discipline.disciplineDate` are real columns, and neither table had a stats
 * endpoint or a date filter on `findAll` to reach them with. That is what the
 * `conduct` block here closes.
 *
 * What this module does NOT have, and therefore does not pretend to measure:
 *  • a discipline CASE. `Discipline` has no status, no openedAt, no closedAt —
 *    it is an immutable record of an action taken. "Active cases" is not a
 *    question the schema can answer, so the hub counts actions in a period.
 *  • an appraisal CYCLE. `AppraisalRun` is an AI batch job with a scope, not a
 *    manager-writes-a-review workflow. Completion is meaningful within a run
 *    and nowhere else.
 *  • a due date, anywhere. The only genuine expiry in the domain is
 *    `TrainingNomination.certificateExpiry`.
 */

/**
 * A nomination that became an obligation.
 *
 * `PENDING` was never approved, `REJECTED` and `CANCELLED` were called off — so
 * none of them is a training the organisation promised and failed to deliver.
 * Putting them in the denominator would make a well-run programme that declines
 * a lot of requests look like a failing one.
 */
const TRAINING_OBLIGATION_STATUSES = ['APPROVED', 'ATTENDED', 'NO_SHOW'] as const;

@Injectable()
export class TalentHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grievances: GrievancesService,
    private readonly training: TrainingService,
    private readonly appraisal: AppraisalService,
  ) {}

  async getHubSummary() {
    const now = new Date();
    const window = resolveMonthWindow(now);

    const [grievanceStats, trainingStats, appraisalStats] = await Promise.all([
      this.grievances.stats(),
      this.training.stats(),
      this.appraisal.stats(),
    ]);

    const [
      grievanceFlow,
      openAsOfPrev,
      unassignedOpen,
      attended,
      prevAttended,
      certificatesExpiring60,
      sessionsEndedUnrecorded,
      conduct,
      prevConduct,
      trend,
      appraisalDetail,
    ] = await Promise.all([
      this.grievanceFlow(window.current.start, window.current.end),
      this.openGrievancesAsOf(window.previous.end),
      this.prisma.grievance.count({
        where: { status: 'OPEN', assignedToId: null },
      }),
      this.attendedInWindow(window.current.start, window.current.end),
      this.attendedInWindow(window.previous.start, window.previous.end),
      this.certificatesExpiring(now, 60),
      this.sessionsEndedUnrecorded(now),
      this.conductInWindow(window.current.start, window.current.end),
      this.conductInWindow(window.previous.start, window.previous.end),
      this.conductTrend(now),
      this.appraisalDetail(appraisalStats.data),
    ]);

    const nominations = trainingStats.data.nominationsByStatus as Record<string, number>;
    const obligations = TRAINING_OBLIGATION_STATUSES.reduce(
      (a, s) => a + (nominations[s] ?? 0),
      0,
    );
    const trainingCompletionRate = pct(nominations['ATTENDED'] ?? 0, obligations);

    const grievanceCounts = grievanceStats.data.byStatus as Record<string, number>;

    return {
      success: true,
      data: {
        window: {
          key: window.current.key,
          label: window.current.label,
          start: window.current.start,
          end: window.current.end,
          previous: {
            key: window.previous.key,
            label: window.previous.label,
            start: window.previous.start,
            end: window.previous.end,
          },
        },

        grievances: {
          open: grievanceStats.data.open,
          byStatus: grievanceCounts,
          openStatuses: [...OPEN_GRIEVANCE_STATUSES],
          agingDays: GRIEVANCE_AGING_DAYS,
          olderThanAgingDays: grievanceStats.data.olderThan14Days,
          oldestOpenAt: grievanceStats.data.oldestOpenAt,
          unassignedOpen,
          raisedInWindow: grievanceFlow.raised,
          resolvedInWindow: grievanceFlow.resolved,
          openAsOfPrev,
          openDelta: windowDelta(grievanceStats.data.open, openAsOfPrev),
        },

        training: {
          activeCourses: trainingStats.data.activeCourses,
          upcomingSessions30Days: trainingStats.data.upcomingSessions30Days,
          sessionsByStatus: trainingStats.data.sessionsByStatus,
          nominationsByStatus: nominations,
          obligations,
          attended: nominations['ATTENDED'] ?? 0,
          completionRate: trainingCompletionRate,
          attendedInWindow: attended,
          prevAttendedInWindow: prevAttended,
          attendedDelta: windowDelta(attended, prevAttended),
          certificatesExpiring60,
          sessionsEndedUnrecorded,
        },

        appraisal: appraisalDetail,

        conduct: {
          rewardsCount: conduct.rewards.count,
          rewardsAmount: conduct.rewards.amount,
          disciplinesCount: conduct.disciplines.count,
          disciplinesAmount: conduct.disciplines.amount,
          prevRewardsCount: prevConduct.rewards.count,
          prevDisciplinesCount: prevConduct.disciplines.count,
          rewardsDelta: windowDelta(conduct.rewards.count, prevConduct.rewards.count),
          disciplinesDelta: windowDelta(
            conduct.disciplines.count,
            prevConduct.disciplines.count,
          ),
        },

        trendKind: 'month',
        trend,
      },
    };
  }

  /** Raised and resolved inside the window — the two ends of the queue. */
  private async grievanceFlow(start: Date, end: Date) {
    const [raised, resolved] = await Promise.all([
      this.prisma.grievance.count({ where: { createdAt: { gte: start, lt: end } } }),
      this.prisma.grievance.count({ where: { resolvedAt: { gte: start, lt: end } } }),
    ]);
    return { raised, resolved };
  }

  /**
   * How many grievances were open at a past instant.
   *
   * Reconstructed from `GrievanceEvent`, which records every `STATUS_CHANGE`
   * with both its `fromStatus` and its `toStatus`: take today's status and undo
   * every transition that has happened since. That is exact, unlike counting
   * `createdAt < asOf`, which would report a grievance opened and closed inside
   * the window as still open.
   *
   * `null` when the event log holds nothing at all — an unknown baseline draws
   * no delta badge rather than a fabricated one.
   */
  private async openGrievancesAsOf(asOf: Date): Promise<number | null> {
    const [current, transitions, anyEvent] = await Promise.all([
      this.prisma.grievance.findMany({
        where: { createdAt: { lt: asOf } },
        select: { id: true, status: true },
      }),
      this.prisma.grievanceEvent.findMany({
        where: { type: 'STATUS_CHANGE', createdAt: { gte: asOf } },
        select: { grievanceId: true, fromStatus: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.grievanceEvent.count({ where: { createdAt: { lt: asOf } } }),
    ]);

    if (!current.length && !anyEvent) return null;

    // The EARLIEST transition after the baseline carries the status the
    // grievance held at the baseline.
    const statusAt = new Map(current.map((g) => [g.id, g.status]));
    const rewound = new Set<string>();
    for (const t of transitions) {
      if (rewound.has(t.grievanceId) || !t.fromStatus) continue;
      if (!statusAt.has(t.grievanceId)) continue;
      statusAt.set(t.grievanceId, t.fromStatus);
      rewound.add(t.grievanceId);
    }

    const open = new Set<string>(OPEN_GRIEVANCE_STATUSES);
    let count = 0;
    for (const status of statusAt.values()) if (open.has(status)) count += 1;
    return count;
  }

  /** Nominations marked attended inside the window. */
  private attendedInWindow(start: Date, end: Date) {
    return this.prisma.trainingNomination.count({
      where: { status: 'ATTENDED', attendedAt: { gte: start, lt: end } },
    });
  }

  /** Certificates about to lapse. The reminder engine already watches this column. */
  private certificatesExpiring(now: Date, days: number) {
    const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return this.prisma.trainingNomination.count({
      where: { certificateExpiry: { gte: now, lte: until } },
    });
  }

  /**
   * Training that happened and was never written down.
   *
   * A session whose end date has passed while its nominations still read
   * `APPROVED` means nobody recorded attendance. It is the closest thing the
   * module has to an overdue item, and unlike a real due date it is a fact
   * about a record rather than an inference about intent.
   */
  private sessionsEndedUnrecorded(now: Date) {
    return this.prisma.trainingNomination.count({
      where: { status: 'APPROVED', session: { endDate: { lt: now } } },
    });
  }

  /** Rewards and disciplinary actions recorded in a window, with their money. */
  private async conductInWindow(start: Date, end: Date) {
    const [rewards, disciplines] = await Promise.all([
      this.prisma.reward.aggregate({
        where: { rewardDate: { gte: start, lt: end } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.discipline.aggregate({
        where: { disciplineDate: { gte: start, lt: end } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);
    return {
      rewards: {
        count: rewards._count._all,
        amount: roundMoney(Number(rewards._sum.amount ?? 0)),
      },
      disciplines: {
        count: disciplines._count._all,
        amount: roundMoney(Number(disciplines._sum.amount ?? 0)),
      },
    };
  }

  /** Twelve months of recognition against correction. */
  private async conductTrend(now: Date) {
    const buckets = buildSeriesBuckets(HUB_TREND_MONTHS, now).map((b) => ({
      ...b,
      rewards: 0,
      disciplines: 0,
    }));
    if (!buckets.length) return [];

    const from = buckets[0].start;
    const to = buckets[buckets.length - 1].end;

    const [rewards, disciplines] = await Promise.all([
      this.prisma.reward.findMany({
        where: { rewardDate: { gte: from, lt: to } },
        select: { rewardDate: true },
      }),
      this.prisma.discipline.findMany({
        where: { disciplineDate: { gte: from, lt: to } },
        select: { disciplineDate: true },
      }),
    ]);

    tallyByMonth(
      buckets,
      rewards.map((r) => ({ date: r.rewardDate })),
      (b) => {
        b.rewards += 1;
      },
    );
    tallyByMonth(
      buckets,
      disciplines.map((d) => ({ date: d.disciplineDate })),
      (b) => {
        b.disciplines += 1;
      },
    );

    return buckets.map((b) => ({
      key: b.key,
      label: b.label,
      value: b.rewards + b.disciplines,
      segments: [
        { key: 'rewards', value: b.rewards },
        { key: 'disciplines', value: b.disciplines },
      ],
    }));
  }

  /**
   * Appraisal progress, expressed against the run it belongs to.
   *
   * The reference run is whatever is in flight, else the last one that
   * finished. `completionRate` is `null` — not `0` — when there is no run, and
   * when `totalEmployees` is 0: the orchestrator only writes that column once
   * it has resolved the run's scope, so a `PENDING` run genuinely does not yet
   * know how many people it is appraising, and printing 0 % would be a claim
   * about work that has not been measured rather than work not done.
   */
  private async appraisalDetail(stats: {
    byStatus: Record<string, number>;
    completed: number;
    activeRun: any;
    lastCompletedRun: any;
  }) {
    const reference = await this.prisma.appraisalRun.findFirst({
      where: stats.activeRun
        ? { id: stats.activeRun.id }
        : { status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        periodLabel: true,
        periodStart: true,
        periodEnd: true,
        totalEmployees: true,
        completedEmployees: true,
        completedAt: true,
        createdAt: true,
      },
    });

    if (!reference) {
      return {
        runsByStatus: stats.byStatus,
        runsCompleted: stats.completed,
        referenceRun: null,
        completionRate: null,
        prevCompletionRate: null,
        completionDelta: null,
        resultsByStatus: {},
        failedOrDegraded: 0,
      };
    }

    const [resultsByStatus, previous] = await Promise.all([
      this.prisma.appraisalResult.groupBy({
        by: ['status'],
        where: { runId: reference.id },
        _count: { _all: true },
      }),
      this.prisma.appraisalRun.findFirst({
        where: { status: 'COMPLETED', id: { not: reference.id }, createdAt: { lt: reference.createdAt } },
        orderBy: { createdAt: 'desc' },
        select: { totalEmployees: true, completedEmployees: true },
      }),
    ]);

    const results = Object.fromEntries(resultsByStatus.map((r) => [r.status, r._count._all]));
    const completionRate = pct(reference.completedEmployees, reference.totalEmployees);
    const prevCompletionRate = previous
      ? pct(previous.completedEmployees, previous.totalEmployees)
      : null;

    return {
      runsByStatus: stats.byStatus,
      runsCompleted: stats.completed,
      referenceRun: {
        id: reference.id,
        status: reference.status,
        periodLabel: reference.periodLabel,
        periodStart: reference.periodStart,
        periodEnd: reference.periodEnd,
        totalEmployees: reference.totalEmployees,
        completedEmployees: reference.completedEmployees,
        completedAt: reference.completedAt,
      },
      completionRate,
      prevCompletionRate,
      completionDelta:
        completionRate !== null && prevCompletionRate !== null
          ? {
              value: Math.round((completionRate - prevCompletionRate) * 10) / 10,
              direction:
                completionRate >= prevCompletionRate ? ('up' as const) : ('down' as const),
              absolute: Math.round((completionRate - prevCompletionRate) * 10) / 10,
            }
          : null,
      resultsByStatus: results,
      failedOrDegraded: (results['FAILED'] ?? 0) + (results['DEGRADED'] ?? 0),
    };
  }
}
