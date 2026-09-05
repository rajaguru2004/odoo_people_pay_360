import { ChannelVerificationTokenService } from './channel-verification-token.service';

/**
 * A verification link has to still work when the employee taps it.
 *
 * Every issue used to close every other live capability for that employee and
 * purpose. Tapping "Check in" a second time — which is exactly what somebody
 * does while waiting for the first link to work — therefore killed the link
 * already sitting in their chat, and the page told them it had "expired or
 * already been used" while its own expiry was still ten minutes away.
 *
 * Observed in production: a token created at 11:35:32 with expiry 11:45:32 was
 * marked EXPIRED at 11:36:15, when the next one was issued.
 */
describe('verification link lifetime', () => {
  const NOW = new Date('2026-08-11T11:36:15.000Z');

  const harness = (live: Array<{ id: string }> = []) => {
    const updates: any[] = [];
    const prisma: any = {
      channelVerificationToken: {
        updateMany: jest.fn(async (a: any) => {
          updates.push(a);
          return { count: 1 };
        }),
        findMany: jest.fn().mockResolvedValue(live),
        create: jest.fn(async ({ data }: any) => ({ id: 'new-row', ...data })),
        findUnique: jest.fn(),
      },
    };
    const svc = new ChannelVerificationTokenService(prisma);
    return { svc, prisma, updates };
  };

  const args = (over: Record<string, any> = {}) => ({
    channel: 'whatsapp' as const,
    deliveryMode: 'LINK' as const,
    identityId: 'idn-1',
    userId: 'user-1',
    employeeId: 'emp-1',
    purpose: 'CHECKIN' as const,
    requireLocation: false,
    requireFace: true,
    actionKey: 'attendance.checkin',
    toolName: 'attendance_check_in',
    ttlSeconds: 600,
    ...over,
  });

  describe('issuing a link', () => {
    it('does not kill the links already in the chat', async () => {
      const { svc, updates } = harness();
      await svc.issue(args());

      // The only invalidation allowed here targets CHAT challenges.
      const killedLinks = updates.filter((u) => u.where?.deliveryMode === 'LINK');
      expect(killedLinks).toHaveLength(0);
    });

    it('still closes the open chat challenge', async () => {
      // Only one selfie challenge can be open: an inbound photo has to bind to
      // exactly one, and a stale one must not be answerable later.
      const { svc, updates } = harness();
      await svc.issue(args());

      const chat = updates.find((u) => u.where?.deliveryMode === 'CHAT');
      expect(chat).toBeDefined();
      expect(chat.where).toMatchObject({ userId: 'user-1', purpose: 'CHECKIN', status: 'PENDING' });
      expect(chat.data).toEqual({ status: 'EXPIRED' });
    });

    it('closes the chat challenge even when issuing a link', async () => {
      const { svc, updates } = harness();
      await svc.issue(args({ deliveryMode: 'LINK' }));
      expect(updates.some((u) => u.where?.deliveryMode === 'CHAT')).toBe(true);
    });

    it('caps how many links stay live, oldest first', async () => {
      // Three already live; the oldest beyond the cap is retired.
      const { svc, prisma, updates } = harness([{ id: 'old-1' }, { id: 'old-2' }]);
      await svc.issue(args());

      expect(prisma.channelVerificationToken.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
          skip: 2, // MAX_LIVE_LINKS - 1
        }),
      );
      const retired = updates.find((u) => u.where?.id?.in);
      expect(retired.where.id.in).toEqual(['old-1', 'old-2']);
    });

    it('retires nothing when under the cap', async () => {
      const { svc, updates } = harness([]);
      await svc.issue(args());
      expect(updates.find((u) => u.where?.id?.in)).toBeUndefined();
    });

    it('never runs the link cap for a chat challenge', async () => {
      const { svc, prisma } = harness();
      await svc.issue(args({ deliveryMode: 'CHAT' }));
      expect(prisma.channelVerificationToken.findMany).not.toHaveBeenCalled();
    });
  });

  describe('peek says WHY, not just no', () => {
    const peekWith = async (row: any) => {
      const { svc, prisma } = harness();
      prisma.channelVerificationToken.findUnique.mockResolvedValue(row);
      return svc.peek('some-token');
    };

    const row = (over: Record<string, any> = {}) => ({
      status: 'PENDING',
      expiresAt: new Date(NOW.getTime() + 60_000),
      requireFace: true,
      requireLocation: false,
      purpose: 'CHECKIN',
      ...over,
    });

    beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
    afterEach(() => jest.useRealTimers());

    it('accepts a live token', async () => {
      await expect(peekWith(row())).resolves.toMatchObject({ valid: true, reason: 'ok' });
    });

    it('reports a link closed by a newer one as replaced, not expired', async () => {
      // The production case. "Expired" sent people to wait for a new link when
      // the fix was to open the newest message they already had.
      await expect(
        peekWith(row({ status: 'EXPIRED', expiresAt: new Date(NOW.getTime() + 540_000) })),
      ).resolves.toMatchObject({ valid: false, reason: 'replaced' });
    });

    it('reports a genuinely timed-out link as expired', async () => {
      await expect(
        peekWith(row({ status: 'PENDING', expiresAt: new Date(NOW.getTime() - 1000) })),
      ).resolves.toMatchObject({ valid: false, reason: 'expired' });
    });

    it('prefers "used" over "expired" when both are true', async () => {
      // Being told the job is already done beats being told to try again.
      await expect(
        peekWith(row({ status: 'USED', expiresAt: new Date(NOW.getTime() - 1000) })),
      ).resolves.toMatchObject({ valid: false, reason: 'used' });
    });

    it('gives nothing away for a token it has never seen', async () => {
      await expect(peekWith(null)).resolves.toMatchObject({
        valid: false,
        reason: 'unknown',
        purposeLabel: '',
      });
    });

    it('never leaks who a rejected token belongs to', async () => {
      const res = await peekWith(row({ status: 'USED' }));
      expect(JSON.stringify(res)).not.toMatch(/user-1|emp-1|idn-1/);
    });
  });
});
