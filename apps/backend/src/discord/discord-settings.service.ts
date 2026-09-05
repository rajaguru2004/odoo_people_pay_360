import { Injectable, Logger } from '@nestjs/common';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { decryptSecret, encryptSecret, maskSecret } from '../common/crypto/secret-crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DISCORD_SETTING_KEYS, DiscordPublicConfig, DiscordResolvedConfig } from './discord.types';
import { parseVerificationMode } from '../common/verification/verification.types';
import { UpdateDiscordSettingsDto } from './dto/update-discord-settings.dto';

const CACHE_TTL_MS = 30_000;

/**
 * Runtime config for the Discord channel.
 *
 * Deliberately the same shape as WhatsAppSettingsService — DB (encrypted) → env
 * → default, a 30s cache, and a public projection that structurally cannot
 * carry the secret. A second channel with a second config idiom is a second set
 * of mistakes.
 */
@Injectable()
export class DiscordSettingsService {
  private readonly logger = new Logger(DiscordSettingsService.name);
  private cache?: { at: number; cfg: DiscordResolvedConfig };
  private warnedEnvTokenInProd = false;

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<DiscordResolvedConfig> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.cfg;

    const rows = await runWithBranchBypass(() =>
      this.prisma.systemSetting.findMany({ where: { key: { startsWith: 'discord.' } } }),
    ).catch(() => [] as { key: string; value: string }[]);

    const store = new Map<string, string>();
    for (const r of rows) store.set(r.key, r.value);

    const { botToken, botTokenSource } = this.resolveToken(store.get(DISCORD_SETTING_KEYS.botTokenEnc));

    const cfg: DiscordResolvedConfig = {
      enabled: this.bool(store.get(DISCORD_SETTING_KEYS.enabled), ['DISCORD_ENABLED'], false),
      applicationId: this.str(store.get(DISCORD_SETTING_KEYS.applicationId), ['DISCORD_APPLICATION_ID'], ''),
      publicKey: this.str(store.get(DISCORD_SETTING_KEYS.publicKey), ['DISCORD_PUBLIC_KEY'], ''),
      botToken,
      botTokenSource,
      inboundEnabled: this.bool(store.get(DISCORD_SETTING_KEYS.inboundEnabled), ['DISCORD_INBOUND_ENABLED'], false),
      mutationsEnabled: this.bool(store.get(DISCORD_SETTING_KEYS.mutationsEnabled), [], true),
      linkingEnabled: this.bool(store.get(DISCORD_SETTING_KEYS.linkingEnabled), [], true),
      notificationsEnabled: this.bool(store.get(DISCORD_SETTING_KEYS.notificationsEnabled), [], true),
      announceChannelId: this.str(store.get(DISCORD_SETTING_KEYS.announceChannelId), [], ''),
      // How much this channel must prove before it may record attendance.
      // Enforced from the actor channel, never from a request argument.
      //
      // Resolves to OFF when unset, matching resolveVerificationMode. The two
      // must agree: a laxer default here would let the preflight wave a
      // check-in through that AttendancesService then refuses — with the very
      // message the preflight exists to avoid.
      attendanceVerification: parseVerificationMode(
        this.str(
          store.get(DISCORD_SETTING_KEYS.attendanceVerification),
          ['DISCORD_ATTENDANCE_VERIFICATION'],
          '',
        ),
      ),
      attendanceFaceOverride: this.bool(store.get(DISCORD_SETTING_KEYS.attendanceFaceOverride), [], false),
      verificationLinkTtlMinutes: this.int(
        store.get(DISCORD_SETTING_KEYS.verificationLinkTtlMinutes),
        [],
        10,
      ),
      redirectAllTo: this.str(store.get(DISCORD_SETTING_KEYS.redirectAllTo), ['DISCORD_REDIRECT_ALL_TO'], ''),
      retentionDays: this.int(store.get(DISCORD_SETTING_KEYS.retentionDays), [], 90),
      maxAttempts: this.int(store.get(DISCORD_SETTING_KEYS.maxAttempts), [], 5),
    };

    this.warnIfEnvTokenInProduction(cfg);
    this.cache = { at: Date.now(), cfg };
    return cfg;
  }

  /** Gate for sending. Null when off or incomplete — never an exception. */
  async ensureConfigured(): Promise<DiscordResolvedConfig | null> {
    const cfg = await this.get();
    if (!cfg.enabled) return null;
    return cfg.botToken && cfg.applicationId ? cfg : null;
  }

  /**
   * Gate for diagnostics and interaction handling: credentials only, ignoring
   * the `enabled` switch. Same reasoning as WhatsApp — an admin must be able to
   * register commands and verify the endpoint before turning delivery on.
   */
  async ensureCredentials(): Promise<DiscordResolvedConfig | null> {
    const cfg = await this.get();
    return cfg.botToken && cfg.applicationId ? cfg : null;
  }

  async getPublic(): Promise<DiscordPublicConfig> {
    const cfg = await this.get();
    const { botToken, ...rest } = cfg;
    return {
      ...rest,
      botTokenConfigured: Boolean(botToken),
      botTokenMasked: maskSecret(botToken),
    };
  }

  async update(dto: UpdateDiscordSettingsDto): Promise<DiscordPublicConfig> {
    const writes: Array<[string, string]> = [];
    const push = (k: string, v: unknown) => {
      if (v !== undefined) writes.push([k, String(v)]);
    };

    push(DISCORD_SETTING_KEYS.enabled, dto.enabled);
    push(DISCORD_SETTING_KEYS.applicationId, dto.applicationId?.trim());
    push(DISCORD_SETTING_KEYS.publicKey, dto.publicKey?.trim());
    push(DISCORD_SETTING_KEYS.inboundEnabled, dto.inboundEnabled);
    push(DISCORD_SETTING_KEYS.mutationsEnabled, dto.mutationsEnabled);
    push(DISCORD_SETTING_KEYS.linkingEnabled, dto.linkingEnabled);
    push(DISCORD_SETTING_KEYS.notificationsEnabled, dto.notificationsEnabled);
    push(DISCORD_SETTING_KEYS.announceChannelId, dto.announceChannelId?.trim());
    push(DISCORD_SETTING_KEYS.attendanceVerification, dto.attendanceVerification);
    push(DISCORD_SETTING_KEYS.attendanceFaceOverride, dto.attendanceFaceOverride);
    push(DISCORD_SETTING_KEYS.verificationLinkTtlMinutes, dto.verificationLinkTtlMinutes);
    push(DISCORD_SETTING_KEYS.redirectAllTo, dto.redirectAllTo?.trim());

    await runWithBranchBypass(async () => {
      for (const [key, value] of writes) {
        await this.prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
      }
      // encrypt-on-write, keep-on-omit, delete-on-clear
      if (dto.clearBotToken) {
        await this.prisma.systemSetting
          .deleteMany({ where: { key: DISCORD_SETTING_KEYS.botTokenEnc } })
          .catch(() => undefined);
      } else if (typeof dto.botToken === 'string' && dto.botToken.trim()) {
        const enc = encryptSecret(dto.botToken.trim());
        await this.prisma.systemSetting.upsert({
          where: { key: DISCORD_SETTING_KEYS.botTokenEnc },
          update: { value: enc },
          create: { key: DISCORD_SETTING_KEYS.botTokenEnc, value: enc },
        });
      }
    });

    this.invalidate();
    return this.getPublic();
  }

  invalidate(): void {
    this.cache = undefined;
    this.warnedEnvTokenInProd = false;
  }

  // ------------------------------------------------------------------ helpers

  private resolveToken(encFromDb?: string): {
    botToken: string;
    botTokenSource: 'db' | 'env' | 'none';
  } {
    if (encFromDb) {
      try {
        return { botToken: decryptSecret(encFromDb), botTokenSource: 'db' };
      } catch (e) {
        this.logger.error(`Failed to decrypt the Discord bot token: ${(e as Error).message}`);
      }
    }
    const fromEnv = (process.env.DISCORD_BOT_TOKEN || '').trim();
    return fromEnv ? { botToken: fromEnv, botTokenSource: 'env' } : { botToken: '', botTokenSource: 'none' };
  }

  private warnIfEnvTokenInProduction(cfg: DiscordResolvedConfig): void {
    if (this.warnedEnvTokenInProd) return;
    if (cfg.botTokenSource === 'env' && process.env.NODE_ENV === 'production') {
      this.warnedEnvTokenInProd = true;
      this.logger.warn(
        'Discord bot token is resolving from the environment in production. Save it in ' +
          'Settings → Discord so it is encrypted at rest, then remove DISCORD_BOT_TOKEN from ' +
          'apps/backend/.env (that file is tracked in git).',
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
}
