import { NotificationsService } from './notifications.service';

/**
 * The WhatsApp tee lives inside NotificationsService.create(), which is called
 * from ~60 sites deep inside business transactions (leave approvals, payroll
 * locks, the reminders cron). The non-negotiable is that the channel can fail in
 * any way without the in-app notification — or the transaction — noticing.
 */
function makeHarness() {
  const prisma: any = {
    notification: {
      create: jest.fn().mockResolvedValue({ id: 'n1' }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  };
  const whatsapp: any = {
    channelName: 'whatsapp',
    enqueueFromNotifications: jest.fn().mockResolvedValue(1),
  };
  const discord: any = {
    channelName: 'discord',
    enqueueFromNotifications: jest.fn().mockResolvedValue(1),
  };
  return {
    prisma,
    whatsapp,
    discord,
    svc: new NotificationsService(prisma, [whatsapp, discord]),
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

describe('NotificationsService — WhatsApp tee', () => {
  it('constructs without the WhatsApp module at all', () => {
    // @Optional() injection: existing specs do `new NotificationsService(prisma)`,
    // and a deployment may drop WhatsAppModule entirely.
    const prisma: any = { notification: { create: jest.fn().mockResolvedValue({ id: 'n1' }) } };
    const svc = new NotificationsService(prisma);
    return expect(svc.create(dto())).resolves.toMatchObject({ success: true });
  });

  it('forwards the notification to the outbox', async () => {
    const { svc, whatsapp } = makeHarness();
    await svc.create(dto({ waTemplate: 'leave_approved', waData: { leaveType: 'ANNUAL' } }));

    expect(whatsapp.enqueueFromNotifications).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: 'u1',
        type: 'LEAVE_APPROVED',
        waTemplate: 'leave_approved',
        waData: { leaveType: 'ANNUAL' },
      }),
    ]);
  });

  it('never persists the transient WhatsApp fields', async () => {
    const { svc, prisma } = makeHarness();
    await svc.create(
      dto({ waTemplate: 'leave_approved', waData: { a: 1 }, waDedupeKey: 'k', suppressWhatsApp: false }),
    );

    const written = prisma.notification.create.mock.calls[0][0].data;
    expect(written).not.toHaveProperty('waTemplate');
    expect(written).not.toHaveProperty('waData');
    expect(written).not.toHaveProperty('waDedupeKey');
    expect(written).not.toHaveProperty('suppressWhatsApp');
  });

  it('honours suppressWhatsApp', async () => {
    const { svc, whatsapp } = makeHarness();
    await svc.create(dto({ suppressWhatsApp: true }));
    expect(whatsapp.enqueueFromNotifications).not.toHaveBeenCalled();
  });

  it('does not reject when a channel throws', async () => {
    const { svc, whatsapp } = makeHarness();
    whatsapp.enqueueFromNotifications.mockRejectedValue(new Error('evolution down'));

    await expect(svc.create(dto())).resolves.toMatchObject({ success: true });
  });

  it('fans out to every registered channel', async () => {
    const { svc, whatsapp, discord } = makeHarness();
    await svc.create(dto());

    expect(whatsapp.enqueueFromNotifications).toHaveBeenCalledTimes(1);
    expect(discord.enqueueFromNotifications).toHaveBeenCalledTimes(1);
  });

  it('one failing channel does not stop the others', async () => {
    const { svc, whatsapp, discord } = makeHarness();
    whatsapp.enqueueFromNotifications.mockImplementation(() => {
      throw new Error('sync boom');
    });

    await expect(svc.create(dto())).resolves.toMatchObject({ success: true });
    expect(discord.enqueueFromNotifications).toHaveBeenCalledTimes(1);
  });

  it('does not reject when the outbox throws synchronously', async () => {
    const { svc, whatsapp } = makeHarness();
    whatsapp.enqueueFromNotifications.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(svc.create(dto())).resolves.toMatchObject({ success: true });
  });

  it('still writes the in-app row when the channel fails', async () => {
    const { svc, prisma, whatsapp } = makeHarness();
    whatsapp.enqueueFromNotifications.mockRejectedValue(new Error('nope'));

    await svc.create(dto());
    expect(prisma.notification.create).toHaveBeenCalled();
  });

  describe('createBulk', () => {
    it('tees the whole batch in one call', async () => {
      const { svc, whatsapp } = makeHarness();
      await svc.createBulk([dto(), dto({ userId: 'u2' })]);

      expect(whatsapp.enqueueFromNotifications).toHaveBeenCalledTimes(1);
      expect(whatsapp.enqueueFromNotifications.mock.calls[0][0]).toHaveLength(2);
    });

    it('drops only the suppressed entries', async () => {
      const { svc, whatsapp } = makeHarness();
      await svc.createBulk([dto(), dto({ userId: 'u2', suppressWhatsApp: true })]);

      const forwarded = whatsapp.enqueueFromNotifications.mock.calls[0][0];
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].userId).toBe('u1');
    });
  });

  describe('notifyUsers', () => {
    it('makes a caller-supplied dedupe key unique per recipient', async () => {
      // A shared key across a fan-out would collapse to one message on the
      // unique index and silently skip everybody but the first person.
      const { svc, whatsapp } = makeHarness();
      await svc.notifyUsers(['u1', 'u2'], 'T', 'M', 'INFO', '/x', {
        waTemplate: 'generic',
        waDedupeKey: 'approval:LEAVE:req1',
      });

      const keys = whatsapp.enqueueFromNotifications.mock.calls[0][0].map((n: any) => n.dedupeKey);
      expect(keys).toEqual(['approval:LEAVE:req1:u1', 'approval:LEAVE:req1:u2']);
    });

    it('leaves the key undefined when the caller supplies none', async () => {
      const { svc, whatsapp } = makeHarness();
      await svc.notifyUsers(['u1'], 'T', 'M', 'LEAVE_APPROVED', '/x');

      expect(whatsapp.enqueueFromNotifications.mock.calls[0][0][0].dedupeKey).toBeUndefined();
    });

    it('keeps the existing five-argument signature working', async () => {
      const { svc, prisma } = makeHarness();
      await svc.notifyUser('u1', 'T', 'M', 'INFO', '/x');
      expect(prisma.notification.create).toHaveBeenCalled();
    });
  });
});
