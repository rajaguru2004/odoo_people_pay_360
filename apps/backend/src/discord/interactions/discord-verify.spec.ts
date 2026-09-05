import { generateKeyPairSync, sign } from 'crypto';
import { verifyDiscordSignature } from './discord-verify';

/**
 * Signature verification is the ONLY thing standing between this endpoint and
 * anyone on the internet issuing ESS commands as an arbitrary employee. Discord
 * also probes with deliberately invalid signatures when you save the URL and
 * refuses an endpoint that accepts them.
 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

const signFor = (timestamp: string, body: string) =>
  sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');

describe('verifyDiscordSignature', () => {
  const timestamp = '1786000000';
  const rawBody = '{"type":1}';

  it('accepts a genuine signature', () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex: signFor(timestamp, rawBody),
        timestamp,
        rawBody,
      }),
    ).toBe(true);
  });

  it('rejects a forged signature', () => {
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex: '00'.repeat(64),
        timestamp,
        rawBody,
      }),
    ).toBe(false);
  });

  it('rejects a body that changed after signing', () => {
    // The reason the controller must verify the RAW bytes: re-serialising the
    // parsed JSON can reorder keys or drop whitespace and would fail here.
    const signature = signFor(timestamp, rawBody);
    expect(
      verifyDiscordSignature({ publicKeyHex, signatureHex: signature, timestamp, rawBody: '{"type":2}' }),
    ).toBe(false);
  });

  it('rejects a replayed signature under a different timestamp', () => {
    const signature = signFor(timestamp, rawBody);
    expect(
      verifyDiscordSignature({ publicKeyHex, signatureHex: signature, timestamp: '1786000001', rawBody }),
    ).toBe(false);
  });

  it('rejects a signature made by a different key', () => {
    const other = generateKeyPairSync('ed25519');
    const signature = sign(null, Buffer.from(timestamp + rawBody), other.privateKey).toString('hex');
    expect(verifyDiscordSignature({ publicKeyHex, signatureHex: signature, timestamp, rawBody })).toBe(
      false,
    );
  });

  it.each([
    ['no signature', { signatureHex: '' }],
    ['no timestamp', { timestamp: '' }],
    ['no public key', { publicKeyHex: '' }],
    ['public key of the wrong length', { publicKeyHex: 'abcd' }],
    ['signature of the wrong length', { signatureHex: 'abcd' }],
    ['non-hex signature', { signatureHex: 'zz'.repeat(64) }],
  ])('rejects when there is %s', (_label, over) => {
    // Every malformed input must be a plain false, never a thrown exception —
    // an unhandled throw here would turn into a 500 and look like an outage.
    expect(
      verifyDiscordSignature({
        publicKeyHex,
        signatureHex: signFor(timestamp, rawBody),
        timestamp,
        rawBody,
        ...over,
      }),
    ).toBe(false);
  });
});
