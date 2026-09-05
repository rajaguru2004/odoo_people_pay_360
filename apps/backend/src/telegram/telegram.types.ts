/**
 * Telegram channel — shared types.
 *
 * Same secret doctrine as WhatsApp and Discord: `TelegramResolvedConfig` carries
 * the decrypted bot token and is internal-only, `TelegramPublicConfig` is what a
 * controller may return. The split makes leaking the token a compile error
 * rather than a review miss.
 */

export const TELEGRAM_SETTING_KEYS = {
  enabled: 'telegram.enabled',
  /** AES-256-GCM. Full control of the bot; never returned by any endpoint. */
  botTokenEnc: 'telegram.botTokenEnc',
  /** Accept updates from the webhook. Off by default, like the other channels. */
  inboundEnabled: 'telegram.inboundEnabled',
  /**
   * AES-256-GCM. Handed to Telegram as `secret_token` on setWebhook; Telegram
   * echoes it back in X-Telegram-Bot-Api-Secret-Token on every update.
   */
  webhookSecretEnc: 'telegram.webhookSecretEnc',
  /** Employees may link their own Telegram account. */
  linkingEnabled: 'telegram.linkingEnabled',
  /** Deliver ESS notifications as Telegram DMs. */
  notificationsEnabled: 'telegram.notificationsEnabled',

  /**
   * The ops group that receives login alerts. Negative for a group/supergroup.
   * Nothing is alerted without it — an unset chat id is off, not a default.
   */
  alertChatId: 'telegram.alertChatId',
  loginAlertsEnabled: 'telegram.loginAlertsEnabled',
  /** Also alert on wrong password / disabled account / unknown email. */
  loginAlertFailures: 'telegram.loginAlertFailures',
  /** Look the login IP up with a third-party geolocation service. */
  loginAlertGeo: 'telegram.loginAlertGeo',
  /** Override the geolocation endpoint. `{ip}` is substituted. */
  geoLookupUrl: 'telegram.geoLookupUrl',
  /**
   * CSV of roles to alert on. Empty = every role, which is the useful default:
   * the point of the group is seeing every login.
   */
  loginAlertRoles: 'telegram.loginAlertRoles',
  /**
   * Per-IP hourly cap on FAILED-login alerts. Anyone can hammer the login form
   * from outside, so without a cap the group is a free spam target.
   */
  loginAlertFailureMaxPerHour: 'telegram.loginAlertFailureMaxPerHour',

  /** Test catcher: every message goes to this chat id instead. */
  redirectAllTo: 'telegram.redirectAllTo',
  retentionDays: 'telegram.retentionDays',
  maxAttempts: 'telegram.maxAttempts',
} as const;

/** Telegram echoes the setWebhook `secret_token` back in this header. */
export const TELEGRAM_WEBHOOK_HEADER = 'x-telegram-bot-api-secret-token';

export interface TelegramResolvedConfig {
  enabled: boolean;
  /** Decrypted. INTERNAL ONLY. */
  botToken: string;
  botTokenSource: 'db' | 'env' | 'none';
  inboundEnabled: boolean;
  /** Decrypted. INTERNAL ONLY. */
  webhookSecret: string;
  linkingEnabled: boolean;
  notificationsEnabled: boolean;

  alertChatId: string;
  loginAlertsEnabled: boolean;
  loginAlertFailures: boolean;
  loginAlertGeo: boolean;
  geoLookupUrl: string;
  loginAlertRoles: string[];
  loginAlertFailureMaxPerHour: number;

  redirectAllTo: string;
  retentionDays: number;
  maxAttempts: number;
}

export interface TelegramPublicConfig
  extends Omit<TelegramResolvedConfig, 'botToken' | 'webhookSecret'> {
  botTokenConfigured: boolean;
  botTokenMasked: string;
  webhookSecretConfigured: boolean;
}

/** The subset of a Telegram Update this channel reads. */
export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string; username?: string; is_bot?: boolean };
  };
}
