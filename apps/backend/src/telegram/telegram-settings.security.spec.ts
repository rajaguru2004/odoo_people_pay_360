import { TelegramSettingsService } from './telegram-settings.service';
import { TELEGRAM_SETTING_KEYS } from './telegram.types';
import { encryptSecret } from '../common/crypto/secret-crypto';
import { isProtectedSettingKey } from '../system-settings/protected-setting-keys';
import { isDeveloperSettingKey } from '../system-settings/developer-setting-keys';

/**
 * The bot token is the whole security boundary of this channel: whoever holds
 * it can read and write every message the bot can see. These cases pin the
 * three ways it must not escape — the public projection, the generic settings
 * dump, and an unauthenticated webhook.
 */

const REAL_TOKEN = '8931454826:AAEwt8FUGNYZymqIFior8ReHcoES5eoBWn4';

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

describe('the token never leaves the process', () => {
  it('is absent from the public projection, not merely masked', async () => {
    const { svc } = build([
      { key: TELEGRAM_SETTING_KEYS.botTokenEnc, value: encryptSecret(REAL_TOKEN) },
    ]);
    const pub: any = await svc.getPublic();

    expect(pub.botToken).toBeUndefined();
    expect(pub.webhookSecret).toBeUndefined();
    expect(pub.botTokenConfigured).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(REAL_TOKEN);
    // Not even the leading bot-id half, which is enough to identify the bot.
    expect(JSON.stringify(pub)).not.toContain('AAEwt8');
  });

  it('reports the webhook secret as a boolean only', async () => {
    const { svc } = build([
      { key: TELEGRAM_SETTING_KEYS.webhookSecretEnc, value: encryptSecret('s3cret-value') },
    ]);
    const pub: any = await svc.getPublic();
    expect(pub.webhookSecretConfigured).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('s3cret-value');
  });

  it('resolves it internally so the sender can actually use it', async () => {
    const { svc } = build([
      { key: TELEGRAM_SETTING_KEYS.botTokenEnc, value: encryptSecret(REAL_TOKEN) },
      { key: TELEGRAM_SETTING_KEYS.enabled, value: 'true' },
    ]);
    const cfg = await svc.get();
    expect(cfg.botToken).toBe(REAL_TOKEN);
    expect(cfg.botTokenSource).toBe('db');
  });

  it('encrypts on write — a plaintext token is never stored', async () => {
    const { svc, prisma } = build([]);
    await svc.update({ botToken: REAL_TOKEN });

    const write = prisma.systemSetting.upsert.mock.calls.find(
      (c: any[]) => c[0].where.key === TELEGRAM_SETTING_KEYS.botTokenEnc,
    );
    expect(write).toBeDefined();
    expect(write[0].create.value).not.toContain(REAL_TOKEN);
    expect(write[0].create.value.startsWith('v1:')).toBe(true);
  });

  it('is kept on omit and deleted on an explicit clear', async () => {
    const { svc, prisma } = build([]);
    await svc.update({ enabled: true });
    expect(
      prisma.systemSetting.upsert.mock.calls.some(
        (c: any[]) => c[0].where.key === TELEGRAM_SETTING_KEYS.botTokenEnc,
      ),
    ).toBe(false);

    await svc.update({ clearBotToken: true });
    expect(prisma.systemSetting.deleteMany).toHaveBeenCalledWith({
      where: { key: TELEGRAM_SETTING_KEYS.botTokenEnc },
    });
  });

  it('survives a ciphertext it cannot decrypt rather than crashing the channel', async () => {
    const { svc } = build([{ key: TELEGRAM_SETTING_KEYS.botTokenEnc, value: 'v1:not:real:data' }]);
    const cfg = await svc.get();
    expect(cfg.botToken).toBe('');
    expect(await svc.ensureConfigured()).toBeNull();
  });
});

describe('the generic /system-settings surface cannot reach these keys', () => {
  it('treats both secrets as protected, so they are masked for every role', () => {
    expect(isProtectedSettingKey(TELEGRAM_SETTING_KEYS.botTokenEnc)).toBe(true);
    expect(isProtectedSettingKey(TELEGRAM_SETTING_KEYS.webhookSecretEnc)).toBe(true);
  });

  it('treats every telegram.* key as developer-owned', () => {
    for (const key of Object.values(TELEGRAM_SETTING_KEYS)) {
      expect(isDeveloperSettingKey(key)).toBe(true);
    }
    // Including ones not written yet — the rule is a prefix, not a list.
    expect(isDeveloperSettingKey('telegram.somethingNobodyHasAddedYet')).toBe(true);
  });

  it('closes the same gap for discord.*, which had been missing', () => {
    expect(isDeveloperSettingKey('discord.announceChannelId')).toBe(true);
    expect(isDeveloperSettingKey('discord.publicKey')).toBe(true);
  });

  it('does not over-reach into unrelated keys', () => {
    expect(isDeveloperSettingKey('company_name')).toBe(false);
    expect(isDeveloperSettingKey('overtime_enabled')).toBe(false);
  });
});

describe('send gates', () => {
  it('refuses to send when the channel is off, even with a valid token', async () => {
    const { svc } = build([
      { key: TELEGRAM_SETTING_KEYS.botTokenEnc, value: encryptSecret(REAL_TOKEN) },
      { key: TELEGRAM_SETTING_KEYS.enabled, value: 'false' },
    ]);
    expect(await svc.ensureConfigured()).toBeNull();
    // ...but diagnostics still work, so an admin can verify before switching on.
    expect(await svc.ensureCredentials()).not.toBeNull();
  });

  it('defaults to off — installing this code does not start messaging anyone', async () => {
    const { svc } = build([]);
    const cfg = await svc.get();
    expect(cfg.enabled).toBe(false);
    expect(cfg.inboundEnabled).toBe(false);
    expect(cfg.alertChatId).toBe('');
    expect(await svc.ensureConfigured()).toBeNull();
  });

  it('parses the role allowlist as upper-cased CSV, empty meaning everyone', async () => {
    const { svc } = build([
      { key: TELEGRAM_SETTING_KEYS.loginAlertRoles, value: ' admin , hr_manager ' },
    ]);
    expect((await svc.get()).loginAlertRoles).toEqual(['ADMIN', 'HR_MANAGER']);

    const { svc: empty } = build([{ key: TELEGRAM_SETTING_KEYS.loginAlertRoles, value: '' }]);
    expect((await empty.get()).loginAlertRoles).toEqual([]);
  });
});
