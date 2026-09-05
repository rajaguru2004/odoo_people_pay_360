import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { ClearanceService } from '../assets/clearance.service';
import { LettersService } from '../letters/letters.service';
import { roundMoney } from '../common/utils/money.util';
import {
  buildSeriesBuckets,
  HUB_TREND_MONTHS,
  resolveMonthWindow,
  tallyByMonth,
  windowDelta,
} from '../common/utils/hub-window.util';

/**
 * One aggregate behind `/dashboard/workplace`.
 *
 * Three things this deliberately does NOT claim to know, because the schema
 * cannot support them:
 *  • an asset overdue for return. `AssetAssignment` has no `returnDueDate` or
 *    `expectedReturnAt` — custody has a start and an optional end and nothing
 *    in between. The outstanding-clearance report (an asset still held by
 *    somebody who has left) is the nearest real signal and is what the hub
 *    surfaces instead.
 *  • asset condition. `conditionOut`/`conditionIn` are unconstrained
 *    `VarChar(50)` and the seeds already write `'New'`, `'Good — minor wear'`
 *    and `'GOOD'`. Three vocabularies is not a dimension.
 *  • how long a rejected letter took. `LetterRequest` has `rejectedReason` but
 *    no `rejectedAt`; `updatedAt` moves on any later touch. Turnaround is
 *    reported for ISSUED only, and the panel says so.
 *
 * `AssetItem` and `LetterRequest` are both branch-scoped by the Prisma
 * extension, so every figure below narrows with the selected branch.
 */

/** The five real `AssetStatus` values. */
const ASSET_STATUSES = ['AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'LOST', 'RETIRED'] as const;

@Injectable()
export class WorkplaceHubService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
    private readonly clearance: ClearanceService,
    private readonly letters: LettersService,
  ) {}

  async getHubSummary() {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const window = resolveMonthWindow(now);

    const [assetSummary, letterStats, outstanding] = await Promise.all([
      this.assets.getSummary(),
      this.letters.stats(),
      this.clearance.getOutstandingForInactive(),
    ]);

    const [
      heldAsOfPrev,
      warranty,
      valueAtRisk,
      assignedInWindow,
      prevAssignedInWindow,
      returnedInWindow,
      letterFlow,
      prevLetterFlow,
      turnaround,
      byTemplate,
      trend,
    ] = await Promise.all([
      this.heldAsOf(window.previous.end),
      this.warrantyCounts(today),
      this.valueAtRisk(),
      this.assignedBetween(window.current.start, window.current.end),
      this.assignedBetween(window.previous.start, window.previous.end),
      this.returnedBetween(window.current.start, window.current.end),
      this.lettersBetween(window.current.start, window.current.end),
      this.lettersBetween(window.previous.start, window.previous.end),
      this.issueTurnaround(),
      this.lettersByTemplate(),
      this.letterTrend(now),
    ]);

    const assetByStatus: Record<string, number> = {};
    for (const s of ASSET_STATUSES) assetByStatus[s] = 0;
    for (const [status, count] of Object.entries(assetSummary.data.byStatus)) {
      assetByStatus[status] = count as number;
    }

    const needingAttention =
      assetByStatus['IN_REPAIR'] + assetByStatus['LOST'] + warranty.expired;

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

        assets: {
          total: assetSummary.data.total,
          byStatus: assetByStatus,
          held: assetSummary.data.held,
          heldAsOfPrev,
          heldDelta: windowDelta(assetSummary.data.held, heldAsOfPrev),
          unacknowledged: assetSummary.data.unacknowledged,
          warrantyExpired: warranty.expired,
          warrantyExpiring60: warranty.expiring60,
          // What the exceptions are worth, so "3 assets" can be read as a
          // number the business cares about rather than a count of objects.
          valueAtRisk,
          // The composite behind the "needs attention" card. Itemised so the
          // card's footnote can show what produced the number.
          needingAttention,
          assignedInWindow,
          prevAssignedInWindow,
          assignedDelta: windowDelta(assignedInWindow, prevAssignedInWindow),
          returnedInWindow,
        },

        clearances: {
          outstandingCount: outstanding.data.length,
          top: outstanding.data.slice(0, 8).map((r: any) => ({
            assignmentId: r.id,
            assetTag: r.asset?.assetTag ?? null,
            assetName: r.asset?.name ?? null,
            employeeName: r.employee?.fullName ?? null,
            employeeStatus: r.employee?.status ?? null,
            assignedAt: r.assignedAt,
          })),
        },

        letters: {
          pending: letterStats.data.pending,
          byStatus: letterStats.data.byStatus,
          byTemplate,
          oldestPendingAt: letterStats.data.oldestPendingAt,
          requestedInWindow: letterFlow.requested,
          // Deliberately computed on `issuedAt`, not `updatedAt` — the existing
          // `/letters/stats.issuedThisMonth` uses `updatedAt`, so an edit to an
          // already-issued letter re-counts it into the current month.
          issuedInWindow: letterFlow.issued,
          prevIssuedInWindow: prevLetterFlow.issued,
          issuedDelta: windowDelta(letterFlow.issued, prevLetterFlow.issued),
          avgIssueTurnaroundDays: turnaround,
          // No `rejectedAt` column exists, so rejection turnaround is not
          // measurable. Stated in the payload so the panel can say it.
          rejectTurnaroundMeasurable: false,
        },

        trendKind: 'month',
        trend,
      },
    };
  }

  /**
   * How many assets were with staff at a past instant.
   *
   * `AssetAssignment` is append-only — one row per custody period, never
   * updated in place — so custody at any date is an exact query rather than a
   * reconstruction: assigned on or before, and either still out or returned
   * after.
   */
  private heldAsOf(asOf: Date) {
    return this.prisma.assetAssignment.count({
      where: {
        assignedAt: { lt: asOf },
        OR: [{ returnedAt: null }, { returnedAt: { gte: asOf } }],
      },
    });
  }

  /** Warranties already gone, and the ones about to be. */
  private async warrantyCounts(today: Date) {
    const in60 = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
    const [expired, expiring60] = await Promise.all([
      this.prisma.assetItem.count({
        where: {
          warrantyExpiry: { lt: today },
          // A retired asset's lapsed warranty is not a worklist item.
          status: { notIn: ['RETIRED'] },
        },
      }),
      this.prisma.assetItem.count({
        where: {
          warrantyExpiry: { gte: today, lte: in60 },
          status: { notIn: ['RETIRED'] },
        },
      }),
    ]);
    return { expired, expiring60 };
  }

  /** Purchase cost of everything in repair or lost. Never aggregated before now. */
  private async valueAtRisk() {
    const sum = await this.prisma.assetItem.aggregate({
      where: { status: { in: ['IN_REPAIR', 'LOST'] } },
      _sum: { purchaseCost: true },
    });
    return roundMoney(Number(sum._sum.purchaseCost ?? 0));
  }

  private assignedBetween(start: Date, end: Date) {
    return this.prisma.assetAssignment.count({
      where: { assignedAt: { gte: start, lt: end } },
    });
  }

  private returnedBetween(start: Date, end: Date) {
    return this.prisma.assetAssignment.count({
      where: { returnedAt: { gte: start, lt: end } },
    });
  }

  private async lettersBetween(start: Date, end: Date) {
    const [requested, issued] = await Promise.all([
      this.prisma.letterRequest.count({ where: { createdAt: { gte: start, lt: end } } }),
      this.prisma.letterRequest.count({
        where: { status: 'ISSUED', issuedAt: { gte: start, lt: end } },
      }),
    ]);
    return { requested, issued };
  }

  /**
   * Average days from request to issue.
   *
   * `null` — not 0 — when nothing has ever been issued: a desk with no history
   * has no turnaround, and zero days would read as instant service.
   */
  private async issueTurnaround(): Promise<number | null> {
    const rows = await this.prisma.letterRequest.findMany({
      where: { status: 'ISSUED', issuedAt: { not: null } },
      select: { createdAt: true, issuedAt: true },
      orderBy: { issuedAt: 'desc' },
      // A year of letters is enough to characterise the desk; the whole table
      // is not, and an unbounded scan on a busy tenant is how a dashboard
      // becomes the slowest page in the product.
      take: 500,
    });
    if (!rows.length) return null;
    const totalDays = rows.reduce(
      (a, r) => a + (r.issuedAt!.getTime() - r.createdAt.getTime()) / 86400000,
      0,
    );
    return Math.round((totalDays / rows.length) * 10) / 10;
  }

  private async lettersByTemplate() {
    const grouped = await this.prisma.letterRequest.groupBy({
      by: ['templateKey'],
      _count: { _all: true },
    });
    return grouped
      .map((g) => ({ key: g.templateKey, count: g._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  /** Twelve months of the letter desk: what came in, what went out. */
  private async letterTrend(now: Date) {
    const buckets = buildSeriesBuckets(HUB_TREND_MONTHS, now).map((b) => ({
      ...b,
      requested: 0,
      issued: 0,
    }));
    if (!buckets.length) return [];

    const from = buckets[0].start;
    const to = buckets[buckets.length - 1].end;

    const [requested, issued] = await Promise.all([
      this.prisma.letterRequest.findMany({
        where: { createdAt: { gte: from, lt: to } },
        select: { createdAt: true },
      }),
      this.prisma.letterRequest.findMany({
        where: { status: 'ISSUED', issuedAt: { gte: from, lt: to } },
        select: { issuedAt: true },
      }),
    ]);

    tallyByMonth(
      buckets,
      requested.map((r) => ({ date: r.createdAt })),
      (b) => {
        b.requested += 1;
      },
    );
    tallyByMonth(
      buckets,
      issued.map((r) => ({ date: r.issuedAt })),
      (b) => {
        b.issued += 1;
      },
    );

    return buckets.map((b) => ({
      key: b.key,
      label: b.label,
      value: b.requested,
      segments: [
        { key: 'issued', value: b.issued },
        // What came in and has not gone out in the same month. Never negative:
        // a letter issued in March against a February request would otherwise
        // drive March's backlog below zero.
        { key: 'outstanding', value: Math.max(0, b.requested - b.issued) },
      ],
    }));
  }
}
