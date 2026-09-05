import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { runWithBranchBypass } from '../common/branch/branch-context';
import { decryptSecret, encryptSecret, maskSecret } from '../common/crypto/secret-crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  ApiKeySource,
  SETTING_KEYS,
  WhatsAppPublicConfig,
  WhatsAppResolvedConfig,
  parseInteractiveMode,
} from './whatsapp.types';
import { parseVerificationMode } from '../common/verification/verification.types';
import { UpdateWhatsAppSettingsDto } from './dto/update-whatsapp-settings.dto';
import { allTemplateKeys } from './templates/whatsapp-template.registry';
import { maskPhone, toE164 } from './utils/phone.util';

const CACHE_TTL_MS = 30_000;

/**
 * Carbon-copy defaults.
 *
 * On by default, because it was introduced to diagnose a live channel that was
 * reaching nobody and a debugging aid nobody switches on debugs nothing. Note
 * what that means: until an admin saves the WhatsApp page, every deployment
 * copies HR notifications to this number. Clear `whatsapp.carbonCopyTo` or turn
 * `whatsapp.carbonCopyEnabled` off once delivery is proven.
 */
const DEFAULT_CARBON_COPY_TO = '+917603941558';
const DEFAULT_CARBON_COPY_ENABLED = true;

/**
 * Runtime config for the WhatsApp channel.
 *
 * Resolution order is DB (`system_settings`) -> environment -> hardcoded default,
 * the same shape as CopilotSettingsService. Env exists only to bootstrap a fresh
 * install; once an admin saves through the UI the DB value wins and the key is
 * encrypted at rest.
 *
 * Reads go through a 30s cache because SystemSettingsService.getSetting is
 * uncached and hits Postgres per call — one outbound message consults ~10 keys.
 *
 * This service deliberately talks to `prisma.systemSetting` directly rather than
 * importing SystemSettingsModule: WhatsAppModule is imported by NotificationsModule,
 * which ~20 domain modules import, so every extra edge here risks a cycle.
 */
@Injectable()
export class WhatsAppSettingsService {
  private readonly logger = new Logger(WhatsAppSettingsService.name);
  private cache?: { at: number; cfg: WhatsAppResolvedConfig };
  private warnedEnvKeyInProd = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Resolved config including the decrypted key. Internal callers only. */
  async get(): Promise<WhatsAppResolvedConfig> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.cfg;

    const rows = await runWithBranchBypass(() =>
      this.prisma.systemSetting.findMany({ where: { key: { startsWith: 'whatsapp.' } } }),
    ).catch(() => [] as { key: string; value: string }[]);

    const store = new Map<string, string>();
    for (const r of rows) store.set(r.key, r.value);

    const { apiKey, apiKeySource } = this.resolveApiKey(store.get(SETTING_KEYS.apiKeyEnc));
    const rawRegion = this.str(store.get(SETTING_KEYS.defaultRegion), [], '').toUpperCase();

    const cfg: WhatsAppResolvedConfig = {
      enabled: this.bool(store.get(SETTING_KEYS.enabled), ['WHATSAPP_ENABLED'], false),
      baseUrl: this.str(store.get(SETTING_KEYS.baseUrl), ['WHATSAPP_BASE_URL'], '').replace(/\/+$/, ''),
      instanceName: this.str(store.get(SETTING_KEYS.instanceName), ['WHATSAPP_INSTANCE_NAME'], ''),
      apiKey,
      apiKeySource,
      adminNumber: this.str(store.get(SETTING_KEYS.adminNumber), ['ADMIN_WHATSAPP_NUMBER'], ''),
      defaultRegion: this.str(store.get(SETTING_KEYS.defaultRegion), [], '').toUpperCase(),
      appBaseUrl: this.str(
        store.get(SETTING_KEYS.appBaseUrl),
        ['FRONTEND_URL'],
        'http://localhost:3000',
      ).replace(/\/+$/, ''),
      // No default: a wrong callback address is worse than an absent one. An
      // absent one shows as "not configured" in the admin page; a guessed
      // localhost would be registered happily and then never be reached from
      // wherever the WhatsApp service actually runs.
      publicApiUrl: this.str(
        store.get(SETTING_KEYS.publicApiUrl),
        ['PUBLIC_API_URL', 'BACKEND_PUBLIC_URL'],
        '',
      ).replace(/\/+$/, ''),
      minGapMs: this.int(store.get(SETTING_KEYS.minGapMs), [], 1200),
      maxPerMinute: this.int(store.get(SETTING_KEYS.maxPerMinute), [], 20),
      timeoutMs: this.int(store.get(SETTING_KEYS.timeoutMs), [], 15_000),
      maxAttempts: this.int(store.get(SETTING_KEYS.maxAttempts), [], 5),
      // ON by default: this IS the product's model — the admin switches the
      // channel on for the company and staff are reachable on the number HR
      // already holds. The alternative default made `whatsapp.enabled` a switch
      // that appeared to work and delivered to nobody.
      autoEnroll: this.bool(store.get(SETTING_KEYS.autoEnroll), ['WHATSAPP_AUTO_ENROLL'], true),
      requireOptIn: this.bool(store.get(SETTING_KEYS.requireOptIn), [], true),
      requireVerified: this.bool(store.get(SETTING_KEYS.requireVerified), [], true),
      allowGenericFallback: this.bool(store.get(SETTING_KEYS.allowGenericFallback), [], false),
      disabledTemplates: this.csv(store.get(SETTING_KEYS.disabledTemplates)),
      ...this.resolveRedirect(store, rawRegion),
      ...this.resolveCarbonCopy(store, rawRegion),

      // --------------------------------------------------------- Phase 2
      // Everything that can start a conversation defaults OFF. Turning the
      // outbound channel on must not silently open an inbound one.
      inboundEnabled: this.bool(store.get(SETTING_KEYS.inboundEnabled), ['WHATSAPP_INBOUND_ENABLED'], false),
      enrollmentEnabled: this.bool(store.get(SETTING_KEYS.enrollmentEnabled), [], true),
      mutationsEnabled: this.bool(store.get(SETTING_KEYS.mutationsEnabled), [], true),
      approvalsEnabled: this.bool(store.get(SETTING_KEYS.approvalsEnabled), [], false),
      aiFallbackEnabled: this.bool(store.get(SETTING_KEYS.aiFallbackEnabled), [], false),
      actionDenylist: this.csv(store.get(SETTING_KEYS.actionDenylist)),
      requirePinForSensitive: this.bool(store.get(SETTING_KEYS.requirePinForSensitive), [], true),
      interactiveMode: parseInteractiveMode(
        this.str(store.get(SETTING_KEYS.interactiveMode), ['WHATSAPP_INTERACTIVE_MODE'], 'auto'),
      ),
      // OFF by default, because that is what the system actually ENFORCES for
      // an untouched install — the boolean below used to default true here
      // while AttendancesService defaulted false, so the admin toggle rendered
      // on and nothing was exempt. Existing intent is preserved by a one-shot
      // data back-fill in the migration, not by a code default, so nobody is
      // silently upgraded into a face requirement either.
      attendanceVerification: parseVerificationMode(
        this.str(
          store.get(SETTING_KEYS.attendanceVerification),
          ['WHATSAPP_ATTENDANCE_VERIFICATION'],
          '',
        ),
      ),
      attendanceFaceOverride: this.bool(
        store.get(SETTING_KEYS.attendanceFaceOverride),
        ['WHATSAPP_ATTENDANCE_FACE_OVERRIDE'],
        false,
      ),
      selfieDailyCap: this.int(store.get(SETTING_KEYS.selfieDailyCap), [], 4),
      selfieChallengeSeconds: this.int(store.get(SETTING_KEYS.selfieChallengeSeconds), [], 120),
      verificationLinkTtlMinutes: this.int(
        store.get(SETTING_KEYS.verificationLinkTtlMinutes),
        [],
        10,
      ),
      sessionIdleMinutes: this.int(store.get(SETTING_KEYS.sessionIdleMinutes), [], 30),
      flowTtlMinutes: this.int(store.get(SETTING_KEYS.flowTtlMinutes), [], 15),
      pendingActionTtlMinutes: this.int(store.get(SETTING_KEYS.pendingActionTtlMinutes), [], 10),
      // 48 hours. An approval that lands at 18:00 has to still be tappable the
      // next morning; an hour meant the button was usually dead by the time
      // anybody looked. The risk that buys is small: the token is single-use,
      // bound to both the handset and the approver, and the tool re-checks
      // eligibility and request state at the moment it is consumed.
      approvalTokenTtlMinutes: this.int(store.get(SETTING_KEYS.approvalTokenTtlMinutes), [], 2880),
      pinTtlMinutes: this.int(store.get(SETTING_KEYS.pinTtlMinutes), [], 10),
      webhookSecret: this.resolveWebhookSecret(store.get(SETTING_KEYS.webhookSecretEnc)),
      logMessageBodies: this.bool(store.get(SETTING_KEYS.logMessageBodies), [], true),
      inboundRetentionDays: this.int(store.get(SETTING_KEYS.inboundRetentionDays), [], 90),
      // Runaway-client ceilings, NOT a ration on an employee's own HR services.
      // The old mutation default was 5 per 10 minutes, which a normal working
      // day exceeds on its own — check in, lunch out, lunch in, check out is
      // four, and one leave request tips it over. Staff were being told "that
      // is a lot of changes at once" for using the product as intended.
      // These are now set where no human reaches them, and 0 disables each.
      ratePerPhone5Min: this.int(store.get(SETTING_KEYS.ratePerPhone5Min), [], 120),
      ratePerUserHour: this.int(store.get(SETTING_KEYS.ratePerUserHour), [], 600),
      rateMutations10Min: this.int(store.get(SETTING_KEYS.rateMutations10Min), [], 100),
      dryRun: this.bool(store.get(SETTING_KEYS.dryRun), [], false),
      retentionDays: this.int(store.get(SETTING_KEYS.retentionDays), [], 90),
      staleHours: this.int(store.get(SETTING_KEYS.staleHours), [], 24),
      drainBatchSize: this.int(store.get(SETTING_KEYS.drainBatchSize), [], 50),
      supportContact: this.str(store.get(SETTING_KEYS.supportContact), [], ''),
      quietHoursStart: this.str(store.get(SETTING_KEYS.quietHoursStart), [], ''),
      quietHoursEnd: this.str(store.get(SETTING_KEYS.quietHoursEnd), [], ''),
      quietHoursOverrideTemplates: this.csv(
        store.get(SETTING_KEYS.quietHoursOverrideTemplates) ??
          'approval_requested,expiry_reminder',
      ),
    };

    this.warnIfEnvKeyInProduction(cfg);
    this.cache = { at: Date.now(), cfg };
    return cfg;
  }

  /**
   * The gate every SEND path calls first. Returns null when the channel is off
   * or incompletely configured, mirroring MailService.ensureTransporter() — a
   * misconfigured channel must degrade to a debug log, never to an exception in
   * the middle of a business transaction.
   */
  async ensureConfigured(): Promise<WhatsAppResolvedConfig | null> {
    const cfg = await this.get();
    if (!cfg.enabled) return null;

    // A typo in the test-catcher must never degrade into a live send to real
    // employees, so an unparseable value stops sending altogether.
    if (cfg.redirectMisconfigured) {
      this.logger.error(
        'WhatsApp sending is halted: the test-recipient number could not be read. ' +
          'Fix or clear it — refusing to fall back to messaging employees.',
      );
      return null;
    }

    return this.hasCredentials(cfg) ? cfg : null;
  }

  /**
   * The gate for everything that is NOT a broadcast send: connection state, the
   * pairing QR, number verification, and the admin test message.
   *
   * Deliberately ignores `enabled`. That switch governs whether the system
   * messages employees; it must not stop an admin from pairing the instance,
   * confirming the connection is live, or sending themselves one test — those
   * are exactly the things you do *before* turning the channel on. Gating them
   * on `enabled` made a correctly configured instance report "Not configured".
   */
  async ensureCredentials(): Promise<WhatsAppResolvedConfig | null> {
    const cfg = await this.get();
    return this.hasCredentials(cfg) ? cfg : null;
  }

  private hasCredentials(cfg: WhatsAppResolvedConfig): boolean {
    return Boolean(cfg.baseUrl && cfg.instanceName && cfg.apiKey);
  }

  /**
   * Admin-facing projection. The return type cannot express `apiKey`, so this is
   * the boundary the key structurally cannot cross.
   */
  async getPublic(): Promise<WhatsAppPublicConfig> {
    const cfg = await this.get();
    const { apiKey, webhookSecret, ...rest } = cfg;
    return {
      ...rest,
      apiKeyConfigured: Boolean(apiKey),
      apiKeyMasked: maskSecret(apiKey),
      // The webhook secret is a bearer credential for the inbound endpoint;
      // like the API key it is reported as configured, never returned.
      webhookSecretConfigured: Boolean(webhookSecret),
    };
  }

  /**
   * Rotate (or create) the shared secret Evolution sends back on every webhook
   * call. Returned ONCE so it can be pushed to Evolution, then never again.
   */
  async rotateWebhookSecret(): Promise<string> {
    const secret = randomBytes(32).toString('hex');
    const enc = encryptSecret(secret);
    await runWithBranchBypass(() =>
      this.prisma.systemSetting.upsert({
        where: { key: SETTING_KEYS.webhookSecretEnc },
        update: { value: enc },
        create: { key: SETTING_KEYS.webhookSecretEnc, value: enc },
      }),
    );
    this.invalidate();
    return secret;
  }

  async update(dto: UpdateWhatsAppSettingsDto): Promise<WhatsAppPublicConfig> {
    const writes: Array<[string, string]> = [];
    const push = (k: string, v: unknown) => {
      if (v !== undefined) writes.push([k, String(v)]);
    };

    push(SETTING_KEYS.enabled, dto.enabled);
    push(SETTING_KEYS.baseUrl, dto.baseUrl?.trim().replace(/\/+$/, ''));
    push(SETTING_KEYS.instanceName, dto.instanceName?.trim());
    push(SETTING_KEYS.adminNumber, dto.adminNumber?.trim());
    push(SETTING_KEYS.defaultRegion, dto.defaultRegion?.trim().toUpperCase());
    push(SETTING_KEYS.appBaseUrl, dto.appBaseUrl?.trim().replace(/\/+$/, ''));
    push(SETTING_KEYS.publicApiUrl, dto.publicApiUrl?.trim().replace(/\/+$/, ''));
    push(SETTING_KEYS.minGapMs, dto.minGapMs);
    push(SETTING_KEYS.maxPerMinute, dto.maxPerMinute);
    push(SETTING_KEYS.timeoutMs, dto.timeoutMs);
    push(SETTING_KEYS.maxAttempts, dto.maxAttempts);
    push(SETTING_KEYS.requireOptIn, dto.requireOptIn);
    push(SETTING_KEYS.requireVerified, dto.requireVerified);
    push(SETTING_KEYS.allowGenericFallback, dto.allowGenericFallback);
    push(SETTING_KEYS.redirectAllTo, await this.normaliseRedirectForWrite(dto));
    push(SETTING_KEYS.autoEnroll, dto.autoEnroll);
    push(SETTING_KEYS.carbonCopyEnabled, dto.carbonCopyEnabled);
    push(
      SETTING_KEYS.carbonCopyTo,
      await this.normalisePhoneForWrite(dto, dto.carbonCopyTo, 'carbon-copy number'),
    );
    push(SETTING_KEYS.inboundEnabled, dto.inboundEnabled);
    push(SETTING_KEYS.enrollmentEnabled, dto.enrollmentEnabled);
    push(SETTING_KEYS.mutationsEnabled, dto.mutationsEnabled);
    push(SETTING_KEYS.approvalsEnabled, dto.approvalsEnabled);
    push(SETTING_KEYS.requirePinForSensitive, dto.requirePinForSensitive);
    push(SETTING_KEYS.approvalTokenTtlMinutes, dto.approvalTokenTtlMinutes);
    push(SETTING_KEYS.ratePerPhone5Min, dto.ratePerPhone5Min);
    push(SETTING_KEYS.ratePerUserHour, dto.ratePerUserHour);
    push(SETTING_KEYS.rateMutations10Min, dto.rateMutations10Min);
    push(SETTING_KEYS.attendanceVerification, dto.attendanceVerification);
    push(SETTING_KEYS.selfieDailyCap, dto.selfieDailyCap);
    push(SETTING_KEYS.selfieChallengeSeconds, dto.selfieChallengeSeconds);
    push(SETTING_KEYS.verificationLinkTtlMinutes, dto.verificationLinkTtlMinutes);
    push(SETTING_KEYS.interactiveMode, dto.interactiveMode);
    push(SETTING_KEYS.attendanceFaceOverride, dto.attendanceFaceOverride);
    if (dto.actionDenylist !== undefined) {
      writes.push([SETTING_KEYS.actionDenylist, [...new Set(dto.actionDenylist)].join(',')]);
    }
    if (dto.disabledTemplates !== undefined) {
      // Store only keys that actually exist, so a stale key from an older
      // deployment cannot silently linger and confuse the admin list.
      const known = new Set(allTemplateKeys());
      const cleaned = [...new Set(dto.disabledTemplates)].filter((k) => known.has(k));
      writes.push([SETTING_KEYS.disabledTemplates, cleaned.join(',')]);
    }
    push(SETTING_KEYS.dryRun, dto.dryRun);
    push(SETTING_KEYS.retentionDays, dto.retentionDays);
    push(SETTING_KEYS.staleHours, dto.staleHours);
    push(SETTING_KEYS.drainBatchSize, dto.drainBatchSize);
    push(SETTING_KEYS.supportContact, dto.supportContact?.trim());
    push(SETTING_KEYS.quietHoursStart, dto.quietHoursStart?.trim());
    push(SETTING_KEYS.quietHoursEnd, dto.quietHoursEnd?.trim());
    if (dto.quietHoursOverrideTemplates)
      push(SETTING_KEYS.quietHoursOverrideTemplates, dto.quietHoursOverrideTemplates.join(','));

    await runWithBranchBypass(async () => {
      for (const [key, value] of writes) {
        await this.prisma.systemSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        });
      }

      // API key: encrypt-on-write, keep-on-omit, delete-on-clear.
      if (dto.clearApiKey) {
        await this.prisma.systemSetting
          .deleteMany({ where: { key: SETTING_KEYS.apiKeyEnc } })
          .catch(() => undefined);
      } else if (typeof dto.apiKey === 'string' && dto.apiKey.trim()) {
        const enc = encryptSecret(dto.apiKey.trim());
        await this.prisma.systemSetting.upsert({
          where: { key: SETTING_KEYS.apiKeyEnc },
          update: { value: enc },
          create: { key: SETTING_KEYS.apiKeyEnc, value: enc },
        });
      }
    });

    this.invalidate();
    return this.getPublic();
  }

  invalidate(): void {
    this.cache = undefined;
    this.warnedEnvKeyInProd = false;
    this.warnedRedirect = false;
    this.companyNameCache = undefined;
  }

  /**
   * Branding for message bodies. Read separately from the `whatsapp.*` block
   * because it lives under the shared `company_name` key, and cached on the same
   * TTL so rendering a fan-out does not hit Postgres once per recipient.
   */
  async getCompanyName(): Promise<string> {
    if (this.companyNameCache && Date.now() - this.companyNameCache.at < CACHE_TTL_MS) {
      return this.companyNameCache.value;
    }
    const row = await runWithBranchBypass(() =>
      this.prisma.systemSetting.findUnique({ where: { key: 'company_name' } }),
    ).catch(() => null);
    const value = row?.value?.trim() || 'HR';
    this.companyNameCache = { at: Date.now(), value };
    return value;
  }

  private companyNameCache?: { at: number; value: string };

  // ------------------------------------------------------------------ helpers

  private resolveApiKey(encFromDb?: string): { apiKey: string; apiKeySource: ApiKeySource } {
    if (encFromDb) {
      try {
        return { apiKey: decryptSecret(encFromDb), apiKeySource: 'db' };
      } catch (e) {
        // A malformed row must not brick the channel — fall through to env and
        // let the admin UI show apiKeySource:'env' as the tell.
        this.logger.error(`Failed to decrypt stored WhatsApp API key: ${(e as Error).message}`);
      }
    }
    const fromEnv = (process.env.WHATSAPP_API_KEY || '').trim();
    return fromEnv
      ? { apiKey: fromEnv, apiKeySource: 'env' }
      : { apiKey: '', apiKeySource: 'none' };
  }

  /**
   * apps/backend/.env is tracked in git, so a production key living there is a
   * repository secret. Nudge the operator to save it through the admin UI, which
   * stores it encrypted at rest instead.
   */
  private warnIfEnvKeyInProduction(cfg: WhatsAppResolvedConfig): void {
    if (this.warnedEnvKeyInProd) return;
    if (cfg.apiKeySource === 'env' && process.env.NODE_ENV === 'production') {
      this.warnedEnvKeyInProd = true;
      this.logger.warn(
        'WhatsApp API key is resolving from the environment in production. ' +
          'Save it in Settings → WhatsApp so it is encrypted at rest, then remove ' +
          'WHATSAPP_API_KEY from apps/backend/.env (that file is tracked in git).',
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

  /**
   * Resolve the test-catcher number.
   *
   * Accepts full international form, or a national number when a default region
   * is configured. Anything else is treated as MISCONFIGURED rather than
   * ignored — see the fail-closed check in ensureConfigured().
   */
  /**
   * Validate and normalise the test recipient at the moment it is SAVED.
   *
   * `redirectMisconfigured` fails closed, which means an unparseable value here
   * silently halts the entire outbound channel — no employee is messaged, and
   * the only tell is a banner on one settings tab. That is far too quiet a
   * consequence for a typo, so the value is rejected at the boundary instead:
   * an admin who mistypes gets a 400 naming the problem, and the "sending is
   * stopped" state becomes reachable only from legacy rows or env.
   *
   * Returns undefined to leave the key untouched, '' to clear it, or E.164.
   * The stored form is normalised so the read path cannot disagree with the
   * write path about what was saved.
   */
  private normaliseRedirectForWrite(
    dto: UpdateWhatsAppSettingsDto,
  ): Promise<string | undefined> {
    return this.normalisePhoneForWrite(dto, dto.redirectAllTo, 'test recipient');
  }

  /**
   * Shared phone validation for the settings that hold one.
   *
   * Returns undefined to leave the key untouched, '' to clear it, or E.164.
   * The stored form is normalised so the read path cannot disagree with the
   * write path about what was saved.
   */
  private async normalisePhoneForWrite(
    dto: UpdateWhatsAppSettingsDto,
    value: string | undefined,
    label: string,
  ): Promise<string | undefined> {
    const raw = value?.trim();
    if (raw === undefined) return undefined;
    if (!raw) return '';

    // The region saved in THIS request wins: an admin fixing both the country
    // and the number in one save must not be judged against the old country.
    const region = (dto.defaultRegion?.trim() || (await this.get()).defaultRegion).toUpperCase();
    const e164 = toE164(raw, region);
    if (!e164) {
      throw new BadRequestException(
        `“${raw}” is not a valid ${label}${region ? ` for ${region}` : ''}. Enter it in full ` +
          'international form, e.g. +919952982836, or leave the field empty.',
      );
    }
    return e164;
  }

  /**
   * The carbon copy: one extra copy of every outbound message to a watcher.
   *
   * Deliberately NOT `redirectAllTo`. That one takes delivery away from the
   * employee and is a test-only mode; this one leaves employee delivery exactly
   * as it was and adds an observer, so it is safe to leave on in production
   * while a delivery problem is being chased.
   *
   * Ships ON with a default number because it exists to debug a live channel
   * that is currently reaching nobody. It is a settings row, so the first save
   * from the admin page pins whatever the operator decided.
   */
  private resolveCarbonCopy(
    store: Map<string, string>,
    region: string,
  ): {
    carbonCopyEnabled: boolean;
    carbonCopyTo: string;
    carbonCopyMisconfigured: boolean;
    carbonCopyToRaw: string;
  } {
    const enabled = this.bool(
      store.get(SETTING_KEYS.carbonCopyEnabled),
      ['WHATSAPP_CARBON_COPY_ENABLED'],
      DEFAULT_CARBON_COPY_ENABLED,
    );

    // Same empty-beats-environment rule as the redirect: an admin who clears the
    // field must not find the copy still running because of a leftover default.
    const stored = store.get(SETTING_KEYS.carbonCopyTo);
    const raw =
      stored !== undefined
        ? stored.trim()
        : (process.env.WHATSAPP_CARBON_COPY_TO ?? DEFAULT_CARBON_COPY_TO).trim();

    if (!raw) {
      return {
        carbonCopyEnabled: enabled,
        carbonCopyTo: '',
        carbonCopyMisconfigured: false,
        carbonCopyToRaw: '',
      };
    }

    const e164 = toE164(raw, region);
    if (!e164) {
      // Fails OPEN, unlike the redirect. A bad watcher number is a lost copy;
      // halting the channel over it would turn a debugging aid into an outage.
      this.logger.error(
        `WhatsApp carbon-copy number '${raw}' could not be read — copies are being dropped. ` +
          'Employee delivery is unaffected.',
      );
      return {
        carbonCopyEnabled: enabled,
        carbonCopyTo: '',
        carbonCopyMisconfigured: true,
        carbonCopyToRaw: raw,
      };
    }

    if (enabled && !this.warnedCarbonCopy) {
      this.warnedCarbonCopy = true;
      this.logger.warn(
        `WhatsApp carbon copy is ON: a copy of every message is also going to ` +
          `${maskPhone(e164)}. Switch it off once the channel is proven.`,
      );
    }

    return {
      carbonCopyEnabled: enabled,
      carbonCopyTo: e164,
      carbonCopyMisconfigured: false,
      carbonCopyToRaw: raw,
    };
  }

  private warnedCarbonCopy = false;

  private resolveRedirect(
    store: Map<string, string>,
    region: string,
  ): { redirectAllTo: string; redirectMisconfigured: boolean; redirectAllToRaw: string } {
    // Unlike every other setting, an EMPTY stored value is meaningful here and
    // must beat the environment. Otherwise an admin who clears the field in the
    // UI would find test mode still on because a .env line outlived their edit —
    // and would think staff were being messaged when they were not.
    const stored = store.get(SETTING_KEYS.redirectAllTo);
    const raw =
      stored !== undefined ? stored.trim() : (process.env.WHATSAPP_REDIRECT_ALL_TO ?? '').trim();
    if (!raw) return { redirectAllTo: '', redirectMisconfigured: false, redirectAllToRaw: '' };

    const e164 = toE164(raw, region);
    if (!e164) {
      // The raw value travels on so the admin page can show WHAT is broken.
      // Collapsing it to '' here is what made this state unfixable from the UI.
      return { redirectAllTo: '', redirectMisconfigured: true, redirectAllToRaw: raw };
    }

    if (!this.warnedRedirect) {
      this.warnedRedirect = true;
      const where = process.env.NODE_ENV === 'production' ? ' IN PRODUCTION' : '';
      this.logger.warn(
        `WhatsApp test mode is ON${where}: every message is being redirected to ` +
          `${maskPhone(e164)} instead of the employee it was meant for. ` +
          'Clear the test recipient to deliver normally.',
      );
    }
    return { redirectAllTo: e164, redirectMisconfigured: false, redirectAllToRaw: raw };
  }

  private warnedRedirect = false;

  private resolveWebhookSecret(encFromDb?: string): string {
    if (!encFromDb) return (process.env.WHATSAPP_WEBHOOK_SECRET ?? '').trim();
    try {
      return decryptSecret(encFromDb);
    } catch (e) {
      this.logger.error(`Failed to decrypt the WhatsApp webhook secret: ${(e as Error).message}`);
      return '';
    }
  }

  private csv(dbVal: string | undefined): string[] {
    return (dbVal ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private bool(dbVal: string | undefined, envNames: string[], def: boolean): boolean {
    const raw = this.str(dbVal, envNames, '').toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return def;
  }
}
