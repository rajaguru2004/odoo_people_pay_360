import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { roundMoney } from '../common/utils/money.util';

/**
 * The event names a loan can post under.
 *
 * These are `LoanTransactionType` values plus the two states that are not
 * transactions — a loan being disbursed and a loan being settled at exit — so a
 * company maps what it recognises rather than what the enum happens to be
 * called.
 */
export const POSTABLE_EVENTS = [
  'DISBURSEMENT',
  'EMI_RECOVERY',
  'PREPAYMENT',
  'PROCESSING_FEE',
  'WAIVER',
  'WRITE_OFF',
  'SETTLEMENT',
  'ADJUSTMENT',
  'CONVERSION',
  'TOPUP_SETTLEMENT',
  'REVERSAL',
] as const;

export type PostableEvent = (typeof POSTABLE_EVENTS)[number];

/** Which slice of an event's money a mapping line carries. */
export const COMPONENTS = ['PRINCIPAL', 'INTEREST', 'FEE', 'TOTAL'] as const;
export type LedgerComponent = (typeof COMPONENTS)[number];

/**
 * Posting loan money to a general ledger.
 *
 * Gap report §1, the largest hole in the module: there was no accounting
 * anywhere, and `LoanTransaction.journalRef` was declared, indexed and written
 * by nothing. Catalogue §14 — receivable ledger, payroll liability, interest
 * income, write-off and settlement journals, rollback and duplicate handling —
 * was 0% testable because there was nothing to test.
 *
 * Three rules shape this service, and they are all about not being trusted with
 * money it does not own:
 *
 *  1. **Posting never moves loan money.** It reads `LoanTransaction` and writes
 *     journals. A posting failure must never change what a borrower owes, so
 *     nothing here touches a balance.
 *  2. **It is replayable.** `journal_entries (sourceType, sourceId, status)` is
 *     unique, so posting the same transaction twice loses on the index instead
 *     of duplicating the entry. That is the catalogue's "duplicate journal"
 *     case answered structurally rather than by a check-then-write.
 *  3. **An unmapped event is refused, never guessed.** A company that has not
 *     said which account "interest income" is gets a message naming the event,
 *     not a posting to an account somebody assumed.
 */
@Injectable()
export class JournalPostingService {
  private readonly logger = new Logger(JournalPostingService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * The accounts an event posts to, for one branch.
   *
   * Branch mapping first, company-wide second — the same shape as the loan
   * policy chain, so an administrator only has to learn one idea.
   */
  private async mappingsFor(event: string, branchId: string | null) {
    const rows = await this.prisma.ledgerMapping.findMany({
      where: {
        event,
        isActive: true,
        OR: [{ branchId: branchId ?? undefined }, { branchId: null }],
      },
      include: { debitAccount: true, creditAccount: true },
    });

    // One mapping per component, most specific wins.
    const byComponent = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const existing = byComponent.get(row.component);
      if (!existing || (row.branchId && !existing.branchId)) {
        byComponent.set(row.component, row);
      }
    }
    return byComponent;
  }

  /**
   * What each mapped component of this transaction is worth.
   *
   * TOTAL is the whole amount and is used when a company does not want the
   * split; otherwise each component posts to its own accounts, which is what
   * makes interest income separable from principal recovery.
   */
  private amountsFor(txn: {
    amount: unknown;
    principalComponent: unknown;
    interestComponent: unknown;
    feeComponent: unknown;
  }): Record<LedgerComponent, number> {
    return {
      TOTAL: roundMoney(Number(txn.amount)),
      PRINCIPAL: roundMoney(Number(txn.principalComponent)),
      INTEREST: roundMoney(Number(txn.interestComponent)),
      FEE: roundMoney(Number(txn.feeComponent)),
    };
  }

  /**
   * Post one loan transaction.
   *
   * Returns the entry, or the entry that already existed — posting twice is not
   * an error, it is a no-op, because a retry after a timeout must be safe.
   */
  async postLoanTransaction(
    transactionId: string,
    opts: { userId?: string | null } = {},
  ) {
    const txn = await this.prisma.loanTransaction.findUnique({
      where: { id: transactionId },
      include: {
        request: {
          select: {
            id: true,
            referenceNo: true,
            employee: { select: { branchId: true, fullName: true } },
          },
        },
      },
    });
    if (!txn) throw new NotFoundException('Loan transaction not found');

    const existing = await this.prisma.journalEntry.findFirst({
      where: {
        sourceType: 'LOAN_TRANSACTION',
        sourceId: transactionId,
        status: 'POSTED',
      },
      include: { lines: true },
    });
    if (existing) return { entry: existing, created: false };

    const branchId = txn.request.employee?.branchId ?? null;
    const mappings = await this.mappingsFor(txn.type, branchId);
    if (mappings.size === 0) {
      throw new BadRequestException(
        `No ledger mapping for ${txn.type}. Map it before posting, so the entry names accounts somebody chose rather than accounts we guessed.`,
      );
    }

    const amounts = this.amountsFor(txn);
    const lines = [...mappings.values()]
      .map((m) => ({
        debitAccountId: m.debitAccountId,
        creditAccountId: m.creditAccountId,
        component: m.component,
        amount: amounts[m.component as LedgerComponent] ?? 0,
        narration: `${txn.type} on ${txn.request.referenceNo ?? txn.requestId}`,
      }))
      // A zero line carries no information and clutters every report that
      // reads the journal — an interest-free loan should not post an empty
      // interest line every month.
      .filter((l) => l.amount > 0);

    if (lines.length === 0) {
      throw new BadRequestException(
        `${txn.type} on ${txn.request.referenceNo ?? txn.requestId} has nothing to post: every mapped component is zero.`,
      );
    }

    const reference = await this.nextReference(txn.transactionDate);

    try {
      const entry = await this.prisma.$transaction(async (tx) => {
        const created = await tx.journalEntry.create({
          data: {
            reference,
            entryDate: txn.transactionDate,
            narration: `${txn.type} — ${txn.request.employee?.fullName ?? ''}`.trim(),
            sourceType: 'LOAN_TRANSACTION',
            sourceId: transactionId,
            branchId,
            status: 'POSTED',
            postedById: opts.userId ?? null,
            lines: { create: lines },
          },
          include: { lines: true },
        });

        // The hook that has been in the schema since v2, finally written.
        await tx.loanTransaction.update({
          where: { id: transactionId },
          data: { journalRef: created.reference },
        });

        return created;
      });

      return { entry, created: true };
    } catch (err) {
      // Somebody else posted it between the read and the write. The unique
      // index is the arbiter; returning their entry is the correct answer.
      if ((err as { code?: string })?.code === 'P2002') {
        const raced = await this.prisma.journalEntry.findFirst({
          where: {
            sourceType: 'LOAN_TRANSACTION',
            sourceId: transactionId,
            status: 'POSTED',
          },
          include: { lines: true },
        });
        if (raced) return { entry: raced, created: false };
      }
      throw err;
    }
  }

  /**
   * Reverse a posting.
   *
   * A REVERSING ENTRY, never a delete: the original stays, the reversal swaps
   * every debit and credit, and both are visible. That matches the loan ledger
   * this feeds from, which is append-only for the same reason.
   */
  async reverseEntry(entryId: string, reason: string, userId?: string | null) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: true },
    });
    if (!entry) throw new NotFoundException('Journal entry not found');
    if (entry.status !== 'POSTED') {
      throw new BadRequestException('Only a posted entry can be reversed.');
    }

    const reference = await this.nextReference(new Date());

    return this.prisma.$transaction(async (tx) => {
      const reversal = await tx.journalEntry.create({
        data: {
          reference,
          entryDate: new Date(),
          narration: `Reversal of ${entry.reference}: ${reason}`,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          branchId: entry.branchId,
          status: 'REVERSAL',
          reversalOfId: entry.id,
          postedById: userId ?? null,
          lines: {
            create: entry.lines.map((l) => ({
              // Swapped: that is what a reversal IS.
              debitAccountId: l.creditAccountId,
              creditAccountId: l.debitAccountId,
              amount: l.amount,
              component: l.component,
              narration: `Reversal — ${l.narration ?? ''}`.trim(),
            })),
          },
        },
        include: { lines: true },
      });

      await tx.journalEntry.update({
        where: { id: entry.id },
        data: { status: 'REVERSED' },
      });

      // The source is postable again: `(sourceType, sourceId, status)` no
      // longer has a POSTED row for it, which is exactly what should happen
      // after a mistaken posting is undone.
      await tx.loanTransaction
        .updateMany({
          where: { id: entry.sourceId },
          data: { journalRef: null },
        })
        .catch(() => undefined);

      return reversal;
    });
  }

  /**
   * Post everything that has not been posted yet.
   *
   * The catalogue's rollback case in practice: a company whose mappings were
   * wrong fixes them and replays. Each transaction is independent, so one
   * unmappable event does not stop the rest — it is reported instead.
   */
  async postPending(opts: { limit?: number; userId?: string | null } = {}) {
    const pending = await this.prisma.loanTransaction.findMany({
      where: { journalRef: null, status: 'POSTED' },
      orderBy: { transactionDate: 'asc' },
      take: opts.limit ?? 200,
      select: { id: true },
    });

    let posted = 0;
    const failures: Array<{ transactionId: string; reason: string }> = [];
    for (const txn of pending) {
      try {
        const res = await this.postLoanTransaction(txn.id, { userId: opts.userId });
        if (res.created) posted += 1;
      } catch (err) {
        failures.push({
          transactionId: txn.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { considered: pending.length, posted, failures };
  }

  /**
   * `JE-YYYYMM-0001`, counted with a raw query so the branch middleware cannot
   * hand two branches the same number in one month.
   */
  private async nextReference(when: Date): Promise<string> {
    const period = `${when.getUTCFullYear()}${String(when.getUTCMonth() + 1).padStart(2, '0')}`;
    const stem = `JE-${period}-`;
    const [{ count }] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM journal_entries
      WHERE reference LIKE ${stem + '%'}
    `;
    return `${stem}${String(Number(count) + 1).padStart(4, '0')}`;
  }
}
