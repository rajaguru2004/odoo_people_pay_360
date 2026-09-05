/**
 * Read a secret from configuration, or refuse to start.
 *
 * There is no default value on purpose. A defaulted signing key is worse than a
 * missing one: every deployment that forgot to set it ends up sharing the same
 * key, so a token minted against any of them is valid against all of them, and
 * nothing about that failure is visible until it is exploited. Crashing at boot
 * is loud, immediate, and happens before the process can serve a request.
 */
export function requireSecret(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `${name} is not set. Refusing to start — see apps/backend/.env.example. ` +
        `Generate one with: openssl rand -base64 48`,
    );
  }
  return trimmed;
}
