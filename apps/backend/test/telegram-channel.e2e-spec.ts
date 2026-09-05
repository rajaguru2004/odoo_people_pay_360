import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { setupFixtures, Fixtures, bearer } from './utils/fixtures';
import { withSettings } from './utils/settings';
import { TELEGRAM_SETTING_KEYS } from '../src/telegram/telegram.types';
import { TelegramSettingsService } from '../src/telegram/telegram-settings.service';
import { TelegramApiClient } from '../src/telegram/api/telegram-api.client';

/**
 * Telegram channel over the real request pipeline.
 *
 * The API client is stubbed at the app's DI container: everything up to and
 * including the queue row is real, and nothing leaves the machine. Sending for
 * real is a manual step (POST /telegram/test-message), because a green CI run
 * must not depend on api.telegram.org being reachable.
 */
describe('Telegram channel (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;
  let sent: Array<{ chatId: string; html: string }>;

  /**
   * What the stubbed client does, swappable per test.
   *
   * A second `jest.spyOn(...).mockRestore()` would restore the REAL method, not
   * the recorder installed in beforeAll — so the test that simulates an outage
   * would silently disarm the stub for every test after it, and the next one to
   * assert on `sent` would fail while trying to reach api.telegram.org.
   */
  let sendBehaviour: (chatId: string, html: string) => Promise<any>;
  /** Same swappable-stub trick for getChat. */
  let chatBehaviour: (chatId: string) => Promise<any>;

  const ON = {
    [TELEGRAM_SETTING_KEYS.enabled]: 'true',
    [TELEGRAM_SETTING_KEYS.loginAlertsEnabled]: 'true',
    [TELEGRAM_SETTING_KEYS.loginAlertFailures]: 'true',
    // Off: this suite must not make an outbound call to a geolocation service.
    [TELEGRAM_SETTING_KEYS.loginAlertGeo]: 'false',
    [TELEGRAM_SETTING_KEYS.alertChatId]: '-5544539023',
  };

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);

    const api = ctx.app.get(TelegramApiClient);
    sent = [];
    sendBehaviour = async (chatId, html) => {
      sent.push({ chatId, html });
      return { ok: true, messageId: String(sent.length), retryable: false };
    };
    chatBehaviour = async (chatId) => ({
      ok: true,
      id: chatId,
      title: 'FusionHRMS Login Alerts',
      type: 'group',
    });
    jest
      .spyOn(api, 'sendMessage')
      .mockImplementation((_cfg, chatId, html) => sendBehaviour(chatId, html));
    jest
      .spyOn(api, 'getChat')
      .mockImplementation(async (_cfg, chatId) => chatBehaviour(chatId));
  });

  afterAll(async () => {
    await ctx.prisma.telegramMessage.deleteMany({
      where: { templateKey: { startsWith: 'login_alert' } },
    });
    await fx.cleanup();
    await ctx.app.close();
  });

  beforeEach(async () => {
    sent = [];
    await ctx.prisma.telegramMessage.deleteMany({
      where: { templateKey: { startsWith: 'login_alert' } },
    });
    ctx.app.get(TelegramSettingsService).invalidate();
  });

  /** The alert is fire-and-forget; give the detached task a tick to land. */
  const settle = () => new Promise((r) => setTimeout(r, 250));

  async function alerts() {
    return ctx.prisma.telegramMessage.findMany({
      where: { templateKey: { startsWith: 'login_alert' } },
      orderBy: { createdAt: 'asc' },
    });
  }

  describe('settings surface', () => {
    it('never returns the bot token, only whether one is set', async () => {
      const put = await ctx
        .http()
        .put('/telegram/settings')
        .set(bearer(fx.globalAdmin.token))
        .send({ botToken: '123456:FAKE-TOKEN-FOR-E2E', alertChatId: '-5544539023' })
        .expect(200);

      expect(JSON.stringify(put.body)).not.toContain('FAKE-TOKEN-FOR-E2E');
      expect(put.body.data.botTokenConfigured).toBe(true);
      expect(put.body.data.botToken).toBeUndefined();

      const get = await ctx
        .http()
        .get('/telegram/settings')
        .set(bearer(fx.globalAdmin.token))
        .expect(200);
      expect(JSON.stringify(get.body)).not.toContain('FAKE-TOKEN-FOR-E2E');
    });

    it('stores the token encrypted, not in the clear', async () => {
      const row = await ctx.prisma.systemSetting.findUnique({
        where: { key: TELEGRAM_SETTING_KEYS.botTokenEnc },
      });
      expect(row?.value).toBeTruthy();
      expect(row!.value).not.toContain('FAKE-TOKEN-FOR-E2E');
      expect(row!.value.startsWith('v1:')).toBe(true);
    });

    it('refuses a non-admin', async () => {
      await ctx
        .http()
        .get('/telegram/settings')
        .set(bearer(fx.plainEmployee.token))
        .expect(403);
    });

    it('refuses an anonymous caller', async () => {
      await ctx.http().get('/telegram/settings').expect(401);
    });

    it('keeps telegram.* out of the generic settings dump', async () => {
      // getSettingsList() is a curated catalogue and these keys are not in it —
      // which is what stops GET /system-settings ever carrying the bot token.
      const res = await ctx
        .http()
        .get('/system-settings')
        .set(bearer(fx.globalAdmin.token))
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain('FAKE-TOKEN-FOR-E2E');
      expect(JSON.stringify(res.body)).not.toContain('telegram.botTokenEnc');
    });
  });

  describe('login alerts', () => {
    it('queues an alert with the IP, the User-Agent and the device on a real login', async () => {
      await withSettings(ctx, ON, async () => {
        await ctx
          .http()
          .post('/auth/login')
          .set('X-Forwarded-For', '203.0.113.77')
          .set(
            'User-Agent',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          )
          .send({ email: fx.plainEmployee.email, password: fx.password })
          .expect(201);

        await settle();
        const rows = await alerts();
        expect(rows).toHaveLength(1);
        expect(rows[0].chatId).toBe('-5544539023');
        expect(rows[0].templateKey).toBe('login_alert');
        expect(rows[0].body).toContain('203.0.113.77');
        expect(rows[0].body).toContain('Chrome 131 on Windows 10/11');
        expect(rows[0].body).toContain(fx.plainEmployee.email);
        expect(rows[0].userId).toBe(fx.plainEmployee.userId);
      });
    });

    it('queues an alert on a wrong password, naming the reason', async () => {
      await withSettings(ctx, ON, async () => {
        await ctx
          .http()
          .post('/auth/login')
          .set('X-Forwarded-For', '198.51.100.4')
          .send({ email: fx.plainEmployee.email, password: 'not-the-password' })
          .expect(401);

        await settle();
        const rows = await alerts();
        expect(rows).toHaveLength(1);
        expect(rows[0].templateKey).toBe('login_alert_failed');
        expect(rows[0].body).toContain('Wrong password');
        expect(rows[0].body).toContain('198.51.100.4');
      });
    });

    it('queues an alert for an email that has no account', async () => {
      await withSettings(ctx, ON, async () => {
        await ctx
          .http()
          .post('/auth/login')
          // Long enough to clear the DTO's 6-character rule — a 400 from
          // validation never reaches the code that raises the alert.
          .send({ email: `nobody-${fx.runId}@example.com`, password: 'whatever1' })
          .expect(401);

        await settle();
        const rows = await alerts();
        expect(rows[0].templateKey).toBe('login_alert_failed');
        expect(rows[0].body).toContain('No account with that email');
        // Nobody to attribute it to — the column has to allow that.
        expect(rows[0].userId).toBeNull();
      });
    });

    it('sends nothing while the channel is off', async () => {
      await withSettings(ctx, { ...ON, [TELEGRAM_SETTING_KEYS.enabled]: 'false' }, async () => {
        await ctx
          .http()
          .post('/auth/login')
          .send({ email: fx.plainEmployee.email, password: fx.password })
          .expect(201);
        await settle();
        expect(await alerts()).toHaveLength(0);
      });
    });

    it('sends nothing while login alerts are off', async () => {
      await withSettings(
        ctx,
        { ...ON, [TELEGRAM_SETTING_KEYS.loginAlertsEnabled]: 'false' },
        async () => {
          await ctx
            .http()
            .post('/auth/login')
            .send({ email: fx.plainEmployee.email, password: fx.password })
            .expect(201);
          await settle();
          expect(await alerts()).toHaveLength(0);
        },
      );
    });

    it('sends nothing when no alert chat is configured', async () => {
      await withSettings(ctx, { ...ON, [TELEGRAM_SETTING_KEYS.alertChatId]: '' }, async () => {
        await ctx
          .http()
          .post('/auth/login')
          .send({ email: fx.plainEmployee.email, password: fx.password })
          .expect(201);
        await settle();
        expect(await alerts()).toHaveLength(0);
      });
    });

    it('honours the role allowlist', async () => {
      await withSettings(
        ctx,
        { ...ON, [TELEGRAM_SETTING_KEYS.loginAlertRoles]: 'ADMIN' },
        async () => {
          await ctx
            .http()
            .post('/auth/login')
            .send({ email: fx.plainEmployee.email, password: fx.password })
            .expect(201);
          await settle();
          expect(await alerts()).toHaveLength(0);

          await ctx
            .http()
            .post('/auth/login')
            .send({ email: fx.globalAdmin.email, password: fx.password })
            .expect(201);
          await settle();
          const rows = await alerts();
          expect(rows).toHaveLength(1);
          expect(rows[0].userId).toBe(fx.globalAdmin.userId);
        },
      );
    });

    it('still logs the user in when the alert path is broken', async () => {
      // The whole point: observability that can deny service is worse than none.
      const healthy = sendBehaviour;
      sendBehaviour = async () => {
        throw new Error('telegram unreachable');
      };
      try {
        await withSettings(ctx, ON, async () => {
          const res = await ctx
            .http()
            .post('/auth/login')
            .send({ email: fx.plainEmployee.email, password: fx.password })
            .expect(201);
          expect(res.body.data.accessToken).toBeTruthy();
          await settle();
        });
      } finally {
        sendBehaviour = healthy;
      }
    });

    it('delivers a queued alert when the sender runs', async () => {
      await withSettings(ctx, ON, async () => {
        await ctx
          .http()
          .post('/auth/login')
          .set('X-Forwarded-For', '203.0.113.90')
          .send({ email: fx.plainEmployee.email, password: fx.password })
          .expect(201);
        await settle();

        await ctx
          .http()
          .post('/telegram/outbox/drain')
          .set(bearer(fx.globalAdmin.token))
          .expect(201);

        expect(sent.some((s) => s.chatId === '-5544539023')).toBe(true);
        expect(sent.some((s) => s.html.includes('203.0.113.90'))).toBe(true);

        const rows = await alerts();
        expect(rows[0].status).toBe('SENT');
      });
    });
  });

  describe('chat id hygiene and the test button', () => {
    it('cleans a pasted chat id rather than storing it verbatim', async () => {
      // The production failure: "Chat ID: -5544539023" copied whole, stored
      // whole, and every alert then failed with "chat not found".
      const res = await ctx
        .http()
        .put('/telegram/settings')
        .set(bearer(fx.globalAdmin.token))
        .send({ alertChatId: 'Chat ID: \u22125,544,539,023 ' })
        .expect(200);

      expect(res.body.data.alertChatId).toBe('-5544539023');
    });

    it('reports what the stored chat id resolves to', async () => {
      const res = await ctx
        .http()
        .get('/telegram/diagnostics')
        .set(bearer(fx.globalAdmin.token))
        .expect(200);

      expect(res.body.data.chat.ok).toBe(true);
      expect(res.body.data.chat.title).toBe('FusionHRMS Login Alerts');
      expect(res.body.data.chat.chatId).toBe('-5544539023');
    });

    it('reports the refusal instead of claiming success when the chat is gone', async () => {
      const previous = chatBehaviour;
      chatBehaviour = async () => ({ ok: false, error: 'Bad Request: chat not found' });
      try {
        const res = await ctx
          .http()
          .get('/telegram/diagnostics')
          .set(bearer(fx.globalAdmin.token))
          .expect(200);
        expect(res.body.data.chat.ok).toBe(false);
        expect(res.body.data.chat.error).toContain('chat not found');
      } finally {
        chatBehaviour = previous;
      }
    });

    it('sends the test message synchronously and says where it went', async () => {
      await withSettings(ctx, ON, async () => {
        const res = await ctx
          .http()
          .post('/telegram/test-message')
          .set(bearer(fx.globalAdmin.token))
          .expect(201);

        expect(res.body.data.sent).toBe(true);
        expect(res.body.data.chatId).toBe('-5544539023');
        expect(sent.some((m) => m.chatId === '-5544539023')).toBe(true);
      });
    });

    it('FAILS the test message rather than reporting it queued', async () => {
      // The defect this closes: the button answered "queued: true" while the
      // send failed later in the drainer, invisibly.
      const previous = sendBehaviour;
      sendBehaviour = async () => ({
        ok: false,
        error: 'Bad Request: chat not found',
        retryable: false,
      });
      try {
        await withSettings(ctx, ON, async () => {
          const res = await ctx
            .http()
            .post('/telegram/test-message')
            .set(bearer(fx.globalAdmin.token))
            .expect(400);

          // Names the chat AND the four causes the API itself does not.
          expect(res.body.message).toContain('-5544539023');
          expect(res.body.message).toContain('chat not found');
          expect(res.body.message).toContain('supergroup');
        });
      } finally {
        sendBehaviour = previous;
      }
    });

    it('refuses a test message when no chat is configured', async () => {
      await withSettings(ctx, { ...ON, [TELEGRAM_SETTING_KEYS.alertChatId]: '' }, async () => {
        await ctx
          .http()
          .post('/telegram/test-message')
          .set(bearer(fx.globalAdmin.token))
          .expect(400);
      });
    });
  });

  describe('employee linking', () => {
    it('refuses to issue a code while the channel is off', async () => {
      await ctx
        .http()
        .post('/telegram/me/link/start')
        .set(bearer(fx.plainEmployee.token))
        .expect(403);
    });

    it('issues a six-digit code when linking is on, and stores only its hash', async () => {
      await withSettings(
        ctx,
        {
          [TELEGRAM_SETTING_KEYS.enabled]: 'true',
          [TELEGRAM_SETTING_KEYS.linkingEnabled]: 'true',
          [TELEGRAM_SETTING_KEYS.inboundEnabled]: 'true',
        },
        async () => {
          const res = await ctx
            .http()
            .post('/telegram/me/link/start')
            .set(bearer(fx.plainEmployee.token))
            .expect(201);

          const code = res.body.data.code;
          expect(code).toMatch(/^\d{6}$/);

          const row = await ctx.prisma.telegramIdentity.findFirst({
            where: { userId: fx.plainEmployee.userId },
          });
          expect(row?.status).toBe('PENDING');
          expect(row?.linkCodeHash).toBeTruthy();
          expect(row!.linkCodeHash).not.toContain(code);

          await ctx.prisma.telegramIdentity.deleteMany({
            where: { userId: fx.plainEmployee.userId },
          });
        },
      );
    });

    it('reports my own link status without exposing anyone else’s', async () => {
      const res = await ctx
        .http()
        .get('/telegram/me')
        .set(bearer(fx.plainEmployee.token))
        .expect(200);
      expect(res.body.data.linked).toBe(false);
      // There is no id parameter on this route at all — scoping is structural.
      expect(res.body.data.available).toBe(false);
    });
  });

  describe('webhook', () => {
    it('refuses an update with no secret token', async () => {
      await ctx.http().post('/telegram/webhook').send({ update_id: 1 }).expect(401);
    });

    it('refuses an update with the wrong secret token', async () => {
      await ctx
        .http()
        .post('/telegram/webhook')
        .set('X-Telegram-Bot-Api-Secret-Token', 'not-the-secret')
        .send({ update_id: 1 })
        .expect(401);
    });
  });
});
