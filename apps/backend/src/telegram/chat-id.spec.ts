import { looksLikeChatId, looksLikeGroupChatId, normalizeChatId } from './render/chat-id';
import { TelegramSettingsService } from './telegram-settings.service';
import { TELEGRAM_SETTING_KEYS } from './telegram.types';

/**
 * Chat-id hygiene.
 *
 * Written after a deployment failed every alert with `Bad Request: chat not
 * found` while the group, the bot's membership and the token were all
 * verifiably fine — the id had simply arrived dirty, and Telegram gives that
 * one message for every bad-chat cause, so nothing on screen distinguished a
 * mistyped id from a group the bot was never added to.
 */

describe('normalizeChatId', () => {
  it('leaves a clean group id alone', () => {
    expect(normalizeChatId('-5544539023')).toEqual({ value: '-5544539023', changed: false });
  });

  it('strips a pasted label', () => {
    // Verbatim from the field this went wrong in: the source prints
    // "Chat ID: -5544539023" and the whole line gets copied.
    expect(normalizeChatId('Chat ID: -5544539023').value).toBe('-5544539023');
    expect(normalizeChatId('chat_id:-5544539023').value).toBe('-5544539023');
  });

  it.each([
    ['−5544539023', 'U+2212 minus sign'],
    ['–5544539023', 'U+2013 en dash'],
    ['—5544539023', 'U+2014 em dash'],
    ['－5544539023', 'U+FF0D fullwidth hyphen'],
  ])('converts %p (%s) to an ASCII minus', (input) => {
    // These are visually identical to '-' on screen, which is exactly why the
    // failure was impossible to spot by eye.
    expect(normalizeChatId(input).value).toBe('-5544539023');
  });

  it('trims whitespace and newlines', () => {
    expect(normalizeChatId('  -5544539023\n').value).toBe('-5544539023');
  });

  it('drops digit grouping from a spreadsheet round trip', () => {
    expect(normalizeChatId('-5,544,539,023').value).toBe('-5544539023');
  });

  it('keeps a public @handle, which is also a valid target', () => {
    expect(normalizeChatId('@ess_alerts').value).toBe('@ess_alerts');
    expect(normalizeChatId('Channel: @ess_alerts').value).toBe('@ess_alerts');
  });

  it('preserves the sign — a positive id is a different chat, not the same one', () => {
    expect(normalizeChatId('5544539023').value).toBe('5544539023');
    expect(looksLikeGroupChatId('5544539023')).toBe(false);
    expect(looksLikeGroupChatId('-5544539023')).toBe(true);
  });

  it.each(['', '   ', 'not a chat', '-'])('yields nothing usable for %p', (input) => {
    expect(normalizeChatId(input).value).toBe('');
  });

  it('reports whether it changed anything, so the change can be logged', () => {
    expect(normalizeChatId('-5544539023').changed).toBe(false);
    expect(normalizeChatId('Chat ID: -5544539023').changed).toBe(true);
  });

  it.each([null, undefined])('survives %p', (input) => {
    expect(normalizeChatId(input as any)).toEqual({ value: '', changed: false });
  });

  it('is idempotent — normalising twice is normalising once', () => {
    const once = normalizeChatId('Chat ID: −5,544,539,023 ').value;
    expect(normalizeChatId(once).value).toBe(once);
    expect(once).toBe('-5544539023');
  });
});

describe('looksLikeChatId', () => {
  it.each(['-5544539023', '5544539023', '-1005544539023', '@ess_alerts'])(
    'accepts %p',
    (v) => expect(looksLikeChatId(v)).toBe(true),
  );

  it.each(['', 'Chat ID: -1', '-', '@ab', 'abc', '-123456789012345678901'])(
    'rejects %p',
    (v) => expect(looksLikeChatId(v)).toBe(false),
  );
});

describe('the settings service applies it in both directions', () => {
  function build(rows: Array<{ key: string; value: string }>) {
    const prisma = {
      systemSetting: {
        findMany: jest.fn().mockResolvedValue(rows),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({}),
      },
    };
    return { svc: new TelegramSettingsService(prisma as any), prisma };
  }

  it('cleans a dirty id on write', async () => {
    const { svc, prisma } = build([]);
    await svc.update({ alertChatId: 'Chat ID: -5544539023' });

    const write = prisma.systemSetting.upsert.mock.calls.find(
      (c: any[]) => c[0].where.key === TELEGRAM_SETTING_KEYS.alertChatId,
    );
    expect(write[0].create.value).toBe('-5544539023');
  });

  it('cleans a dirty id already in the database, without anyone re-saving', async () => {
    // The load-bearing case for the live deployment: the write path only helps
    // values stored after this shipped, and "chat not found" gives no hint that
    // re-saving the form is the fix.
    const { svc } = build([
      { key: TELEGRAM_SETTING_KEYS.alertChatId, value: 'Chat ID: −5544539023' },
    ]);
    expect((await svc.get()).alertChatId).toBe('-5544539023');
  });

  it('cleans the redirect catcher too, which overrides every recipient', async () => {
    const { svc } = build([
      { key: TELEGRAM_SETTING_KEYS.redirectAllTo, value: ' 111222333 ' },
    ]);
    expect((await svc.get()).redirectAllTo).toBe('111222333');
  });

  it('leaves an unset chat id as empty, which is how alerts stay off', async () => {
    const { svc } = build([]);
    expect((await svc.get()).alertChatId).toBe('');
  });

  it('does not touch the chat id when the caller did not send one', async () => {
    const { svc, prisma } = build([]);
    await svc.update({ enabled: true });
    expect(
      prisma.systemSetting.upsert.mock.calls.some(
        (c: any[]) => c[0].where.key === TELEGRAM_SETTING_KEYS.alertChatId,
      ),
    ).toBe(false);
  });
});
