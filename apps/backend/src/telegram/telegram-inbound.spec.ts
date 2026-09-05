import { UnauthorizedException } from '@nestjs/common';
import { TelegramWebhookController } from './inbound/telegram-webhook.controller';
import { TelegramInboundService } from './inbound/telegram-inbound.service';
import { TelegramApiClient } from './api/telegram-api.client';
import { TELEGRAM_WEBHOOK_HEADER } from './telegram.types';

function res() {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
}

describe('webhook authentication', () => {
  const handle = jest.fn().mockResolvedValue(undefined);
  const inbound = { handle } as unknown as TelegramInboundService;

  function controller(cfg: Record<string, unknown>) {
    return new TelegramWebhookController(
      { get: jest.fn().mockResolvedValue(cfg) } as any,
      inbound,
    );
  }

  beforeEach(() => handle.mockClear());

  it('accepts an update carrying the stored secret token', async () => {
    const c = controller({ webhookSecret: 'right', inboundEnabled: true });
    const r = res();
    await c.receive({ update_id: 1 }, 'right', r);
    expect(r.status).toHaveBeenCalledWith(200);
    // Acked first, worked after — Telegram retries anything it did not get a
    // 200 for, and retries the whole backlog in order.
    expect(handle).toHaveBeenCalled();
  });

  it('rejects a wrong secret token', async () => {
    const c = controller({ webhookSecret: 'right', inboundEnabled: true });
    await expect(c.receive({}, 'wrong', res())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a missing secret token', async () => {
    const c = controller({ webhookSecret: 'right', inboundEnabled: true });
    await expect(c.receive({}, undefined, res())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects everything when no secret is stored', async () => {
    // Otherwise the endpoint is open: the URL is public, so anyone who guesses
    // it could feed the bot fabricated /link attempts.
    const c = controller({ webhookSecret: '', inboundEnabled: true });
    await expect(c.receive({}, '', res())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const c = controller({ webhookSecret: 'rightlong', inboundEnabled: true });
    await expect(c.receive({}, 'right', res())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers 200 and does nothing when inbound is switched off', async () => {
    // 200, not 403: making Telegram retry a message we will never process just
    // builds a backlog that all arrives at once when it is switched on.
    const c = controller({ webhookSecret: 'right', inboundEnabled: false });
    const r = res();
    await c.receive({ update_id: 1 }, 'right', r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(handle).not.toHaveBeenCalled();
  });

  it('names the header Telegram actually sends', () => {
    expect(TELEGRAM_WEBHOOK_HEADER).toBe('x-telegram-bot-api-secret-token');
  });
});

describe('inbound commands', () => {
  function build(overrides: { identity?: any; linkingEnabled?: boolean } = {}) {
    const sendMessage = jest.fn().mockResolvedValue({ ok: true });
    const cfg = {
      botToken: 't',
      enabled: true,
      linkingEnabled: overrides.linkingEnabled ?? true,
      inboundEnabled: true,
    };
    const identities = {
      redeemLink: jest.fn().mockResolvedValue({ ok: true, userId: 'user-1' }),
      findActive: jest.fn().mockResolvedValue(overrides.identity ?? null),
      revoke: jest.fn().mockResolvedValue({ ok: true }),
      touch: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new TelegramInboundService(
      {
        get: jest.fn().mockResolvedValue(cfg),
        ensureCredentials: jest.fn().mockResolvedValue(cfg),
      } as any,
      identities as any,
      { sendMessage } as unknown as TelegramApiClient,
      {
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ email: 'a@b.com', employee: { fullName: 'Asha Rao' } }),
        },
      } as any,
    );
    return { svc, sendMessage, identities };
  }

  const msg = (text: string, extra: Record<string, unknown> = {}) => ({
    message: { text, chat: { id: 111222, type: 'private' }, from: { id: 111222 }, ...extra },
  });

  it('answers /start with the command list', async () => {
    const { svc, sendMessage } = build();
    await svc.handle(msg('/start'));
    expect(sendMessage.mock.calls[0][2]).toContain('/link');
  });

  it('redeems a code sent as /link', async () => {
    const { svc, identities, sendMessage } = build();
    await svc.handle(msg('/link 123456'));
    expect(identities.redeemLink).toHaveBeenCalledWith('111222', '111222', null, '123456');
    expect(sendMessage.mock.calls[0][2]).toContain('Asha Rao');
  });

  it('strips the @botname some clients append to a command', async () => {
    const { svc, identities } = build();
    await svc.handle(msg('/link@EssHrBot 123456'));
    expect(identities.redeemLink).toHaveBeenCalled();
  });

  it('refuses to link when linking is switched off', async () => {
    const { svc, identities, sendMessage } = build({ linkingEnabled: false });
    await svc.handle(msg('/link 123456'));
    expect(identities.redeemLink).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][2]).toContain('switched off');
  });

  it('reports a rejected code in the words the identity service chose', async () => {
    const { svc, identities, sendMessage } = build();
    identities.redeemLink.mockResolvedValue({ ok: false, reason: 'That code has expired.' });
    await svc.handle(msg('/link 999999'));
    expect(sendMessage.mock.calls[0][2]).toContain('That code has expired.');
  });

  it('ignores anything sent in a group', async () => {
    // Groups are for alerts. Answering there would let anyone in the group
    // drive another person's link flow.
    const { svc, sendMessage, identities } = build();
    await svc.handle(msg('/link 123456', { chat: { id: -100, type: 'supergroup' } }));
    expect(identities.redeemLink).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores other bots', async () => {
    const { svc, sendMessage } = build();
    await svc.handle(msg('/whoami', { from: { id: 9, is_bot: true } }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([{}, { message: {} }, { message: { text: '   ' } }])(
    'ignores the empty update %p',
    async (update) => {
      const { svc, sendMessage } = build();
      await expect(svc.handle(update as any)).resolves.toBeUndefined();
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it('tells an unlinked chat it is unlinked', async () => {
    const { svc, sendMessage } = build();
    await svc.handle(msg('/whoami'));
    expect(sendMessage.mock.calls[0][2]).toContain('not linked');
  });

  it('unlinks a linked chat', async () => {
    const { svc, identities, sendMessage } = build({
      identity: { id: 'i1', userId: 'user-1' },
    });
    await svc.handle(msg('/unlink'));
    expect(identities.revoke).toHaveBeenCalledWith('user-1');
    expect(sendMessage.mock.calls[0][2]).toContain('Unlinked');
  });

  it('falls back to help on anything it does not know', async () => {
    const { svc, sendMessage } = build();
    await svc.handle(msg('hello there'));
    expect(sendMessage.mock.calls[0][2]).toContain('/link');
  });
});

describe('API error classification', () => {
  const api = new TelegramApiClient();

  it('retries a flood limit and honours the wait Telegram asks for', () => {
    const c = api.classifyError({
      response: { status: 429, data: { description: 'Too Many Requests', parameters: { retry_after: 42 } } },
    });
    expect(c.retryable).toBe(true);
    expect(c.retryAfterSeconds).toBe(42);
  });

  it('retries a server error', () => {
    expect(api.classifyError({ response: { status: 502, data: {} } }).retryable).toBe(true);
  });

  it.each([400, 401, 403, 404])('does not retry %d — a retry only burns attempts', (status) => {
    expect(api.classifyError({ response: { status, data: {} } }).retryable).toBe(false);
  });

  it('retries a transport failure', () => {
    expect(api.classifyError({ code: 'ECONNRESET', message: 'reset' }).retryable).toBe(true);
  });

  it('prefers Telegram’s own description over the axios message', () => {
    const c = api.classifyError({
      response: { status: 400, data: { description: 'chat not found' } },
      message: 'Request failed with status code 400',
    });
    expect(c.message).toBe('chat not found');
  });
});
