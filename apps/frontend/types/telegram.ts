/**
 * Telegram channel self-service types.
 *
 * Same absence as the WhatsApp and Discord types: no bot token field exists
 * anywhere here, because the backend's read projection cannot carry one across
 * HTTP.
 */

export type TelegramLinkStatus = 'PENDING' | 'ACTIVE' | 'REVOKED';

export interface MyTelegramStatus {
  linked: boolean;
  /** The private chat id, only once the link is ACTIVE. */
  telegramChatId: string | null;
  username: string | null;
  status: TelegramLinkStatus | null;
  linkedAt: string | null;
  optedIn: boolean;
  /**
   * Channel enabled AND employee linking allowed AND inbound on. False hides
   * the section — inbound matters here because the code is redeemed on the
   * webhook, so with it off there would be nothing to redeem against.
   */
  available: boolean;
}

export interface TelegramLinkCode {
  code: string;
  expiresInMinutes: number;
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export type TelegramTokenSource = 'db' | 'env' | 'none';

/**
 * The admin read projection.
 *
 * `botToken` and `webhookSecret` are absent BY TYPE, not merely undefined at
 * runtime: the backend returns `TelegramPublicConfig`, which has no such field,
 * so a component that tries to render one does not compile.
 */
export interface TelegramSettings {
  enabled: boolean;
  botTokenConfigured: boolean;
  botTokenMasked: string;
  botTokenSource: TelegramTokenSource;
  inboundEnabled: boolean;
  webhookSecretConfigured: boolean;
  linkingEnabled: boolean;
  notificationsEnabled: boolean;

  /** Ops group that receives login alerts. Negative id for a group. */
  alertChatId: string;
  loginAlertsEnabled: boolean;
  loginAlertFailures: boolean;
  loginAlertGeo: boolean;
  geoLookupUrl: string;
  /** Empty means every role is alerted on. */
  loginAlertRoles: string[];
  loginAlertFailureMaxPerHour: number;

  /** Test recipient. While set, every message goes to this chat instead. */
  redirectAllTo: string;
  retentionDays: number;
  maxAttempts: number;
}

/** Everything is optional — the backend writes only what it is sent. */
export interface UpdateTelegramSettings {
  enabled?: boolean;
  /** Write-only. Encrypted at rest, never read back. */
  botToken?: string;
  clearBotToken?: boolean;
  inboundEnabled?: boolean;
  webhookSecret?: string;
  linkingEnabled?: boolean;
  notificationsEnabled?: boolean;
  alertChatId?: string;
  loginAlertsEnabled?: boolean;
  loginAlertFailures?: boolean;
  loginAlertGeo?: boolean;
  geoLookupUrl?: string;
  /** CSV on the wire; the read projection returns it split. */
  loginAlertRoles?: string;
  loginAlertFailureMaxPerHour?: number;
  redirectAllTo?: string;
  retentionDays?: number;
}

/**
 * What the stored alert chat id actually resolves to.
 *
 * `chatId` is echoed back deliberately: "chat not found" is the same message
 * whether the id is wrong, the bot is not in the group, or the group changed
 * id — so seeing the stored value next to the verdict is what makes the cause
 * obvious.
 */
export interface TelegramChatCheck {
  chatId: string;
  ok: boolean;
  title?: string;
  type?: string;
  /** The id Telegram itself reports. Differs from `chatId` after a migration. */
  resolvedId?: string;
  error?: string;
}

export interface TelegramDiagnostics {
  bot: { id: string; username: string } | null;
  webhook: {
    url?: string;
    pending_update_count?: number;
    last_error_message?: string;
    last_error_date?: number;
  } | null;
  chat: TelegramChatCheck | null;
}

