/**
 * Settings keys that belong to the developer/operator, not to the tenant admin.
 *
 * These are the keys behind the settings surfaces hidden by developer mode:
 * SMTP transport, the HR Copilot LLM configuration, and the employee-field
 * template kill switch. An ADMIN who has not stepped up must neither read them
 * back nor write them.
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
 * Prefix rules, so a new `copilot.*` key is covered the day it is added rather
 * than the day someone remembers this file. Any future operator-owned
 * integration namespace belongs here for the same reason: without it a
 * non-elevated ADMIN can read its non-secret configuration out of the generic
 * settings dump, which is a gap even when the credentials themselves are caught
 * by `isProtectedSettingKey`.
 */
const DEVELOPER_PREFIXES: readonly string[] = ['copilot.', 'mail_'];

export function isDeveloperSettingKey(key: string): boolean {
  if (DEVELOPER_SETTING_KEYS.includes(key)) return true;
  return DEVELOPER_PREFIXES.some((p) => key.startsWith(p));
}
