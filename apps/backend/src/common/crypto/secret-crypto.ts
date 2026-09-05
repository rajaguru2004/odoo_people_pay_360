import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Symmetric encryption for secrets stored at rest (e.g. the copilot LLM API key).
 *
 * AES-256-GCM. The master key is derived (scrypt) from SETTINGS_ENCRYPTION_KEY,
 * falling back to JWT_SECRET. This one value MUST stay in the environment — a key
 * that decrypts the DB cannot live inside that same DB. Everything else is dynamic.
 *
 * Payload format: `v1:<ivB64>:<tagB64>:<ciphertextB64>`.
 */
const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * Legacy fallback. This literal was committed to the repository, so anything
 * encrypted with it must be treated as public. Kept only so existing
 * development data stays decryptable — production refuses to use it.
 */
const LEGACY_DEV_KEY = 'ess-portal-secret-key-2026';

function masterKey(): Buffer {
  const configured =
    process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET;

  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error(
      'SETTINGS_ENCRYPTION_KEY (or JWT_SECRET) is not set. Refusing to encrypt ' +
        'secrets at rest with a publicly known key.',
    );
  }

  // Unlike the JWT secret, this one cannot fall back to a random per-process
  // value: that would make previously encrypted rows undecryptable on restart.
  const secret = configured || LEGACY_DEV_KEY;
  return scryptSync(secret, 'copilot-settings-secret-v1', 32);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted secret');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`) && value.split(':').length === 4;
}

/** Non-reversible masked hint for display, e.g. "••••1252". */
export function maskSecret(plain: string): string {
  if (!plain) return '';
  return plain.length <= 4 ? '••••' : `••••${plain.slice(-4)}`;
}
