/**
 * WhatsApp channel (Evolution API) admin + self-service types.
 *
 * Note what is absent: there is no `apiKey` field anywhere. The backend's read
 * projection is typed so the key cannot cross the HTTP boundary; the client only
 * ever learns whether one is configured and a masked hint.
 */

export type ApiKeySource = 'db' | 'env' | 'none';
export type ConnectionState = 'open' | 'connecting' | 'close' | 'unknown';
export type OutboxStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface WhatsAppSettings {
  enabled: boolean;
  baseUrl: string;
  instanceName: string;
  apiKeyConfigured: boolean;
  apiKeyMasked: string;
  apiKeySource: ApiKeySource;
  adminNumber: string;
  defaultRegion: string;
  appBaseUrl: string;
  /** Public base of the API, used to build the inbound callback URL. */
  publicApiUrl: string;
  minGapMs: number;
  maxPerMinute: number;
  timeoutMs: number;
  maxAttempts: number;
  requireOptIn: boolean;
  requireVerified: boolean;
  allowGenericFallback: boolean;
  /** Keys the admin has switched off. Empty means every update is sent. */
  disabledTemplates: string[];
  /** 'auto' | 'buttons' | 'poll' | 'text' — how much of a reply is tappable. */
  interactiveMode: string;
  /** Test recipient. While set, every message goes here instead of to staff. */
  redirectAllTo: string;
  /** Configured but unreadable — sending is halted rather than going to staff. */
  redirectMisconfigured: boolean;
  /**
   * The value as STORED, before parsing. Equal to `redirectAllTo` when it parsed.
   * When it did not, this is the only place the offending text survives — the
   * field must bind to this, or the admin cannot see what to correct.
   */
  redirectAllToRaw: string;
  /** Reach staff on the number HR already holds, with no separate opt-in step. */
  autoEnroll: boolean;
  /** Send one EXTRA copy of every message to a watcher; employees still get theirs. */
  carbonCopyEnabled: boolean;
  carbonCopyTo: string;
  carbonCopyMisconfigured: boolean;
  carbonCopyToRaw: string;
  dryRun: boolean;
  retentionDays: number;
  staleHours: number;
  drainBatchSize: number;

  // ------------------------------------------------------------ two-way use
  // Every one of these was already returned by the API and already accepted by
  // the write DTO; the UI simply had no controls for them, so an admin could
  // not switch the whole two-way channel on or off from the product at all.
  inboundEnabled: boolean;
  enrollmentEnabled: boolean;
  mutationsEnabled: boolean;
  approvalsEnabled: boolean;
  aiFallbackEnabled: boolean;
  requirePinForSensitive: boolean;
  /** Action keys switched off, hot-reloadable without a deploy. */
  actionDenylist: string[];
  webhookSecretConfigured: boolean;

  sessionIdleMinutes: number;
  flowTtlMinutes: number;
  pendingActionTtlMinutes: number;
  approvalTokenTtlMinutes: number;
  pinTtlMinutes: number;
  logMessageBodies: boolean;
  inboundRetentionDays: number;
  ratePerPhone5Min: number;
  ratePerUserHour: number;
  rateMutations10Min: number;

  // ------------------------------------------------------------ verification
  /** OFF | IDENTITY_ONLY | SELFIE_IN_CHAT | SECURE_LINK. */
  attendanceVerification: string;
  /** @deprecated Superseded by attendanceVerification. */
  attendanceFaceOverride: boolean;
  selfieDailyCap: number;
  selfieChallengeSeconds: number;
  verificationLinkTtlMinutes: number;

  // -------------------------------------------------------- voice and hours
  supportContact: string;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursOverrideTemplates: string[];
}

/**
 * Result of POST /whatsapp/identities/enroll-from-employees.
 *
 * `committed: false` is a preview — nothing was written. `optedIn` records
 * whether the admin asserted consent on the team's behalf.
 */
export interface WhatsAppEnrollResult {
  committed: boolean;
  optedIn: boolean;
  considered: number;
  results: Array<{
    employeeId: string;
    employeeCode: string | null;
    name: string;
    phoneMasked: string;
    outcome: 'linked' | 'updated' | 'skipped';
    verified: boolean;
    reason?: string;
  }>;
}

/** One row of GET /whatsapp/actions — the live catalogue, not a copy of it. */
export interface WhatsAppActionRow {
  key: string;
  label: string;
  group: string;
  groupLabel: string;
  order: number;
  roles: string[];
  requiresEmployee: boolean;
  /** Shows pay or balances, so it is subject to the PIN step-up. */
  sensitive: boolean;
  /** confirmPolicy !== 'none'. Governed by mutationsEnabled. */
  writes: boolean;
  /** Reachable only from a server-side token; never listed in a menu. */
  needsActionToken: boolean;
  toolName: string | null;
  keywords: string[];
  /** !actionDenylist.includes(key) */
  enabled: boolean;
}

/**
 * Exactly what PUT /whatsapp/settings accepts — a mirror of
 * UpdateWhatsAppSettingsDto, NOT a projection of the read type.
 *
 * It used to be `Partial<Omit<WhatsAppSettings, ...3 key fields>>`, which let
 * every READ-ONLY field through: redirectMisconfigured, webhookSecretConfigured,
 * apiKeySource and friends. The API runs a whitelisting ValidationPipe, so
 * sending one is a 400 for the whole save — which is how a settings page that
 * looked fine refused to save at all. Listing the writable fields makes adding
 * a control for a non-writable one a compile error instead.
 *
 * `apiKey` is write-only and never echoed back.
 */
export interface UpdateWhatsAppSettings {
  enabled?: boolean;
  baseUrl?: string;
  instanceName?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  adminNumber?: string;
  defaultRegion?: string;
  appBaseUrl?: string;
  publicApiUrl?: string;
  minGapMs?: number;
  maxPerMinute?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  requireOptIn?: boolean;
  requireVerified?: boolean;
  allowGenericFallback?: boolean;
  disabledTemplates?: string[];
  dryRun?: boolean;
  redirectAllTo?: string;
  autoEnroll?: boolean;
  carbonCopyEnabled?: boolean;
  carbonCopyTo?: string;
  retentionDays?: number;
  staleHours?: number;
  drainBatchSize?: number;

  // Two-way
  inboundEnabled?: boolean;
  enrollmentEnabled?: boolean;
  mutationsEnabled?: boolean;
  approvalsEnabled?: boolean;
  requirePinForSensitive?: boolean;
  approvalTokenTtlMinutes?: number;
  ratePerPhone5Min?: number;
  ratePerUserHour?: number;
  rateMutations10Min?: number;
  interactiveMode?: string;
  actionDenylist?: string[];

  // Verification
  attendanceVerification?: string;
  /** @deprecated Superseded by attendanceVerification. */
  attendanceFaceOverride?: boolean;
  selfieDailyCap?: number;
  selfieChallengeSeconds?: number;
  verificationLinkTtlMinutes?: number;

  // Voice and quiet hours
  supportContact?: string;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  quietHoursOverrideTemplates?: string[];
}

export interface WhatsAppConnection {
  state: ConnectionState;
  /** Base URL + instance + API key are all present. Independent of `sendingEnabled`. */
  configured: boolean;
  /** The `enabled` kill switch. A live instance with sending off is a valid pilot state. */
  sendingEnabled: boolean;
  error?: string;
}

export interface WhatsAppQr {
  configured: boolean;
  base64?: string;
  pairingCode?: string;
  count?: number;
  error?: string;
}

export interface WhatsAppTemplate {
  key: string;
  label: string;
  /** Section heading in the admin list, e.g. "Leave", "Pay". */
  group: string;
  /** Whether the admin currently has this update switched on. */
  enabled: boolean;
  /** The catch-all, which is additionally governed by its own setting. */
  requiresCatchAllSetting?: boolean;
  notificationTypes: string[];
}

export interface WhatsAppTestSendResult {
  previewOnly?: boolean;
  queued?: boolean;
  id?: string;
  reason?: string;
  phone: string;
  templateKey: string;
  body: string;
  /** Where it actually went — differs from `phone` while test mode is on. */
  deliveredTo?: string;
  redirected?: boolean;
}

export interface WhatsAppIdentityRow {
  id: string;
  userId: string;
  employeeId: string | null;
  employeeName: string | null;
  employeeCode: string | null;
  email: string | null;
  /** Masked unless explicitly unmasked server-side. */
  phone: string;
  source: string;
  optedIn: boolean;
  optedInAt: string | null;
  verified: boolean;
  verifiedAt: string | null;
  failureCount: number;
  lastError: string | null;
  createdAt: string;
}

export interface WhatsAppIdentityStats {
  total: number;
  optedIn: number;
  verified: number;
  /** optedIn AND verified — the number of people who will actually receive anything. */
  deliverable: number;
  suspended: number;
}

export interface WhatsAppOutboxRow {
  id: string;
  templateKey: string;
  notificationType: string | null;
  to: string;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  sentAt: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  bodyPreview: string;
}

export interface Paged<T> {
  total: number;
  rows: T[];
}

// ------------------------------------------------------------- self-service

export interface MyWhatsAppStatus {
  linked: boolean;
  phoneMasked: string;
  optedIn: boolean;
  verified: boolean;
  source: string | null;
  optedInAt: string | null;
  hasProfilePhone: boolean;
  profilePhoneMasked: string;
  /**
   * PENDING | ACTIVE | BLOCKED | REVOKED, or null when nothing is linked.
   *
   * ACTIVE is the only state that can ACT. Opting in (receive) and linking
   * (act) are two separate decisions, and the page has to show which one the
   * employee has actually made.
   */
  status: 'PENDING' | 'ACTIVE' | 'BLOCKED' | 'REVOKED' | null;
  pinSet: boolean;
  /** Channel-level switches, so the page can hide what is unavailable. */
  enrollmentEnabled: boolean;
  inboundEnabled: boolean;
  requirePinForSensitive: boolean;
}

export interface EnrollStartResult {
  enrollmentId: string;
  phoneMasked: string;
  expiresInMinutes: number;
}

export interface OptInPreview {
  phoneE164: string;
  phoneMasked: string;
  /** null = we could not check (gateway off or lookup failed), not "no". */
  existsOnWhatsApp: boolean | null;
  alreadyLinkedToAnotherUser: boolean;
}

/** GET /whatsapp/webhook/config — everything needed to wire inbound up. */
export interface WhatsAppWebhookConfig {
  /** The address to paste into the WhatsApp service. '' until a base is set. */
  webhookUrl: string;
  publicApiUrl: string;
  path: string;
  headerName: string;
  events: string[];
  secretConfigured: boolean;
  /** WhatsApp credentials are set at all; nothing below is known without them. */
  configured: boolean;
  registeredUrl: string | null;
  registeredEnabled: boolean | null;
  registeredEvents: string[];
  /** Events we need that the service is not subscribed to. */
  missingEvents: string[];
  /** Set when the configured account name is not one the service knows. */
  unknownInstance: { configured: string; available: string[] } | null;
  /** The service's stored URL equals the one we would register. */
  matches: boolean;
  error: string | null;
}

/** POST /whatsapp/webhook/register — `secret` is shown once and never again. */
export interface WhatsAppWebhookRegistered {
  ok: boolean;
  url: string;
  headerName: string;
  events: string[];
  secret: string;
}
