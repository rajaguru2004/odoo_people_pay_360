import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { decryptSecret, encryptSecret, maskSecret } from '../common/crypto/secret-crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TELEGRAM_SETTING_KEYS, TelegramPublicConfig, TelegramResolvedConfig } from './telegram.types';
import { UpdateTelegramSettingsDto } from './dto/update-telegram-settings.dto';
import { normalizeChatId } from './render/chat-id';

const CACHE_TTL_MS = 30_000;

/**
 * Runtime config for the Telegram channel.
 *
 * Deliberately the same shape as DiscordSettingsService — DB (encrypted) → env
 * → default, a 30 s cache, and a public projection that structurally cannot
 * carry a secret. A third channel with a third config idiom is a third set of
 * mistakes.
 */
@Injectable()
export class TelegramSettingsService {
  private readonly logger = new Logger(TelegramSettingsService.name);
  private cache?: { at: number; cfg: TelegramResolvedConfig };
  private warnedEnvTokenInProd = false;

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<TelegramResolvedConfig> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.cfg;

    const rows = await runWithBranchBypass(() =>
      this.prisma.systemSetting.findMany({ where: { key: { startsWith: 'telegram.' } } }),
    ).catch(() => [] as { key: string; value: string }[]);

    const store = new Map<string, string>();
    for (const r of rows) store.set(r.key, r.value);

    const { botToken, botTokenSource } = this.resolveToken(
      store.get(TELEGRAM_SETTING_KEYS.botTokenEnc),
    );

    const cfg: TelegramResolvedConfig = {
      enabled: this.bool(store.get(TELEGRAM_SETTING_KEYS.enabled), ['TELEGRAM_ENABLED'], false),
      botToken,
      botTokenSource,
      inboundEnabled: this.bool(
        store.get(TELEGRAM_SETTING_KEYS.inboundEnabled),
        ['TELEGRAM_INBOUND_ENABLED'],
        false,
      ),
      webhookSecret: this.resolveWebhookSecret(store.get(TELEGRAM_SETTING_KEYS.webhookSecretEnc)),
      linkingEnabled: this.bool(store.get(TELEGRAM_SETTING_KEYS.linkingEnabled), [], true),
      notificationsEnabled: this.bool(
        store.get(TELEGRAM_SETTING_KEYS.notificationsEnabled),
        [],
        true,
      ),

      // Normalised on READ as well as on write. The write path only protects
      // values saved after this code shipped; a deployment that already stored
      // a dirty id would otherwise keep failing until somebody re-saved the
      // form, and the symptom ("chat not found") gives no hint that re-saving
      // is the fix. Reading through the same function repairs it in place.
      alertChatId: normalizeChatId(
        this.str(store.get(TELEGRAM_SETTING_KEYS.alertChatId), ['TELEGRAM_ALERT_CHAT_ID'], ''),
      ).value,
      loginAlertsEnabled: this.bool(store.get(TELEGRAM_SETTING_KEYS.loginAlertsEnabled), [], true),
      loginAlertFailures: this.bool(store.get(TELEGRAM_SETTING_KEYS.loginAlertFailures), [], true),
      loginAlertGeo: this.bool(store.get(TELEGRAM_SETTING_KEYS.loginAlertGeo), [], true),
      geoLookupUrl: this.str(
        store.get(TELEGRAM_SETTING_KEYS.geoLookupUrl),
        ['TELEGRAM_GEO_LOOKUP_URL'],
        // Free, keyless, and the field list is pinned so the response stays small.
        'http://ip-api.com/json/{ip}?fields=status,country,regionName,city,isp,as',
      ),
      loginAlertRoles: this.csv(store.get(TELEGRAM_SETTING_KEYS.loginAlertRoles)),
      loginAlertFailureMaxPerHour: this.int(
        store.get(TELEGRAM_SETTING_KEYS.loginAlertFailureMaxPerHour),
        [],
        10,
      ),

      redirectAllTo: normalizeChatId(
        this.str(store.get(TELEGRAM_SETTING_KEYS.redirectAllTo), ['TELEGRAM_REDIRECT_ALL_TO'], ''),
      ).value,
      retentionDays: this.int(store.get(TELEGRAM_SETTING_KEYS.retentionDays), [], 90),
      maxAttempts: this.int(store.get(TELEGRAM_SETTING_KEYS.maxAttempts), [], 5),
    };

    this.warnIfEnvTokenInProduction(cfg);
    this.cache = { at: Date.now(), cfg };
    return cfg;
  }

  /** Gate for sending. Null when off or incomplete — never an exception. */
  async ensureConfigured(): Promise<TelegramResolvedConfig | null> {
    const cfg = await this.get();
    if (!cfg.enabled) return null;
    return cfg.botToken ? cfg : null;
  }

  /**
   * Gate for diagnostics and webhook handling: credentials only, ignoring the
   * `enabled` switch. Same reasoning as the other two channels — an admin must
   * be able to register the webhook and verify the bot before turning delivery
   * on.
   */
  async ensureCredentials(): Promise<TelegramResolvedConfig | null> {
    const cfg = await this.get();
    return cfg.botToken ? cfg : null;
  }

  async getPublic(): Promise<TelegramPublicConfig> {
    const cfg = await this.get();
    const { botToken, webhookSecret, ...rest } = cfg;
    return {
      ...rest,
      botTokenConfigured: Boolean(botToken),
      botTokenMasked: maskSecret(botToken),
      webhookSecretConfigured: Boolean(webhookSecret),
    };
  }

  async update(dto: UpdateTelegramSettingsDto): Promise<TelegramPublicConfig> {
    const writes: Array<[string, string]> = [];
    const push = (k: string, v: unknown) => {
      if (v !== undefined) writes.push([k, String(v)]);
    };

    push(TELEGRAM_SETTING_KEYS.enabled, dto.enabled);
    push(TELEGRAM_SETTING_KEYS.inboundEnabled, dto.inboundEnabled);
    push(TELEGRAM_SETTING_KEYS.linkingEnabled, dto.linkingEnabled);
    push(TELEGRAM_SETTING_KEYS.notificationsEnabled, dto.notificationsEnabled);
    // Normalised, not stored verbatim. A pasted "Chat ID: -5544539023" or a
    // typographic dash is indistinguishable from a correct value on screen, and
    // Telegram answers both with the same "chat not found" an hour later.
    if (dto.alertChatId !== undefined) {
      const parsed = normalizeChatId(dto.alertChatId);
      if (parsed.changed) {
        this.logger.log(
          `Alert chat id cleaned up on save: ${JSON.stringify(dto.alertChatId)} -> ${JSON.stringify(parsed.value)}`,
        );
      }
      push(TELEGRAM_SETTING_KEYS.alertChatId, parsed.value);
    }
    push(TELEGRAM_SETTING_KEYS.loginAlertsEnabled, dto.loginAlertsEnabled);
    push(TELEGRAM_SETTING_KEYS.loginAlertFailures, dto.loginAlertFailures);
    push(TELEGRAM_SETTING_KEYS.loginAlertGeo, dto.loginAlertGeo);
    push(TELEGRAM_SETTING_KEYS.geoLookupUrl, dto.geoLookupUrl?.trim());
    push(TELEGRAM_SETTING_KEYS.loginAlertRoles, dto.loginAlertRoles?.trim());
    push(TELEGRAM_SETTING_KEYS.loginAlertFailureMaxPerHour, dto.loginAlertFailureMaxPerHour);
    // Same treatment: redirectAllTo is a chat id too, and it overrides EVERY
    // recipient — a dirty value here silently black-holes all staff messages.
    if (dto.redirectAllTo !== undefined) {
      push(TELEGRAM_SETTING_KEYS.redirectAllTo, normalizeChatId(dto.redirectAllTo).value);
    }
    push(TELEGRAM_SETTING_KEYS.retentionDays, dto.retentionDays);

    await runWithBranchBypass(async () => {
      for (const [key, value] of writes) {
        await this.prisma.systemSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        });
      }
      // encrypt-on-write, keep-on-omit, delete-on-clear
      if (dto.clearBotToken) {
        await this.prisma.systemSetting
          .deleteMany({ where: { key: TELEGRAM_SETTING_KEYS.botTokenEnc } })
          .catch(() => undefined);
      } else if (typeof dto.botToken === 'string' && dto.botToken.trim()) {
        await this.writeSecret(TELEGRAM_SETTING_KEYS.botTokenEnc, dto.botToken.trim());
      }
      if (typeof dto.webhookSecret === 'string' && dto.webhookSecret.trim()) {
        await this.writeSecret(TELEGRAM_SETTING_KEYS.webhookSecretEnc, dto.webhookSecret.trim());
      }
    });

    this.invalidate();
    return this.getPublic();
  }

  /**
   * Mint a webhook secret if none exists, and return it.
   *
   * Returned in the clear exactly once, to the ADMIN calling `setWebhook` —
   * which has to hand the same value to Telegram, so there is no version of
   * this that keeps it inside the process.
   */
  async ensureWebhookSecret(): Promise<string> {
    const cfg = await this.get();
    if (cfg.webhookSecret) return cfg.webhookSecret;
    // Telegram allows A-Z a-z 0-9 _ - only, 1..256 chars.
    const secret = randomBytes(32).toString('base64url');
    await runWithBranchBypass(() =>
      this.writeSecret(TELEGRAM_SETTING_KEYS.webhookSecretEnc, secret),
    );
    this.invalidate();
    return secret;
  }

  invalidate(): void {
    this.cache = undefined;
    this.warnedEnvTokenInProd = false;
  }

  // ------------------------------------------------------------------ helpers

  private async writeSecret(key: string, plain: string): Promise<void> {
    const enc = encryptSecret(plain);
    await this.prisma.systemSetting.upsert({
      where: { key },
      update: { value: enc },
      create: { key, value: enc },
    });
  }

  private resolveToken(encFromDb?: string): {
    botToken: string;
    botTokenSource: 'db' | 'env' | 'none';
  } {
    if (encFromDb) {
      try {
        return { botToken: decryptSecret(encFromDb), botTokenSource: 'db' };
      } catch (e) {
        this.logger.error(`Failed to decrypt the Telegram bot token: ${(e as Error).message}`);
      }
    }
    const fromEnv = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    return fromEnv
      ? { botToken: fromEnv, botTokenSource: 'env' }
      : { botToken: '', botTokenSource: 'none' };
  }

  private resolveWebhookSecret(encFromDb?: string): string {
    if (encFromDb) {
      try {
        return decryptSecret(encFromDb);
      } catch (e) {
        this.logger.error(`Failed to decrypt the Telegram webhook secret: ${(e as Error).message}`);
      }
    }
    return (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  }

  private warnIfEnvTokenInProduction(cfg: TelegramResolvedConfig): void {
    if (this.warnedEnvTokenInProd) return;
    if (cfg.botTokenSource === 'env' && process.env.NODE_ENV === 'production') {
      this.warnedEnvTokenInProd = true;
      this.logger.warn(
        'Telegram bot token is resolving from the environment in production. Save it via ' +
          'PUT /telegram/settings so it is encrypted at rest, then remove TELEGRAM_BOT_TOKEN ' +
          'from apps/backend/.env (that file is tracked in git).',
      );
    }
  }

  private str(dbVal: string | undefined, envNames: string[], def: string): string {
    if (dbVal !== undefined && dbVal !== null && dbVal.trim() !== '') return dbVal.trim();
    for (const n of envNames) {
      const v = process.env[n]?.trim();
      if (v) return v;
    }
    return def;
  }

  private int(dbVal: string | undefined, envNames: string[], def: number): number {
    const raw = this.str(dbVal, envNames, '');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  }

  private bool(dbVal: string | undefined, envNames: string[], def: boolean): boolean {
    const raw = this.str(dbVal, envNames, '').toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return def;
  }

  /** Empty = every role. An empty list must not mean "nobody". */
  private csv(dbVal: string | undefined): string[] {
    return (dbVal ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }
}
