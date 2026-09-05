/**
 * WhatsApp (Evolution API v2.3) — shared types.
 *
 * The split between `WhatsAppResolvedConfig` and `WhatsAppPublicConfig` is the
 * first of four layers that keep the API key out of every HTTP response
 * (see whatsapp-settings.service.ts for the other three). `Resolved` carries the
 * decrypted key and is internal-only; the controller is typed to return `Public`,
 * so leaking the key would be a compile error rather than a review miss.
 */

import { VerificationMode } from '../common/verification/verification.types';

/** `system_settings` keys. All values are strings; booleans compare `=== 'true'`. */
export const SETTING_KEYS = {
  enabled: 'whatsapp.enabled',
  baseUrl: 'whatsapp.baseUrl',
  instanceName: 'whatsapp.instanceName',
  /** AES-256-GCM ciphertext. Never read by the UI, never writable via /system-settings. */
  apiKeyEnc: 'whatsapp.apiKeyEnc',
  adminNumber: 'whatsapp.adminNumber',
  defaultRegion: 'whatsapp.defaultRegion',
  appBaseUrl: 'whatsapp.appBaseUrl',
  /**
   * Public base address of THIS API, as reachable from the WhatsApp service.
   *
   * Deliberately separate from `appBaseUrl`: that one is the portal people click
   * links to, and in every deployment here the API answers on a different host
   * (api.hrm.… vs the portal). Deriving the callback from the portal address
   * would produce a URL that resolves, returns the Next.js 404 page, and leaves
   * inbound silently dead.
   */
  publicApiUrl: 'whatsapp.publicApiUrl',
  minGapMs: 'whatsapp.minGapMs',
  maxPerMinute: 'whatsapp.maxPerMinute',
  timeoutMs: 'whatsapp.timeoutMs',
  maxAttempts: 'whatsapp.maxAttempts',
  requireOptIn: 'whatsapp.requireOptIn',
  requireVerified: 'whatsapp.requireVerified',
  allowGenericFallback: 'whatsapp.allowGenericFallback',
  /**
   * CSV of template keys the admin has switched OFF.
   *
   * A denylist rather than an allowlist so the default (empty) means "every
   * registered update is sent", which preserves existing behaviour and means a
   * newly wired-up domain is live without an extra admin step. Putting a
   * template in the registry is already a deliberate act.
   */
  disabledTemplates: 'whatsapp.disabledTemplates',
  /**
   * Test-catcher. When set, EVERY outbound message goes to this one number
   * instead of the employee it was meant for. Exists so a developer can drive
   * real notification flows end to end without messaging real staff.
   */
  redirectAllTo: 'whatsapp.redirectAllTo',

  /**
   * Carbon copy. Unlike `redirectAllTo`, this does NOT take delivery away from
   * the employee — it sends one extra copy to a watcher so an operator can see
   * what the system is emitting without waiting for a staff member to report it.
   *
   * A copy is also emitted for a recipient the system could NOT reach, which is
   * the whole diagnostic value: "nothing arrived" and "nothing was ever
   * addressed" look identical from outside, and this separates them.
   */
  carbonCopyEnabled: 'whatsapp.carbonCopyEnabled',
  carbonCopyTo: 'whatsapp.carbonCopyTo',

  /**
   * Treat the phone number on an employee record as reachable, without waiting
   * for that employee to opt in from their profile.
   *
   * This is the product's actual model: WhatsApp is an HR channel the ADMIN
   * switches on for the company, not something each employee subscribes to.
   * Without it, `whatsapp.enabled` looked like the switch but was not — a
   * correctly configured channel with eleven numbers on file still delivered to
   * nobody, and nothing on the settings page said why.
   *
   * An employee who has explicitly opted OUT is never re-enrolled by this.
   */
  autoEnroll: 'whatsapp.autoEnroll',

  // ---------------------------------------------------------------- Phase 2
  inboundEnabled: 'whatsapp.inboundEnabled',
  enrollmentEnabled: 'whatsapp.enrollmentEnabled',
  /** Read-only pilot: reads answer, writes politely decline. */
  mutationsEnabled: 'whatsapp.mutationsEnabled',
  approvalsEnabled: 'whatsapp.approvalsEnabled',
  aiFallbackEnabled: 'whatsapp.aiFallbackEnabled',
  /** CSV of action keys to hot-disable without a deploy. */
  actionDenylist: 'whatsapp.actionDenylist',
  requirePinForSensitive: 'whatsapp.requirePinForSensitive',
  /** One of INTERACTIVE_MODES. See that constant for what each one means. */
  interactiveMode: 'whatsapp.interactiveMode',
  /**
   * How attendance is verified over this channel — one of VERIFICATION_MODE.
   * Enforced from the actor channel, never from an argument. Per-action
   * overrides live under `${key}.CHECKIN` and friends.
   */
  attendanceVerification: 'whatsapp.attendanceVerification',
  /**
   * @deprecated Superseded by `attendanceVerification`. Still resolved so an
   * admin who deliberately switched this on keeps exactly today's behaviour;
   * read only when no enum value exists. Removed one release after rollout.
   */
  attendanceFaceOverride: 'whatsapp.attendanceFaceOverride',
  /** Accepted selfie punches per employee per day. */
  selfieDailyCap: 'whatsapp.selfieDailyCap',
  /** How long a photo has to arrive after the bot asks for one. */
  selfieChallengeSeconds: 'whatsapp.selfieChallengeSeconds',
  /** TTL of the one-time verification link. */
  verificationLinkTtlMinutes: 'whatsapp.verificationLinkTtlMinutes',
  sessionIdleMinutes: 'whatsapp.sessionIdleMinutes',
  flowTtlMinutes: 'whatsapp.flowTtlMinutes',
  pendingActionTtlMinutes: 'whatsapp.pendingActionTtlMinutes',
  approvalTokenTtlMinutes: 'whatsapp.approvalTokenTtlMinutes',
  pinTtlMinutes: 'whatsapp.pinTtlMinutes',
  webhookSecretEnc: 'whatsapp.webhookSecretEnc',
  logMessageBodies: 'whatsapp.logMessageBodies',
  inboundRetentionDays: 'whatsapp.inboundRetentionDays',
  ratePerPhone5Min: 'whatsapp.ratePerPhone5Min',
  ratePerUserHour: 'whatsapp.ratePerUserHour',
  rateMutations10Min: 'whatsapp.rateMutations10Min',
  dryRun: 'whatsapp.dryRun',
  retentionDays: 'whatsapp.retentionDays',
  staleHours: 'whatsapp.staleHours',
  drainBatchSize: 'whatsapp.drainBatchSize',

  // ------------------------------------------------------------------- voice
  /** Who to point somebody at when the bot genuinely cannot help. */
  supportContact: 'whatsapp.supportContact',

  // ------------------------------------------------------------ quiet hours
  /**
   * Outbound only, and messages are HELD, never dropped. A reply to somebody
   * who just messaged us is never held — answering a question is not the same
   * as starting a conversation at 23:00.
   */
  quietHoursStart: 'whatsapp.quietHoursStart',
  quietHoursEnd: 'whatsapp.quietHoursEnd',
  /** Template keys that go out regardless. */
  quietHoursOverrideTemplates: 'whatsapp.quietHoursOverrideTemplates',
} as const;

/**
 * How much of a reply is tappable.
 *
 *  - `auto`    — a sectioned list for menus, buttons for confirmations, text if
 *                either fails. The default, and what almost everyone wants.
 *  - `buttons` — never a list. The safety valve: list rendering has broken on
 *                this provider before, and this is the one-setting recovery.
 *  - `poll`    — menus as native polls. The only tappable form that renders on
 *                a personal (non-Business) WhatsApp account, at the cost of a
 *                vote carrying only the option text.
 *  - `text`    — nothing tappable at all.
 *
 * An unrecognised stored value resolves to `auto` rather than to a fourth,
 * accidental behaviour: the field was free text before this list existed.
 */
export const INTERACTIVE_MODES = ['auto', 'buttons', 'poll', 'text'] as const;
export type InteractiveMode = (typeof INTERACTIVE_MODES)[number];

export function parseInteractiveMode(raw: string | null | undefined): InteractiveMode {
  const v = (raw ?? '').trim().toLowerCase();
  return (INTERACTIVE_MODES as readonly string[]).includes(v) ? (v as InteractiveMode) : 'auto';
}

export interface WhatsAppResolvedConfig {
  enabled: boolean;
  baseUrl: string;
  instanceName: string;
  /** Decrypted. INTERNAL ONLY — must never reach a controller return type. */
  apiKey: string;
  apiKeySource: ApiKeySource;
  adminNumber: string;
  /** ISO-3166 alpha-2 fallback when a branch has no country set. */
  defaultRegion: string;
  appBaseUrl: string;
  /** Public base of this API for the WhatsApp service's callbacks. '' when unset. */
  publicApiUrl: string;
  minGapMs: number;
  maxPerMinute: number;
  timeoutMs: number;
  maxAttempts: number;
  requireOptIn: boolean;
  requireVerified: boolean;
  allowGenericFallback: boolean;
  /** Template keys the admin has switched off. Empty means everything is on. */
  disabledTemplates: string[];
  /**
   * Test-catcher target in E.164, or '' when off.
   *
   * While set, no employee can be messaged: every message is re-addressed here,
   * which is also why the opt-in / verified gates are skipped — there is nobody
   * to protect when the only possible recipient is this one test handset.
   */
  redirectAllTo: string;
  /**
   * True when `redirectAllTo` was configured but could not be parsed.
   *
   * Fails CLOSED: sending is disabled entirely rather than falling back to real
   * employees, because a typo in the catcher must never become a live send.
   */
  redirectMisconfigured: boolean;
  /**
   * The value as it is actually STORED, before parsing — so an admin can see and
   * correct a typo that `redirectAllTo` has already collapsed to ''.
   *
   * Without this the failure is unfixable from the product: a stored
   * '917603941558' parses to nothing, the admin page renders an empty field, and
   * the banner tells the reader to clear something that already looks cleared.
   * That is exactly how one live channel stayed dark for 19 days.
   */
  redirectAllToRaw: string;

  /**
   * Reach employees on the number already held on their HR record, without a
   * separate opt-in step. See SETTING_KEYS.autoEnroll.
   */
  autoEnroll: boolean;

  /** Master switch for the carbon copy. */
  carbonCopyEnabled: boolean;
  /** Watcher number in E.164, or '' when unset or unreadable. */
  carbonCopyTo: string;
  /** Configured but unparseable. Copies are dropped; employees are UNAFFECTED. */
  carbonCopyMisconfigured: boolean;
  /** As stored, so the admin page can show what to correct. */
  carbonCopyToRaw: string;

  // ---------------------------------------------------------------- Phase 2
  inboundEnabled: boolean;
  enrollmentEnabled: boolean;
  mutationsEnabled: boolean;
  approvalsEnabled: boolean;
  aiFallbackEnabled: boolean;
  actionDenylist: string[];
  requirePinForSensitive: boolean;
  /** One of INTERACTIVE_MODES; anything else is coerced to 'auto' on read. */
  interactiveMode: InteractiveMode;
  /** How attendance is verified over WhatsApp. See VERIFICATION_MODE. */
  attendanceVerification: VerificationMode;
  /** @deprecated Legacy boolean, resolved only when no enum value is stored. */
  attendanceFaceOverride: boolean;
  selfieDailyCap: number;
  selfieChallengeSeconds: number;
  verificationLinkTtlMinutes: number;
  sessionIdleMinutes: number;
  flowTtlMinutes: number;
  pendingActionTtlMinutes: number;
  approvalTokenTtlMinutes: number;
  pinTtlMinutes: number;
  /** Decrypted shared secret Evolution sends back on every webhook call. */
  webhookSecret: string;
  logMessageBodies: boolean;
  inboundRetentionDays: number;
  ratePerPhone5Min: number;
  ratePerUserHour: number;
  rateMutations10Min: number;
  /** Enqueue and render normally, but mark rows SKIPPED instead of sending. */
  dryRun: boolean;
  retentionDays: number;
  /** Queued rows older than this are dropped rather than sent late. */
  staleHours: number;
  drainBatchSize: number;
  supportContact: string;
  /** 'HH:MM', or '' when quiet hours are off. */
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursOverrideTemplates: string[];
}

export type ApiKeySource = 'db' | 'env' | 'none';

/** Admin-facing projection. Structurally cannot carry the key. */
export interface WhatsAppPublicConfig
  extends Omit<WhatsAppResolvedConfig, 'apiKey' | 'webhookSecret'> {
  apiKeyConfigured: boolean;
  /** Non-reversible hint, e.g. "••••+az1". */
  apiKeyMasked: string;
  webhookSecretConfigured: boolean;
}

/** Identity lifecycle. ACTIVE is the only state that can act. */
export const IDENTITY_STATUS = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  BLOCKED: 'BLOCKED',
  REVOKED: 'REVOKED',
} as const;
export type IdentityStatus = (typeof IDENTITY_STATUS)[keyof typeof IDENTITY_STATUS];

export const INBOUND_STATUS = {
  RECEIVED: 'RECEIVED',
  PROCESSING: 'PROCESSING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  IGNORED: 'IGNORED',
} as const;
export type InboundStatus = (typeof INBOUND_STATUS)[keyof typeof INBOUND_STATUS];

/** Outcome of one Evolution send. The client never throws on transport failure. */
export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /**
   * Whether a retry could plausibly succeed. 4xx (other than 408/429) is a bad
   * number / bad instance / bad key — retrying only burns attempts.
   */
  retryable: boolean;
  status?: number;
}

export type ConnectionState = 'open' | 'connecting' | 'close' | 'unknown';

export interface ConnectionStateResult {
  state: ConnectionState;
  raw?: unknown;
  error?: string;
}

export interface QrResult {
  /** data:image/png;base64,... or a bare base64 payload, as Evolution returns it. */
  base64?: string;
  /** Some Evolution builds return a pairing code instead of / alongside the QR. */
  pairingCode?: string;
  count?: number;
  error?: string;
}

/** Outbox row status. Mirrors `whatsapp_messages.status`. */
export const OUTBOX_STATUS = {
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;
export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

/** How a `whatsapp_identities` row got its number. */
export const IDENTITY_SOURCE = {
  EMPLOYEE_PHONE: 'EMPLOYEE_PHONE',
  SELF: 'SELF',
  ADMIN: 'ADMIN',
} as const;
export type IdentitySource = (typeof IDENTITY_SOURCE)[keyof typeof IDENTITY_SOURCE];

/**
 * Consecutive hard failures after which an identity auto-suspends (verified -> false),
 * so a dead number stops consuming outbox attempts forever and surfaces in the admin UI.
 */
export const IDENTITY_FAILURE_SUSPEND_AT = 5;

/** Backoff ladder, indexed by (attempts - 1). Jitter is applied on top. */
export const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 14_400_000];

/** A row stuck in SENDING longer than this is reclaimed by the drainer. */
export const SENDING_RECLAIM_MS = 10 * 60_000;

// ------------------------------------------------------------------- webhook

/**
 * Path Evolution must POST to, relative to the API root.
 *
 * Declared here rather than inlined in the UI because three places must agree:
 * the @Controller that serves it, the register call that tells Evolution about
 * it, and the address the admin copies into the WhatsApp service by hand. A
 * literal in any of those would drift from the route without a test failing.
 * There is no global prefix (see main.ts), so this is the whole path.
 */
export const WHATSAPP_WEBHOOK_PATH = '/whatsapp/webhook';

/** Header carrying the shared secret on every callback. */
export const WHATSAPP_WEBHOOK_HEADER = 'x-hrms-webhook-token';

/**
 * Events we subscribe to. Anything outside this list has no consumer and would
 * only fill the inbound log with contact/chat churn.
 */
export const WHATSAPP_WEBHOOK_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
] as const;

/** Full callback URL for a public API base, or '' when the base is unset. */
export function buildWebhookUrl(publicApiUrl: string | null | undefined): string {
  const base = (publicApiUrl ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}${WHATSAPP_WEBHOOK_PATH}` : '';
}

/** What the admin page needs to wire up (or hand-configure) the callback. */
export interface WhatsAppWebhookConfig {
  /** The address to paste into the WhatsApp service. '' until a base is set. */
  webhookUrl: string;
  /** Public API base the URL was built from. */
  publicApiUrl: string;
  /** Constant path, so the UI can show the shape even with no base configured. */
  path: string;
  headerName: string;
  events: string[];
  secretConfigured: boolean;
  /** Whether WhatsApp credentials are set at all — nothing below is known without them. */
  configured: boolean;
  /** What the WhatsApp service currently has on file. null when unknown. */
  registeredUrl: string | null;
  registeredEnabled: boolean | null;
  registeredEvents: string[];
  /**
   * Events we need that the service is NOT subscribed to.
   *
   * Separate from `matches` because the two fail differently: a wrong URL means
   * nothing arrives at all, while a missing event means SOME things arrive and
   * others never do — a live instance found in the wild was subscribed to
   * MESSAGES_UPSERT only, so the chatbot answered while delivery receipts and
   * connection drops went unnoticed forever.
   */
  missingEvents: string[];
  /**
   * Set when the configured account name is not one the WhatsApp service knows.
   * Null when it is fine, or when the list could not be read — an unreachable
   * server must never be reported as "your account does not exist".
   */
  unknownInstance: { configured: string; available: string[] } | null;
  /**
   * True only when the service's stored URL equals the one we would register.
   * The single question the admin actually has — "is inbound wired up?" — which
   * neither URL answers alone.
   */
  matches: boolean;
  /** Populated when the service could not be reached; the rest is then unknown. */
  error: string | null;
}
