/**
 * Settings keys that belong to the developer/operator, not to the tenant admin.
 *
 * These are the keys behind the settings surfaces hidden by developer mode:
 * SMTP transport, the HR Copilot LLM configuration, the WhatsApp/Evolution
 * integration, and the employee-field template kill switch. An ADMIN who has
 * not stepped up must neither read them back nor write them.
 *
 * This is a SEPARATE axis from `isProtectedSettingKey`:
 *
 *  - protected  = holds a secret; masked for everyone, always, forever.
 *  - developer  = operator-owned; visible and writable only while elevated.
 *
 * A key can be both (`copilot.llmApiKeyEnc` is), and the two filters compose:
 * protection is applied first and is never lifted by elevation.
 *
 * Enforced in `SystemSettingsController` only — NOT in the service. Internal
 * callers such as `MailService.ensureTransporter()` read these keys through
 * `SystemSettingsService.getSetting()` on every send, and gating the service
 * would stop transactional email dead.
 */

/** Mail transport. Note `mail_password` is not covered by the protected-key
 *  suffix rules, so before developer mode it was readable in plaintext by any
 *  ADMIN through the generic settings dump. */
const MAIL_KEYS: readonly string[] = [
  'mail_enabled',
  'mail_host',
  'mail_port',
  'mail_user',
  'mail_password',
  'mail_from',
  'mail_from_name',
  'mail_bcc',
];

/** Exact keys that are developer-owned. */
export const DEVELOPER_SETTING_KEYS: readonly string[] = [
  ...MAIL_KEYS,
  'employee_template_enabled',
];

/**
 * Prefix rules, so a new `copilot.*` or `whatsapp.*` key is covered the day it
 * is added rather than the day someone remembers this file.
 *
 * `discord.` and `telegram.` were added with the Telegram channel. Discord had
 * been missing since it shipped — the same class of operator-owned integration
 * keys as `whatsapp.`, so a non-elevated ADMIN could read `discord.publicKey`
 * and `discord.announceChannelId` out of the generic settings dump. The bot
 * tokens themselves were never exposed (`*Enc` is caught by
 * `isProtectedSettingKey`), which is why this was a gap rather than an incident.
 */
const DEVELOPER_PREFIXES: readonly string[] = [
  'copilot.',
  'whatsapp.',
  'discord.',
  'telegram.',
  'mail_',
];

export function isDeveloperSettingKey(key: string): boolean {
  if (DEVELOPER_SETTING_KEYS.includes(key)) return true;
  return DEVELOPER_PREFIXES.some((p) => key.startsWith(p));
}
