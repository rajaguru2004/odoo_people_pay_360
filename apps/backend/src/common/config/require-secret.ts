import { Logger } from '@nestjs/common';

const logger = new Logger('SecretConfig');

/**
 * Resolves a secret from the environment.
 *
 * These previously fell back to a literal committed to the repository
 * (`'ess-portal-secret-key-2026'`). Any deployment that forgot to set the
 * variable was signing JWTs with a publicly known key, which lets anyone forge
 * a token for any user and role.
 *
 * In production a missing secret is fatal — failing to boot is far better than
 * booting insecurely. Outside production it falls back to a per-process random
 * value so local development still works, at the cost of invalidating tokens on
 * restart (which is the correct trade-off: it makes the misconfiguration
 * obvious rather than silent).
 */
export function requireSecret(name: string, value?: string | null): string {
  if (value && value.trim().length > 0) return value;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${name} is not set. Refusing to start with an insecure default.`,
    );
  }

  logger.warn(
    `${name} is not set — using an ephemeral development secret. ` +
      `Tokens will not survive a restart. Set ${name} before deploying.`,
  );
  return `dev-only-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;
}
