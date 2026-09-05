import {
  BankingFieldDef,
  branchAllowedCountries,
  maskBankingData,
  normalizeCountry,
  normalizeValue,
  validateBankingData,
} from './banking-fields.util';

const f = (over: Partial<BankingFieldDef>): BankingFieldDef => ({
  fieldKey: 'x',
  label: 'X',
  fieldType: 'TEXT',
  validationType: 'NONE',
  regex: null,
  required: true,
  displayOrder: 0,
  placeholder: null,
  helpText: null,
  isSensitive: true,
  ...over,
});

const VALID_OM_IBAN = 'OM810180000001299123456';

describe('validateBankingData', () => {
  it('accepts a valid OM IBAN set', () => {
    const fields = [
      f({ fieldKey: 'accountHolderName', validationType: 'NONE', isSensitive: false }),
      f({ fieldKey: 'iban', validationType: 'IBAN' }),
    ];
    const r = validateBankingData('OM', { accountHolderName: 'Jo', iban: VALID_OM_IBAN }, fields);
    expect(r.valid).toBe(true);
    expect(r.normalized.iban).toBe(VALID_OM_IBAN);
    expect(r.errors).toEqual({});
  });

  it('enforces the IBAN checksum through the live validation path', () => {
    // This path used to check format, country and length only — validateIban,
    // which also does mod-97 and the bank-code cross-check, was never called.
    const fields = [f({ fieldKey: 'iban', validationType: 'IBAN' })];
    const mutated = 'OM810180000001299123450'; // VALID_OM_IBAN, last digit changed
    const r = validateBankingData('OM', { iban: mutated }, fields);
    expect(r.valid).toBe(false);
    expect(r.errors.iban).toMatch(/check digits/i);
  });

  it('cross-checks the IBAN-embedded bank code against the selected bank', () => {
    const fields = [f({ fieldKey: 'iban', validationType: 'IBAN' })];
    // VALID_OM_IBAN carries bank code "018" at positions 5-7.
    expect(
      validateBankingData('OM', { iban: VALID_OM_IBAN }, fields, '018').valid,
    ).toBe(true);

    const wrongBank = validateBankingData(
      'OM',
      { iban: VALID_OM_IBAN },
      fields,
      '022',
    );
    expect(wrongBank.valid).toBe(false);
    expect(wrongBank.errors.iban).toMatch(/bank code/i);
  });

  it('skips the bank-code cross-check when the bank has no code on file', () => {
    // Bank.bankCode is nullable and ships null from the Oman seed pending Finance
    // verification, so a null must not block an otherwise valid IBAN.
    const fields = [f({ fieldKey: 'iban', validationType: 'IBAN' })];
    expect(
      validateBankingData('OM', { iban: VALID_OM_IBAN }, fields, null).valid,
    ).toBe(true);
  });

  it('flags a missing required field', () => {
    const fields = [f({ fieldKey: 'iban', validationType: 'IBAN' })];
    const r = validateBankingData('OM', {}, fields);
    expect(r.valid).toBe(false);
    expect(r.errors.iban).toMatch(/required/i);
  });

  it('validates India accountNumber(NUMBER) + ifsc(IFSC)', () => {
    const fields = [
      f({ fieldKey: 'accountNumber', validationType: 'NUMBER' }),
      f({ fieldKey: 'ifsc', validationType: 'IFSC' }),
    ];
    expect(validateBankingData('IN', { accountNumber: '12345', ifsc: 'HDFC0001234' }, fields).valid).toBe(true);
    expect(validateBankingData('IN', { accountNumber: '12a45', ifsc: 'HDFC0001234' }, fields).errors.accountNumber).toBeDefined();
    expect(validateBankingData('IN', { accountNumber: '12345', ifsc: 'BADIFSC' }, fields).errors.ifsc).toBeDefined();
  });

  it('validates GB sort code (normalizes dashes) + account number', () => {
    const fields = [f({ fieldKey: 'sortCode', validationType: 'SORT_CODE' })];
    const ok = validateBankingData('GB', { sortCode: '12-34-56' }, fields);
    expect(ok.valid).toBe(true);
    expect(ok.normalized.sortCode).toBe('123456');
    expect(validateBankingData('GB', { sortCode: '1234' }, fields).errors.sortCode).toBeDefined();
  });

  it('validates US routing number (9 digits)', () => {
    const fields = [f({ fieldKey: 'routingNumber', validationType: 'ROUTING' })];
    expect(validateBankingData('US', { routingNumber: '021000021' }, fields).valid).toBe(true);
    expect(validateBankingData('US', { routingNumber: '12345' }, fields).errors.routingNumber).toBeDefined();
  });

  it('validates SWIFT/BIC', () => {
    const fields = [f({ fieldKey: 'swift', validationType: 'SWIFT' })];
    expect(validateBankingData('OM', { swift: 'BMUSOMRX' }, fields).valid).toBe(true);
    expect(validateBankingData('OM', { swift: 'nope' }, fields).errors.swift).toBeDefined();
  });

  it('supports a custom REGEX validation', () => {
    const fields = [f({ fieldKey: 'code', validationType: 'REGEX', regex: '^[A-Z]{3}$' })];
    expect(validateBankingData('XX', { code: 'ABC' }, fields).valid).toBe(true);
    expect(validateBankingData('XX', { code: 'ab' }, fields).errors.code).toBeDefined();
  });

  it('rejects a wrong-length IBAN and a country prefix mismatch', () => {
    const fields = [f({ fieldKey: 'iban', validationType: 'IBAN' })];
    expect(validateBankingData('OM', { iban: 'OM8101800000012991234' }, fields).errors.iban).toMatch(/23/);
    expect(validateBankingData('OM', { iban: 'AE070331234567890123456' }, fields).errors.iban).toMatch(/match/i);
  });

  it('drops unknown keys from the normalized output', () => {
    const fields = [f({ fieldKey: 'accountHolderName', validationType: 'NONE', isSensitive: false })];
    const r = validateBankingData('OM', { accountHolderName: 'Jo', hackerField: 'x' }, fields);
    expect(r.valid).toBe(true);
    expect(r.normalized).toEqual({ accountHolderName: 'Jo' });
  });

  it('treats an optional empty field as valid', () => {
    const fields = [f({ fieldKey: 'note', validationType: 'NONE', required: false })];
    expect(validateBankingData('OM', {}, fields).valid).toBe(true);
  });
});

describe('normalizeValue', () => {
  it('IBAN strips spaces + upper-cases', () => {
    expect(normalizeValue('IBAN', 'om81 0180')).toBe('OM810180');
  });
  it('SORT_CODE strips spaces + dashes', () => {
    expect(normalizeValue('SORT_CODE', '12-34 56')).toBe('123456');
  });
  it('IFSC/SWIFT upper-case', () => {
    expect(normalizeValue('IFSC', 'hdfc0001234')).toBe('HDFC0001234');
  });
});

describe('maskBankingData', () => {
  const fields = [
    f({ fieldKey: 'accountHolderName', isSensitive: false }),
    f({ fieldKey: 'iban', isSensitive: true }),
  ];
  it('masks sensitive fields and leaves non-sensitive intact', () => {
    const out = maskBankingData({ accountHolderName: 'Jo Bloggs', iban: VALID_OM_IBAN }, fields);
    expect(out.accountHolderName).toBe('Jo Bloggs');
    expect(out.iban).toBe('••••3456');
  });
  it('fully masks short sensitive values', () => {
    expect(maskBankingData({ iban: '12' }, fields).iban).toBe('••••');
  });
});

describe('normalizeCountry', () => {
  it('upper-cases valid ISO-2', () => expect(normalizeCountry('om')).toBe('OM'));
  it('rejects non-ISO free text', () => expect(normalizeCountry('Oman')).toBe(''));
  it('handles null/empty', () => {
    expect(normalizeCountry(null)).toBe('');
    expect(normalizeCountry('')).toBe('');
  });
});

describe('branchAllowedCountries', () => {
  it('prefers explicit bankingCountries (deduped, normalized)', () => {
    expect(branchAllowedCountries({ country: 'OM', bankingCountries: ['in', 'IN', 'AE'] })).toEqual(['IN', 'AE']);
  });
  it('falls back to the location country when no bankingCountries', () => {
    expect(branchAllowedCountries({ country: 'OM', bankingCountries: [] })).toEqual(['OM']);
  });
  it('returns [] when nothing usable', () => {
    expect(branchAllowedCountries({ country: 'Oman', bankingCountries: [] })).toEqual([]);
    expect(branchAllowedCountries(null)).toEqual([]);
  });
});
