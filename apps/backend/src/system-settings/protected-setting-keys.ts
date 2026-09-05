/**
 * Settings keys that hold a secret and must never be read back or written
 * through the generic /system-settings surface.
 *
 * Three things depend on this list:
 *
 *  - `SystemSettingsService.setSetting()` rejects them, so nobody can overwrite
 *    an AES ciphertext with plaintext and brick the integration that reads it.
 *  - `SystemSettingsService.getAllSettings()` strips them, so they cannot reach
 *    the unauthenticated `/system-settings/public` projection by accident.
 *  - `SystemSettingsController` masks them for every role, not just MANAGER.
 *
 * Each of these values has a dedicated typed admin endpoint that encrypts on
 * write and returns only a boolean plus a masked hint.
 */

/** Exact keys that are always protected. */
export const PROTECTED_SETTING_KEYS: readonly string[] = ['copilot.llmApiKeyEnc'];

/**
 * Suffix rules, so a future integration that follows the `*Enc` convention is
 * covered without anyone remembering to edit this file.
 */
const PROTECTED_SUFFIXES: readonly string[] = ['Enc', '_enc', '_secret', '_apikey', '_api_key'];

export function isProtectedSettingKey(key: string): boolean {
  if (PROTECTED_SETTING_KEYS.includes(key)) return true;
  return PROTECTED_SUFFIXES.some((s) => key.endsWith(s));
}
