/**
 * How the mail transport keys resolve — the ONE place that decides it.
 *
 * A stored EMPTY string means "not configured", not "configured as blank": the
 * value falls through to the environment variable and then to the built-in
 * default. That is what `MailService.ensureTransporter()` has always done (it
 * reads every key as `getSetting(...) || configService.get(...)`), but
 * `getSettingsList()` resolved the same keys with `??`, which only falls
 * through when the ROW IS ABSENT.
 *
 * The two disagreed exactly when a `mail_*` row exists and is empty, and that
 * is the state a tenant lands in the moment anything writes blanks over the
 * transport config — as one settings save did on the Taneka database, blanking
 * all eight rows in a single update. From then on the SMTP form rendered empty
 * on every reload while the server kept sending through the credentials in its
 * environment: the screen reported "nothing configured" about a live transport.
 *
 * So both callers now resolve through here. What the SMTP form shows is what
 * the transporter will use.
 *
 * `mail_bcc` is in the table for the same reason as the rest. `MailService`
 * previously read it from the database only, while the settings list already
 * advertised `MAIL_BCC` as its fallback — so the env var was shown but never
 * honoured. It is honoured now; no deployment in this repo sets it.
 */

/** The transport keys, in the order the settings screen renders them. */
export const MAIL_SETTING_KEYS = [
  'mail_enabled',
  'mail_host',
  'mail_port',
  'mail_user',
  'mail_password',
  'mail_from',
  'mail_from_name',
  'mail_bcc',
] as const;

export type MailSettingKey = (typeof MAIL_SETTING_KEYS)[number];

/** `setting key → [environment variable, built-in default]`. */
const MAIL_ENV_FALLBACK: Record<MailSettingKey, [string, string]> = {
  mail_enabled: ['MAIL_ENABLED', 'false'],
  mail_host: ['MAIL_HOST', 'smtp.gmail.com'],
  mail_port: ['MAIL_PORT', '587'],
  mail_user: ['MAIL_USER', ''],
  mail_password: ['MAIL_PASSWORD', ''],
  mail_from: ['MAIL_FROM', ''],
  mail_from_name: ['MAIL_FROM_NAME', 'HR System'],
  mail_bcc: ['MAIL_BCC', ''],
};

export type MailConfig = Record<MailSettingKey, string>;

/**
 * Resolve one transport key: stored value, else environment, else default.
 *
 * `stored` is treated as unset when it is `undefined` (no row) or empty — the
 * two states the rest of the system already treats alike.
 */
export function resolveMailSetting(
  key: MailSettingKey,
  stored: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (stored !== undefined && stored !== null && stored !== '') return stored;
  const [envKey, fallback] = MAIL_ENV_FALLBACK[key];
  const fromEnv = env[envKey];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : fallback;
}

/** Resolve the whole transport config from a `key → value` map of stored rows. */
export function resolveMailConfig(
  stored: Map<string, string> | Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): MailConfig {
  const get = (key: string) =>
    stored instanceof Map ? stored.get(key) : stored[key];
  return MAIL_SETTING_KEYS.reduce((acc, key) => {
    acc[key] = resolveMailSetting(key, get(key), env);
    return acc;
  }, {} as MailConfig);
}
