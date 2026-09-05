import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type CommitmentSource = 'TRAVEL' | 'TRAINING' | 'OVERTIME';

export interface CommitInput {
  sourceType: CommitmentSource;
  sourceId: string;
  amount: number | Prisma.Decimal;
  /** Whose budget line this consumes; falls back to the company-wide line. */
  departmentId?: string | null;
  /** BUDGET_CATEGORY label, e.g. 'Travel'. */
  category: string;
  branchId: string | null;
  /** Date the spend belongs to — picks the fiscal period. */
  onDate: Date;
}

/**
 * The commitment ledger.
 *
 * Approving a trip or a training consumes budget *before* the money is spent,
 * so Remaining is honest instead of lagging behind payroll.
 *
 *   Remaining = Planned − (OPEN commitments) − Actual
 *
 * The one subtlety worth being careful about: when the spend eventually lands in
 * actuals the commitment is REALIZED, not released. Releasing it would be wrong
 * in the opposite direction — the money would briefly count nowhere. Realizing
 * stops it counting as committed exactly as it starts counting as actual, so it
 * is subtracted once and only once.
 *
 * Budgeting NEVER blocks an approval. A missing budget or line logs a warning
 * and the request proceeds: an unconfigured budget must not be able to stop
 * travel being approved in production.
 */
@Injectable()
export class BudgetCommitmentService {
  private readonly logger = new Logger(BudgetCommitmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the line this spend consumes: the department's line for the
   * category, else the company-wide (departmentId = null) line for it.
   * Returns null when no ACTIVE budget covers the date, or no line matches.
   */
  private async resolveLine(input: CommitInput): Promise<string | null> {
    if (!input.branchId) return null;

    const budget = await this.prisma.budget.findFirst({
      where: {
        branchId: input.branchId,
        status: 'ACTIVE',
        startDate: { lte: input.onDate },
        endDate: { gte: input.onDate },
      },
      select: { id: true },
    });
    if (!budget) return null;

    const lines = await this.prisma.budgetLine.findMany({
      where: {
        budgetId: budget.id,
        category: input.category,
        OR: [
          ...(input.departmentId ? [{ departmentId: input.departmentId }] : []),
          { departmentId: null },
        ],
      },
      select: { id: true, departmentId: true },
    });
    if (lines.length === 0) return null;

    // Department-specific wins over the company-wide fallback.
    const specific = lines.find((l) => l.departmentId === input.departmentId);
    return (specific ?? lines.find((l) => l.departmentId === null))?.id ?? null;
  }

  /**
   * Record (or update) the commitment for an approved request.
   *
   * Idempotent on (sourceType, sourceId): re-approving, or a retried call,
   * updates the existing row rather than double-committing. A commitment that
   * was already REALIZED is left alone — the money is spent, and re-opening it
   * would double-count against actuals.
   */
  async commit(input: CommitInput): Promise<void> {
    try {
      const budgetLineId = await this.resolveLine(input);
      if (!budgetLineId) {
        this.logger.warn(
          `No budget line for ${input.sourceType} ${input.sourceId} ` +
            `(category=${input.category}, department=${input.departmentId ?? 'n/a'}) — approval proceeds uncommitted`,
        );
        return;
      }

      const existing = await this.prisma.budgetCommitment.findUnique({
        where: {
          sourceType_sourceId: {
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
        },
        select: { id: true, status: true },
      });

      if (existing?.status === 'REALIZED') return;

      if (existing) {
        await this.prisma.budgetCommitment.update({
          where: { id: existing.id },
          data: {
            budgetLineId,
            amount: input.amount as any,
            status: 'OPEN',
            resolvedAt: null,
            resolvedNote: null,
          },
        });
        return;
      }

      await this.prisma.budgetCommitment.create({
        data: {
          budgetLineId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          amount: input.amount as any,
          status: 'OPEN',
        },
      });
    } catch (e: any) {
      // Budgeting is observational. It must never be the reason an approval fails.
      this.logger.error(
        `Budget commit failed for ${input.sourceType} ${input.sourceId}: ${e?.message ?? e}`,
      );
    }
  }

  /** The request was rejected or cancelled — the money was never going to be spent. */
  async release(
    sourceType: CommitmentSource,
    sourceId: string,
    note?: string,
  ): Promise<void> {
    try {
      await this.prisma.budgetCommitment.updateMany({
        where: { sourceType, sourceId, status: 'OPEN' },
        data: {
          status: 'RELEASED',
          resolvedAt: new Date(),
          resolvedNote: note ?? null,
        },
      });
    } catch (e: any) {
      this.logger.error(
        `Budget release failed for ${sourceType} ${sourceId}: ${e?.message ?? e}`,
      );
    }
  }

  /**
   * The spend has landed in actuals. Stop counting it as committed — the actuals
   * side now accounts for it.
   */
  async realize(
    sourceType: CommitmentSource,
    sourceId: string,
    note?: string,
  ): Promise<void> {
    try {
      await this.prisma.budgetCommitment.updateMany({
        where: { sourceType, sourceId, status: 'OPEN' },
        data: {
          status: 'REALIZED',
          resolvedAt: new Date(),
          resolvedNote: note ?? null,
        },
      });
    } catch (e: any) {
      this.logger.error(
        `Budget realize failed for ${sourceType} ${sourceId}: ${e?.message ?? e}`,
      );
    }
  }

  /**
   * Realize many at once — used by `lockPayroll`, where a whole run's worth of
   * travel/training claims become actual in one step.
   */
  async realizeMany(
    keys: Array<{ sourceType: CommitmentSource; sourceId: string }>,
    note?: string,
  ): Promise<number> {
    if (keys.length === 0) return 0;
    try {
      const result = await this.prisma.budgetCommitment.updateMany({
        where: {
          status: 'OPEN',
          OR: keys.map((k) => ({
            sourceType: k.sourceType,
            sourceId: k.sourceId,
          })),
        },
        data: {
          status: 'REALIZED',
          resolvedAt: new Date(),
          resolvedNote: note ?? null,
        },
      });
      return result.count;
    } catch (e: any) {
      this.logger.error(`Bulk budget realize failed: ${e?.message ?? e}`);
      return 0;
    }
  }

  /** Open commitments per budget line, for the variance report. */
  async openByLine(budgetLineIds: string[]): Promise<Map<string, number>> {
    if (budgetLineIds.length === 0) return new Map();
    const rows = await this.prisma.budgetCommitment.groupBy({
      by: ['budgetLineId'],
      where: { budgetLineId: { in: budgetLineIds }, status: 'OPEN' },
      _sum: { amount: true },
    });
    return new Map(rows.map((r) => [r.budgetLineId, Number(r._sum.amount ?? 0)]));
  }
}
