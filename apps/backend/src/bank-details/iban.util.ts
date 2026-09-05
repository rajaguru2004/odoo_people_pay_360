/**
 * IBAN validation (ISO 13616) + country-specific structure checks.
 *
 * Pure functions, no I/O — safe to import from services, DTO validators and the
 * MCP layer. Country rules are data-driven so new markets are a one-line add.
 */

export interface IbanCountryRule {
  /** Total IBAN length including the 2-char country code + 2 check digits. */
  length: number;
  /**
   * Zero-based [start, end) slice of the IBAN that holds the bank identifier,
   * compared against the selected Bank's `bankCode`. Omit when the country
   * carries no in-IBAN bank code we validate against.
   */
  bankCodeRange?: [number, number];
}

/**
 * Per-country IBAN rules. Oman ("OM") is the launch market: 23 chars, with the
 * 3-char CBO bank code at positions 5-7 (zero-based [4, 7)).
 */
export const IBAN_COUNTRY_RULES: Record<string, IbanCountryRule> = {
  OM: { length: 23, bankCodeRange: [4, 7] },
  AE: { length: 23, bankCodeRange: [4, 7] },
  GB: { length: 22, bankCodeRange: [4, 8] },
  SA: { length: 24, bankCodeRange: [4, 6] },
  BH: { length: 22, bankCodeRange: [4, 8] },
  KW: { length: 30, bankCodeRange: [4, 8] },
  QA: { length: 29, bankCodeRange: [4, 8] },
};

export type IbanErrorCode =
  | 'EMPTY'
  | 'BAD_FORMAT'
  | 'UNSUPPORTED_COUNTRY'
  | 'COUNTRY_MISMATCH'
  | 'BAD_LENGTH'
  | 'BAD_CHECKSUM'
  | 'BANK_CODE_MISMATCH';

export interface IbanValidationResult {
  valid: boolean;
  code?: IbanErrorCode;
  message?: string;
  /** IBAN with spaces stripped + upper-cased, when parseable. */
  normalized?: string;
}

/** Strip spaces and upper-case; IBANs are compared/stored without whitespace. */
export function normalizeIban(raw: string): string {
  return (raw || '').replace(/\s+/g, '').toUpperCase();
}

/**
 * ISO 7064 MOD-97-10 check, the arithmetic that makes an IBAN self-verifying:
 * move the first four characters to the end, map letters to numbers (A=10..Z=35),
 * and the resulting integer must be ≡ 1 (mod 97).
 *
 * The integer is far too large for a JS number (a 23-char OMR IBAN becomes ~40
 * digits), so the remainder is folded chunk by chunk — mathematically identical
 * to one big modulo, without needing bigint.
 */
export function isValidIbanChecksum(normalizedIban: string): boolean {
  const rearranged = normalizedIban.slice(4) + normalizedIban.slice(0, 4);

  let remainder = 0;
  for (const ch of rearranged) {
    // 0-9 contribute one digit, A-Z contribute two.
    const code = ch.charCodeAt(0);
    let piece: string;
    if (code >= 48 && code <= 57) {
      piece = ch;
    } else if (code >= 65 && code <= 90) {
      piece = String(code - 55); // 'A' (65) -> 10 ... 'Z' (90) -> 35
    } else {
      return false; // anything else is not a valid IBAN character
    }
    for (const d of piece) {
      remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
  }

  return remainder === 1;
}

/**
 * Validate an IBAN for `expectedCountry` and (optionally) confirm the embedded
 * bank code matches the selected bank's `bankCode`.
 *
 * Checks structure, country, length, the ISO 7064 mod-97 checksum, and the
 * embedded bank code. The checksum is what catches a single mistyped or
 * transposed character — the most common way a wage file is rejected, since the
 * bank rejects the WHOLE submission, not just the offending row.
 *
 * @param rawIban       user-supplied IBAN (spaces allowed)
 * @param expectedCountry ISO-2 of the employee's branch / selected bank
 * @param expectedBankCode the selected Bank.bankCode, when known
 */
export function validateIban(
  rawIban: string,
  expectedCountry: string,
  expectedBankCode?: string | null,
): IbanValidationResult {
  const iban = normalizeIban(rawIban);
  if (!iban) return { valid: false, code: 'EMPTY', message: 'IBAN is required' };

  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
    return {
      valid: false,
      code: 'BAD_FORMAT',
      message: 'IBAN must start with a 2-letter country code, 2 check digits, then alphanumerics',
    };
  }

  const country = iban.slice(0, 2);
  const expected = (expectedCountry || '').toUpperCase();
  if (expected && country !== expected) {
    return {
      valid: false,
      code: 'COUNTRY_MISMATCH',
      message: `IBAN country ${country} does not match the expected country ${expected}`,
      normalized: iban,
    };
  }

  const rule = IBAN_COUNTRY_RULES[country];
  if (!rule) {
    return {
      valid: false,
      code: 'UNSUPPORTED_COUNTRY',
      message: `IBAN validation for country ${country} is not configured`,
      normalized: iban,
    };
  }

  if (iban.length !== rule.length) {
    return {
      valid: false,
      code: 'BAD_LENGTH',
      message: `${country} IBAN must be ${rule.length} characters (got ${iban.length})`,
      normalized: iban,
    };
  }

  // Checked AFTER length: a wrong-length IBAN would also fail the checksum, and
  // "must be 23 characters" is the more actionable message of the two.
  if (!isValidIbanChecksum(iban)) {
    return {
      valid: false,
      code: 'BAD_CHECKSUM',
      message:
        'IBAN check digits are invalid — a character is mistyped or transposed',
      normalized: iban,
    };
  }

  if (rule.bankCodeRange && expectedBankCode) {
    const embedded = iban.slice(rule.bankCodeRange[0], rule.bankCodeRange[1]);
    if (embedded !== expectedBankCode.toUpperCase()) {
      return {
        valid: false,
        code: 'BANK_CODE_MISMATCH',
        message: `IBAN bank code ${embedded} does not match the selected bank (${expectedBankCode})`,
        normalized: iban,
      };
    }
  }

  return { valid: true, normalized: iban };
}

/** Mask an IBAN / account number for logs, audit and notifications (last 4 only). */
export function maskAccount(value?: string | null): string | null {
  if (!value) return value ?? null;
  const v = value.replace(/\s+/g, '');
  if (v.length <= 4) return '••••';
  return '••••' + v.slice(-4);
}
