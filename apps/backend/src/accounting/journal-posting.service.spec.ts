import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JournalPostingService } from './journal-posting.service';

/**
 * Posting rules, in isolation.
 *
 * Three of them are the whole reason this service can be trusted with a
 * company's ledger, and each is asserted here rather than inferred:
 *
 *  1. Posting twice is a no-op, not a second entry.
 *  2. An unmapped event is refused with the event named, never guessed.
 *  3. A reversal SWAPS the sides and leaves the original standing.
 */
describe('JournalPostingService', () => {
  let entries: any[];
  let lines: any[];
  let mappings: any[];
  let transactions: any[];
  let service: JournalPostingService;

  const account = (id: string) => ({ id, code: id, name: id, type: 'ASSET' });

  const prisma: any = {
    loanTransaction: {
      findUnique: jest.fn(async ({ where }: any) =>
        transactions.find((t) => t.id === where.id) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const t = transactions.find((x) => x.id === where.id);
        if (t) Object.assign(t, data);
        return t;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const t = transactions.find((x) => x.id === where.id);
        if (t) Object.assign(t, data);
        return { count: t ? 1 : 0 };
      }),
      findMany: jest.fn(async () => transactions.filter((t) => !t.journalRef)),
    },
    ledgerMapping: {
      findMany: jest.fn(async ({ where }: any) =>
        mappings.filter((m) => m.event === where.event && m.isActive),
      ),
    },
    journalEntry: {
      findFirst: jest.fn(async ({ where }: any) =>
        entries.find(
          (e) =>
            e.sourceType === where.sourceType &&
            e.sourceId === where.sourceId &&
            e.status === where.status,
        ) ?? null,
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        entries.find((e) => e.id === where.id) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        // The unique (sourceType, sourceId, status), modelled.
        if (
          entries.some(
            (e) =>
              e.sourceType === data.sourceType &&
              e.sourceId === data.sourceId &&
              e.status === data.status,
          )
        ) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const created = {
          id: `je-${entries.length + 1}`,
          ...data,
          lines: (data.lines?.create ?? []).map((l: any, i: number) => ({
            id: `jl-${entries.length + 1}-${i}`,
            ...l,
          })),
        };
        entries.push(created);
        lines.push(...created.lines);
        return created;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const e = entries.find((x) => x.id === where.id);
        if (e) Object.assign(e, data);
        return e;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn(async () => [{ count: BigInt(entries.length) }]),
  };

  const txn = (over: Record<string, unknown> = {}) => ({
    id: 'txn-1',
    requestId: 'req-1',
    type: 'EMI_RECOVERY',
    status: 'POSTED',
    transactionDate: new Date('2026-08-31'),
    amount: 206,
    principalComponent: 200,
    interestComponent: 6,
    feeComponent: 0,
    journalRef: null,
    request: {
      id: 'req-1',
      referenceNo: 'LN-202608-0001',
      employee: { branchId: null, fullName: 'Ada Lovelace' },
    },
    ...over,
  });

  const mapping = (over: Record<string, unknown> = {}) => ({
    id: `map-${mappings.length + 1}`,
    event: 'EMI_RECOVERY',
    component: 'TOTAL',
    branchId: null,
    isActive: true,
    debitAccountId: 'acc-bank',
    creditAccountId: 'acc-receivable',
    debitAccount: account('acc-bank'),
    creditAccount: account('acc-receivable'),
    ...over,
  });

  beforeEach(() => {
    entries = [];
    lines = [];
    mappings = [];
    transactions = [txn()];
    jest.clearAllMocks();
    service = new JournalPostingService(prisma);
  });

  describe('posting', () => {
    it('writes one entry and stamps the reference back onto the transaction', async () => {
      // `journalRef` has been in the schema since v2 with nothing writing it.
      mappings.push(mapping());

      const res = await service.postLoanTransaction('txn-1');

      expect(res.created).toBe(true);
      expect(entries).toHaveLength(1);
      expect(transactions[0].journalRef).toBe(entries[0].reference);
    });

    it('numbers entries JE-YYYYMM-NNNN from the transaction date', async () => {
      mappings.push(mapping());
      await service.postLoanTransaction('txn-1');
      expect(entries[0].reference).toMatch(/^JE-202608-\d{4}$/);
    });

    it('posting the same transaction twice creates nothing new', async () => {
      mappings.push(mapping());
      const first = await service.postLoanTransaction('txn-1');
      const second = await service.postLoanTransaction('txn-1');

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(entries).toHaveLength(1);
    });

    it('returns the winner’s entry when two posts race', async () => {
      // The unique index is the arbiter; the loser must return the entry that
      // exists rather than raise.
      mappings.push(mapping());
      prisma.journalEntry.findFirst.mockResolvedValueOnce(null);
      await service.postLoanTransaction('txn-1');

      prisma.journalEntry.findFirst.mockResolvedValueOnce(null);
      const raced = await service.postLoanTransaction('txn-1');

      expect(raced.created).toBe(false);
      expect(entries).toHaveLength(1);
    });

    it('refuses an unmapped event, naming it', async () => {
      await expect(service.postLoanTransaction('txn-1')).rejects.toThrow(
        /No ledger mapping for EMI_RECOVERY/,
      );
    });

    it('404s on a transaction that does not exist', async () => {
      await expect(service.postLoanTransaction('nope')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('the split', () => {
    it('posts each mapped component to its own accounts', async () => {
      // What makes interest income separable from principal recovery.
      mappings.push(
        mapping({ component: 'PRINCIPAL', creditAccountId: 'acc-receivable' }),
        mapping({ component: 'INTEREST', creditAccountId: 'acc-interest-income' }),
      );

      const res = await service.postLoanTransaction('txn-1');
      const byComponent = Object.fromEntries(
        res.entry.lines.map((l: any) => [l.component, l.amount]),
      );

      expect(byComponent.PRINCIPAL).toBe(200);
      expect(byComponent.INTEREST).toBe(6);
    });

    it('drops a component worth nothing', async () => {
      // An interest-free loan should not post an empty interest line every
      // month, cluttering every report that reads the journal.
      mappings.push(
        mapping({ component: 'PRINCIPAL' }),
        mapping({ component: 'FEE' }),
      );

      const res = await service.postLoanTransaction('txn-1');

      expect(res.entry.lines).toHaveLength(1);
      expect(res.entry.lines[0].component).toBe('PRINCIPAL');
    });

    it('refuses when every mapped component is zero', async () => {
      mappings.push(mapping({ component: 'FEE' }));

      await expect(service.postLoanTransaction('txn-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('prefers a branch mapping over the company-wide one', async () => {
      transactions[0].request.employee.branchId = 'br-1';
      mappings.push(
        mapping({ branchId: null, debitAccountId: 'acc-global' }),
        mapping({ branchId: 'br-1', debitAccountId: 'acc-branch' }),
      );

      const res = await service.postLoanTransaction('txn-1');
      expect(res.entry.lines[0].debitAccountId).toBe('acc-branch');
    });
  });

  describe('reversal', () => {
    it('swaps the sides and leaves the original standing', async () => {
      mappings.push(mapping());
      const posted = await service.postLoanTransaction('txn-1');
      const original = posted.entry;

      const reversal = await service.reverseEntry(original.id, 'Posted to the wrong period');

      expect(reversal.lines[0].debitAccountId).toBe(original.lines[0].creditAccountId);
      expect(reversal.lines[0].creditAccountId).toBe(original.lines[0].debitAccountId);
      expect(entries).toHaveLength(2);
      expect(entries.find((e) => e.id === original.id).status).toBe('REVERSED');
    });

    it('makes the source postable again', async () => {
      // A mistaken posting undone must be re-postable, or a fixed mapping
      // could never be applied.
      mappings.push(mapping());
      const posted = await service.postLoanTransaction('txn-1');
      await service.reverseEntry(posted.entry.id, 'Wrong account');

      expect(transactions[0].journalRef).toBeNull();
    });

    it('refuses to reverse an entry that is not posted', async () => {
      mappings.push(mapping());
      const posted = await service.postLoanTransaction('txn-1');
      await service.reverseEntry(posted.entry.id, 'First reversal');

      await expect(
        service.reverseEntry(posted.entry.id, 'Second reversal'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('replaying', () => {
    it('reports what could not be posted instead of stopping', async () => {
      // A company that fixes a mapping replays; one unmappable event must not
      // block every other posting in the queue.
      transactions = [txn(), txn({ id: 'txn-2', type: 'WRITE_OFF' })];
      mappings.push(mapping({ event: 'EMI_RECOVERY' }));

      const result = await service.postPending();

      expect(result.posted).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].reason).toMatch(/No ledger mapping for WRITE_OFF/);
    });
  });
});
