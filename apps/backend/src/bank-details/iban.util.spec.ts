import { maskAccount, normalizeIban, validateIban } from './iban.util';

// A genuinely valid Oman IBAN (23 chars, bank code "018").
const VALID_OM = 'OM810180000001299123456';

describe('validateIban', () => {
  it('accepts a valid Oman IBAN', () => {
    const r = validateIban(VALID_OM, 'OM');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe(VALID_OM);
  });

  it('normalizes spaces and lower-case', () => {
    const r = validateIban('om81 0180 0000 0129 9123 456', 'OM');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe(VALID_OM);
  });

  it('rejects an empty IBAN', () => {
    expect(validateIban('', 'OM').code).toBe('EMPTY');
  });

  it('enforces the ISO 7064 mod-97 checksum', () => {
    // Same structure, country and length as VALID_OM, one mutated final digit.
    // Structure checks alone cannot see this; only the checksum can — and it is
    // the single most common way a wage file is rejected, because the bank
    // rejects the whole submission rather than the offending row.
    const r = validateIban('OM810180000001299123450', 'OM');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('BAD_CHECKSUM');
  });

  it('catches a transposition, which a length check cannot', () => {
    // Last two characters of VALID_OM swapped: still 23 chars, still OM, still
    // bank code 018.
    const r = validateIban('OM810180000001299123465', 'OM');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('BAD_CHECKSUM');
  });

  it('reports wrong length ahead of the checksum (more actionable message)', () => {
    // A wrong-length IBAN also fails mod-97; the length error is the useful one.
    const r = validateIban('OM8101800000012991234', 'OM');
    expect(r.code).toBe('BAD_LENGTH');
  });

  it('rejects the wrong length for the country', () => {
    const r = validateIban('OM8101800000012991234', 'OM');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('BAD_LENGTH');
  });

  it('rejects a country mismatch against the selected bank country', () => {
    const r = validateIban(VALID_OM, 'AE');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('COUNTRY_MISMATCH');
  });

  it('rejects an unconfigured country', () => {
    // FR is not in IBAN_COUNTRY_RULES; a well-formed FR IBAN still fails.
    const r = validateIban('FR7630006000011234567890189', 'FR');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('UNSUPPORTED_COUNTRY');
  });

  it('confirms the embedded bank code matches the selected bank', () => {
    expect(validateIban(VALID_OM, 'OM', '018').valid).toBe(true);
    const r = validateIban(VALID_OM, 'OM', '999');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('BANK_CODE_MISMATCH');
  });

  it('rejects malformed input', () => {
    expect(validateIban('OM!!0180000001299123456', 'OM').code).toBe('BAD_FORMAT');
  });
});

describe('maskAccount', () => {
  it('masks all but the last 4', () => {
    expect(maskAccount(VALID_OM)).toBe('••••3456');
  });
  it('fully masks short values', () => {
    expect(maskAccount('123')).toBe('••••');
  });
  it('passes through null/undefined', () => {
    expect(maskAccount(null)).toBeNull();
    expect(maskAccount(undefined)).toBeNull();
  });
});

describe('normalizeIban', () => {
  it('strips whitespace and upper-cases', () => {
    expect(normalizeIban(' om81 0180 ')).toBe('OM810180');
  });
});
