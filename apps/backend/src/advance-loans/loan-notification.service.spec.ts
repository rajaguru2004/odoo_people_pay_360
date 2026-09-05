import { LoanNotificationService } from './loan-notification.service';

/**
 * The dedupe log, which is the whole point of the service.
 *
 * `AdvanceLoanNotificationLog` shipped with a purpose-built unique index and no
 * writer, so duplicates, failures and retries were all invisible. These cases
 * pin the three properties that make it worth having:
 *
 *  1. The row is claimed BEFORE the send, so two racing callers produce one
 *     notice — the unique index decides, not a read-then-write.
 *  2. A failed send is recorded rather than swallowed, and never rethrown:
 *     money must not roll back because an email bounced.
 *  3. A retry is bounded, so a permanently bad address stops being retried and
 *     keeps its error instead.
 */
describe('LoanNotificationService', () => {
  type Row = {
    id: string;
    requestId: string;
    event: string;
    periodKey: string;
    recipientUserId: string | null;
    channel: string;
    status: string;
    attempts: number;
    lastError: string | null;
    sentAt: Date | null;
    createdAt: Date;
  };

  let rows: Row[];
  let seq: number;
  let notifyUser: jest.Mock;
  let service: LoanNotificationService;

  const key = (r: { requestId: string; event: string; periodKey: string; recipientUserId: string | null; channel: string }) =>
    [r.requestId, r.event, r.periodKey, r.recipientUserId, r.channel].join('|');

  const prisma: any = {
    advanceLoanNotificationLog: {
      create: jest.fn(async ({ data }: any) => {
        const row: Row = {
          id: `log-${++seq}`,
          requestId: data.requestId,
          event: data.event,
          periodKey: data.periodKey ?? '',
          recipientUserId: data.recipientUserId ?? null,
          channel: data.channel ?? 'IN_APP',
          status: data.status ?? 'PENDING',
          attempts: 0,
          lastError: null,
          sentAt: null,
          createdAt: new Date(2026, 7, seq),
        };
        // The unique index, modelled: this is the dedupe mechanism itself.
        if (rows.some((r) => key(r) === key(row))) {
          const err: any = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        rows.push(row);
        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        if (data.status) row.status = data.status;
        if (data.attempts?.increment) row.attempts += data.attempts.increment;
        if (data.lastError !== undefined) row.lastError = data.lastError;
        if (data.sentAt) row.sentAt = data.sentAt;
        return row;
      }),
      findMany: jest.fn(async ({ where, take }: any) => {
        const out = rows.filter(
          (r) =>
            (!where?.status || r.status === where.status) &&
            (!where?.attempts?.lt || r.attempts < where.attempts.lt) &&
            (!where?.requestId || r.requestId === where.requestId),
        );
        return out.slice(0, take ?? out.length).map((r) => ({
          ...r,
          request: { id: r.requestId, type: 'LOAN', referenceNo: 'LN-202608-0001' },
        }));
      }),
    },
  };

  const args = (over: Record<string, unknown> = {}) => ({
    requestId: 'req-1',
    event: 'EMI_DEDUCTED',
    recipientUserId: 'user-1',
    title: 'Instalment recovered',
    message: '200 was recovered from your August payroll',
    ...over,
  });

  beforeEach(() => {
    rows = [];
    seq = 0;
    jest.clearAllMocks();
    notifyUser = jest.fn().mockResolvedValue(undefined);
    service = new LoanNotificationService(prisma, { notifyUser } as any);
  });

  describe('saying it once', () => {
    it('sends, and records that it did', async () => {
      const sent = await service.notifyOnce(args());

      expect(sent).toBe(true);
      expect(notifyUser).toHaveBeenCalledTimes(1);
      expect(rows[0].status).toBe('SENT');
      expect(rows[0].attempts).toBe(1);
      expect(rows[0].sentAt).toBeTruthy();
    });

    it('does not send the same notice twice', async () => {
      await service.notifyOnce(args({ periodKey: '2026-08' }));
      const second = await service.notifyOnce(args({ periodKey: '2026-08' }));

      expect(second).toBe(false);
      // The duplicate never reaches the notifier at all.
      expect(notifyUser).toHaveBeenCalledTimes(1);
      expect(rows).toHaveLength(1);
    });

    it('does send again in the NEXT period — that is what periodKey is for', async () => {
      await service.notifyOnce(args({ periodKey: '2026-08' }));
      const next = await service.notifyOnce(args({ periodKey: '2026-09' }));

      expect(next).toBe(true);
      expect(notifyUser).toHaveBeenCalledTimes(2);
    });

    it('treats two recipients as two notices', async () => {
      await service.notifyOnce(args({ recipientUserId: 'user-1' }));
      await service.notifyOnce(args({ recipientUserId: 'user-2' }));

      expect(notifyUser).toHaveBeenCalledTimes(2);
    });

    it('treats two channels as two notices', async () => {
      await service.notifyOnce(args({ channel: 'IN_APP' }));
      await service.notifyOnce(args({ channel: 'EMAIL' }));

      expect(notifyUser).toHaveBeenCalledTimes(2);
    });

    it('treats two events about one loan as two notices', async () => {
      await service.notifyOnce(args({ event: 'LOAN_APPROVED', periodKey: '' }));
      await service.notifyOnce(args({ event: 'LOAN_REJECTED', periodKey: '' }));

      expect(notifyUser).toHaveBeenCalledTimes(2);
    });

    it('claims the row BEFORE sending, so a race cannot double-send', async () => {
      // Ordering matters more than it looks: claim-then-send makes the unique
      // index the arbiter. Send-then-claim would let two payroll runs both
      // send and only then discover the clash.
      const order: string[] = [];
      prisma.advanceLoanNotificationLog.create.mockImplementationOnce(async ({ data }: any) => {
        order.push('claim');
        const row: Row = {
          id: 'log-race',
          requestId: data.requestId,
          event: data.event,
          periodKey: data.periodKey ?? '',
          recipientUserId: data.recipientUserId ?? null,
          channel: data.channel ?? 'IN_APP',
          status: 'PENDING',
          attempts: 0,
          lastError: null,
          sentAt: null,
          createdAt: new Date(),
        };
        rows.push(row);
        return { id: row.id };
      });
      notifyUser.mockImplementationOnce(async () => {
        order.push('send');
      });

      await service.notifyOnce(args());

      expect(order).toEqual(['claim', 'send']);
    });
  });

  describe('when the send fails', () => {
    it('records the failure instead of swallowing it', async () => {
      notifyUser.mockRejectedValueOnce(new Error('SMTP said no'));

      const sent = await service.notifyOnce(args());

      expect(sent).toBe(false);
      expect(rows[0].status).toBe('FAILED');
      expect(rows[0].lastError).toContain('SMTP said no');
      expect(rows[0].attempts).toBe(1);
    });

    it('never throws — a bounced notice must not roll back money', async () => {
      notifyUser.mockRejectedValueOnce(new Error('SMTP said no'));

      await expect(service.notifyOnce(args())).resolves.toBe(false);
    });

    it('still sends when the log itself cannot be written', async () => {
      // An unmigrated database must cost the user their audit row, not their
      // notification.
      prisma.advanceLoanNotificationLog.create.mockRejectedValueOnce(
        new Error('relation "advance_loan_notification_logs" does not exist'),
      );

      const sent = await service.notifyOnce(args());

      expect(sent).toBe(true);
      expect(notifyUser).toHaveBeenCalledTimes(1);
    });
  });

  describe('retrying', () => {
    it('re-sends what failed and marks it sent', async () => {
      notifyUser.mockRejectedValueOnce(new Error('transient'));
      await service.notifyOnce(args());
      expect(rows[0].status).toBe('FAILED');

      const result = await service.retryFailed();

      expect(result.sent).toBe(1);
      expect(rows[0].status).toBe('SENT');
      expect(rows[0].attempts).toBe(2);
    });

    it('gives up after the attempt limit, keeping the error', async () => {
      // A permanently bad address should stop consuming every sweep, and its
      // reason must survive for whoever investigates.
      notifyUser.mockRejectedValue(new Error('mailbox does not exist'));
      await service.notifyOnce(args());

      await service.retryFailed({ maxAttempts: 3 });
      await service.retryFailed({ maxAttempts: 3 });
      const third = await service.retryFailed({ maxAttempts: 3 });

      expect(rows[0].attempts).toBe(3);
      // Nothing is retried once the limit is reached.
      expect(third.considered).toBe(0);
      expect(rows[0].lastError).toContain('mailbox does not exist');
    });

    it('leaves successful notices alone', async () => {
      await service.notifyOnce(args());
      const result = await service.retryFailed();

      expect(result.considered).toBe(0);
      expect(notifyUser).toHaveBeenCalledTimes(1);
    });
  });
});
