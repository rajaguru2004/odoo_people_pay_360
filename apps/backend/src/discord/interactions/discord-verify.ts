import { createPublicKey, verify } from 'crypto';

/**
 * Verify Discord's Ed25519 request signature.
 *
 * Discord signs every interaction with the application's private key and
 * expects a 401 for anything that fails — it actively probes the endpoint with
 * bad signatures during setup and refuses to save a URL that accepts them.
 *
 * Implemented on Node's crypto rather than pulling in `discord-interactions` or
 * `tweetnacl`: Ed25519 has been native since Node 12, and this is ~20 lines.
 */

/**
 * ASN.1 SPKI prefix for an Ed25519 public key.
 *
 * Node needs a DER-encoded key, while Discord publishes 32 raw bytes as hex.
 * Prepending this fixed header is the standard way to wrap one.
 */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyDiscordSignature(args: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  /** The EXACT bytes Discord sent. Re-serialising the parsed JSON breaks this. */
  rawBody: string;
}): boolean {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = args;
  if (!publicKeyHex || !signatureHex || !timestamp) return false;

  try {
    const keyBytes = Buffer.from(publicKeyHex, 'hex');
    if (keyBytes.length !== 32) return false;

    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, keyBytes]),
      format: 'der',
      type: 'spki',
    });

    const signature = Buffer.from(signatureHex, 'hex');
    if (signature.length !== 64) return false;

    // Ed25519 takes no separate digest algorithm — hence the null first arg.
    return verify(null, Buffer.from(timestamp + rawBody, 'utf8'), key, signature);
  } catch {
    // Malformed hex, wrong key length, anything else: treat as unsigned.
    return false;
  }
}
