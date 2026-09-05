import { TelegramOutboxService } from './telegram-outbox.service';
import { TelegramResolvedConfig } from './telegram.types';

/**
 * Outbox behaviour under mocked Prisma. The cases here are the ones where being
 * wrong is expensive: messaging somebody who never linked an account, sending
 * a notification the allowlist was supposed to drop, or losing the ops alert
 * because it went down the notification path by mistake.
 */

const CFG: TelegramResolvedConfig = {
  enabled: true,
  botToken: 'bot-token',
  botTokenSource: 'db',
  inboundEnabled: true,
  webhookSecret: 'wh',
  linkingEnabled: true,
  notificationsEnabled: true,
  alertChatId: '-5544539023',
  loginAlertsEnabled: true,
  loginAlertFailures: true,
  loginAlertGeo: false,
  geoLookupUrl: 'http://example.invalid/{ip}',
  loginAlertRoles: [],
  loginAlertFailureMaxPerHour: 10,
  redirectAllTo: '',
  retentionDays: 90,
  maxAttempts: 5,
};

function build(cfg: Partial<TelegramResolvedConfig> = {}, identities: any[] = []) {
  const resolved = { ...CFG, ...cfg };
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    telegramIdentity: { findMany: jest.fn().mockResolvedValue(identities) },
    telegramMessage: { createMany, findMany: jest.fn().mockResolvedValue([]) },
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'user-1', email: 'a@b.com', employee: { fullName: 'Asha' } }]),
    },
    systemSetting: { findUnique: jest.fn().mockResolvedValue({ value: 'Acme' }) },
  };
  const api = { sendMessage: jest.fn().mockResolvedValue({ ok: true, messageId: '1' }) };
  const settings = {
    get: jest.fn().mockResolvedValue(resolved),
    ensureConfigured: jest.fn().mockResolvedValue(resolved.enabled ? resolved : null),
  };

  const svc = new TelegramOutboxService(prisma as any, settings as any, api as any);
  // drain() is fired opportunistically from enqueue; stub it so a test asserting
  // on the enqueue is not also asserting on the sender.
  jest.spyOn(svc, 'drain').mockResolvedValue({ processed: 0, sent: 0, failed: 0 });
  return { svc, prisma, api, createMany };
}

const LINKED = [
  {
    id: 'id-1',
    userId: 'user-1',
    employeeId: 'emp-1',
    branchId: 'branch-1',
    telegramChatId: '111222',
    status: 'ACTIVE',
    optedIn: true,
  },
];

describe('notification fan-out', () => {
  it('queues a message for a linked user on an allowlisted template', async () => {
    const { svc, createMany } = build({}, LINKED);
    const n = await svc.enqueueFromNotifications([
      {
        userId: 'user-1',
        title: 'Leave approved',
        message: 'Your leave was approved.',
        waTemplate: 'leave_approved',
      },
    ]);

    expect(n).toBe(1);
    const row = createMany.mock.calls[0][0].data[0];
    expect(row.chatId).toBe('111222');
    expect(row.employeeId).toBe('emp-1');
    expect(row.templateKey).toBe('leave_approved');
    // Rendered to Telegram HTML at enqueue, not at send.
    expect(row.body).toContain('<b>');
    expect(row.body).not.toMatch(/(^|[^*])\*[^*]/);
  });

  it('drops a notification with no template — that allowlist is the blast radius', async () => {
    const { svc, prisma } = build({}, LINKED);
    const n = await svc.enqueueFromNotifications([
      { userId: 'user-1', title: 'Timesheet saved', message: 'ok' },
    ]);
    expect(n).toBe(0);
    // Not even a recipient query: template resolution comes first precisely so
    // the ~40 chatty call sites cost nothing.
    expect(prisma.telegramIdentity.findMany).not.toHaveBeenCalled();
  });

  it('sends nothing to a user who never linked a chat', async () => {
    const { svc, createMany } = build({}, []);
    const n = await svc.enqueueFromNotifications([
      { userId: 'user-1', title: 'x', message: 'y', waTemplate: 'leave_approved' },
    ]);
    expect(n).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['the channel is off', { enabled: false }],
    ['notifications are off for this channel', { notificationsEnabled: false }],
  ])('sends nothing when %s', async (_l, override) => {
    const { svc, createMany } = build(override, LINKED);
    const n = await svc.enqueueFromNotifications([
      { userId: 'user-1', title: 'x', message: 'y', waTemplate: 'leave_approved' },
    ]);
    expect(n).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('honours the test-mode redirect', async () => {
    const { svc, createMany } = build({ redirectAllTo: '999' }, LINKED);
    await svc.enqueueFromNotifications([
      { userId: 'user-1', title: 'x', message: 'y', waTemplate: 'leave_approved' },
    ]);
    expect(createMany.mock.calls[0][0].data[0].chatId).toBe('999');
  });

  it('namespaces a caller-supplied dedupe key, so two channels do not collide', async () => {
    const { svc, createMany } = build({}, LINKED);
    await svc.enqueueFromNotifications([
      { userId: 'user-1', title: 'x', message: 'y', waTemplate: 'leave_approved', dedupeKey: 'k1' },
    ]);
    expect(createMany.mock.calls[0][0].data[0].dedupeKey).toBe('telegram:k1');
  });

  it('never throws out of the notification tee', async () => {
    // This runs inside business transactions all over the codebase.
    const { svc, prisma } = build({}, LINKED);
    prisma.telegramIdentity.findMany.mockRejectedValue(new Error('db gone'));
    await expect(
      svc.enqueueFromNotifications([
        { userId: 'user-1', title: 'x', message: 'y', waTemplate: 'leave_approved' },
      ]),
    ).resolves.toBe(0);
  });

  it('is a no-op on an empty batch', async () => {
    const { svc, prisma } = build({}, LINKED);
    await expect(svc.enqueueFromNotifications([])).resolves.toBe(0);
    expect(prisma.telegramIdentity.findMany).not.toHaveBeenCalled();
  });
});

describe('enqueueToChat — the ops alert path', () => {
  it('queues to a chat with no identity and no template', async () => {
    const { svc, createMany, prisma } = build({}, []);
    const queued = await svc.enqueueToChat({
      chatId: '-100',
      templateKey: 'login_alert',
      body: '<b>Login</b>',
      dedupeKey: 'login:abc',
    });

    expect(queued).toBe(true);
    expect(prisma.telegramIdentity.findMany).not.toHaveBeenCalled();
    const row = createMany.mock.calls[0][0].data[0];
    expect(row.chatId).toBe('-100');
    expect(row.userId).toBeNull();
    expect(row.dedupeKey).toBe('telegram:login:abc');
  });

  it('does NOT re-convert an already-rendered HTML body', async () => {
    // The login alert is assembled with escapeTelegramHtml; converting again
    // here would double-escape it and the ops group would read raw entities.
    const { svc, createMany } = build({}, []);
    await svc.enqueueToChat({
      chatId: '-100',
      templateKey: 'login_alert',
      body: '<b>IP:</b> <code>a &amp; b</code>',
      dedupeKey: 'k',
    });
    expect(createMany.mock.calls[0][0].data[0].body).toBe('<b>IP:</b> <code>a &amp; b</code>');
  });

  it('refuses when the channel is off', async () => {
    const { svc, createMany } = build({ enabled: false });
    await expect(
      svc.enqueueToChat({ chatId: '-100', templateKey: 't', body: 'x', dedupeKey: 'k' }),
    ).resolves.toBe(false);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('refuses when there is no chat to send to', async () => {
    const { svc, createMany } = build();
    await expect(
      svc.enqueueToChat({ chatId: '', templateKey: 't', body: 'x', dedupeKey: 'k' }),
    ).resolves.toBe(false);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('ignores notificationsEnabled — an ops alert is not an ESS notification', async () => {
    // Turning off employee DMs must not silently turn off the security channel.
    const { svc, createMany } = build({ notificationsEnabled: false });
    await expect(
      svc.enqueueToChat({ chatId: '-100', templateKey: 'login_alert', body: 'x', dedupeKey: 'k' }),
    ).resolves.toBe(true);
    expect(createMany).toHaveBeenCalled();
  });

  it('reports false when the row was a duplicate', async () => {
    const { svc, prisma } = build();
    prisma.telegramMessage.createMany.mockResolvedValue({ count: 0 });
    await expect(
      svc.enqueueToChat({ chatId: '-100', templateKey: 't', body: 'x', dedupeKey: 'k' }),
    ).resolves.toBe(false);
  });

  it('never throws', async () => {
    const { svc, prisma } = build();
    prisma.telegramMessage.createMany.mockRejectedValue(new Error('db gone'));
    await expect(
      svc.enqueueToChat({ chatId: '-100', templateKey: 't', body: 'x', dedupeKey: 'k' }),
    ).resolves.toBe(false);
  });
});
