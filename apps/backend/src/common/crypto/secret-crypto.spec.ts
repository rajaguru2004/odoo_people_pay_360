import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskSecret,
} from './secret-crypto';

describe('secret-crypto', () => {
  const OLD = process.env.SETTINGS_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = 'unit-test-master-key';
  });
  afterAll(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = OLD;
  });

  it('round-trips a secret', () => {
    const plain = 'sk-or-v1-abcdef0123456789';
    const enc = encryptSecret(plain);
    expect(enc).not.toContain(plain);
    expect(isEncryptedSecret(enc)).toBe(true);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('produces a fresh IV each time (non-deterministic ciphertext)', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same');
    expect(decryptSecret(b)).toBe('same');
  });

  it('rejects a tampered payload (GCM auth)', () => {
    const enc = encryptSecret('secret');
    const parts = enc.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff; // flip a byte
    parts[3] = ct.toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('rejects a malformed payload', () => {
    expect(() => decryptSecret('not-encrypted')).toThrow('Malformed encrypted secret');
    expect(isEncryptedSecret('plain')).toBe(false);
  });

  it('masks a secret without revealing it', () => {
    expect(maskSecret('sk-or-v1-1252')).toBe('••••1252');
    expect(maskSecret('abc')).toBe('••••');
    expect(maskSecret('')).toBe('');
  });
});
