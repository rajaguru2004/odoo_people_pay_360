import { NotificationsService } from './notifications.service';

/**
 * The channel tee lives inside NotificationsService.create(), which is called
 * from ~60 sites deep inside business transactions (leave approvals, payroll
 * locks, the reminders cron). The non-negotiable is that a delivery channel can
 * fail in any way without the in-app notification — or the transaction —
 * noticing.
 */
function makeHarness() {
  const prisma: any = {
    notification: {
      create: jest.fn().mockResolvedValue({ id: 'n1' }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  };
  const channelA: any = {
    channelName: 'channel-a',
    enqueueFromNotifications: jest.fn().mockResolvedValue(1),
  };
  const channelB: any = {
    channelName: 'channel-b',
    enqueueFromNotifications: jest.fn().mockResolvedValue(1),
  };
  return {
    prisma,
    channelA,
    channelB,
    svc: new NotificationsService(prisma, [channelA, channelB]),
  };
}

const dto = (over: any = {}) => ({
  userId: 'u1',
  title: 'Leave approved',
  message: 'Your leave was approved.',
  type: 'LEAVE_APPROVED' as any,
  link: '/dashboard/leaves',
  ...over,
});

describe('NotificationsService — channel tee', () => {
  it('constructs with no delivery channel registered at all', () => {
    // @Optional() injection: existing specs do `new NotificationsService(prisma)`,
    // and a deployment may register no channel module whatsoever.
    const prisma: any = { notification: { create: jest.fn().mockResolvedValue({ id: 'n1' }) } };
    const svc = new NotificationsService(prisma);
    return expect(svc.create(dto())).resolves.toMatchObject({ success: true });
  });

  it('forwards the notification to the channel', async () => {
    const { svc, channelA } = makeHarness();
    await svc.create(dto());

    expect(channelA.enqueueFromNotifications).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: 'u1',
        type: 'LEAVE_APPROVED',
        link: '/dashboard/leaves',
      }),
    ]);
  });

  it('never persists the transient decision field', async () => {
    const { svc, prisma } = makeHarness();
    await svc.create(dto({ decision: { requestType: 'LEAVE', requestId: 'req1' } }));

    const written = prisma.notification.create.mock.calls[0][0].data;
    expect(written).not.toHaveProperty('decision');
  });

  it('does not reject when a channel throws', async () => {
    const { svc, channelA } = makeHarness();
    channelA.enqueueFromNotifications.mockRejectedValue(new Error('channel down'));

    await expect(svc.create(dto())).resolves.toMatchObject({ success: true });
  });

  it('fans out to every registered channel', async () => {
    const { svc, channelA, channelB } = makeHarness();
    await svc.create(dto());

    expect(channelA.enqueueFromNotifications).toHaveBeenCalledTimes(1);
    expect(channelB.enqueueFromNotifications).toHaveBeenCalledTimes(1);
  });

  it('one failing channel does not stop the others', async () => {
    const { svc, channelA, channelB } = makeHarness();
    channelA.enqueueFromNotifications.mockImplementation(() => {
      throw new Error('sync boom');
    });

    await expect(svc.create(dto())).resolves.toMatchObject({ success: true });
    expect(channelB.enqueueFromNotifications).toHaveBeenCalledTimes(1);
  });

  it('still writes the in-app row when the channel fails', async () => {
    const { svc, prisma, channelA } = makeHarness();
    channelA.enqueueFromNotifications.mockRejectedValue(new Error('nope'));

    await svc.create(dto());
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  describe('createBulk', () => {
    it('tees the whole batch in one call', async () => {
      const { svc, channelA } = makeHarness();
      await svc.createBulk([dto(), dto({ userId: 'u2' })]);

      expect(channelA.enqueueFromNotifications).toHaveBeenCalledTimes(1);
      expect(channelA.enqueueFromNotifications.mock.calls[0][0]).toHaveLength(2);
    });
  });

  describe('notifyUsers', () => {
    it('writes one in-app row per recipient', async () => {
      const { svc, prisma } = makeHarness();
      await svc.notifyUsers(['u1', 'u2'], 'T', 'M', 'INFO', '/x');

      const rows = prisma.notification.createMany.mock.calls[0][0].data;
      expect(rows.map((r: any) => r.userId)).toEqual(['u1', 'u2']);
    });

    it('keeps the existing five-argument signature working', async () => {
      const { svc, prisma } = makeHarness();
      await svc.notifyUser('u1', 'T', 'M', 'INFO', '/x');
      expect(prisma.notification.create).toHaveBeenCalled();
    });
  });
});
