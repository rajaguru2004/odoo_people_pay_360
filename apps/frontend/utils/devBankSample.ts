/**
 * DEV-ONLY sample bank data, for exercising the bank screens by hand.
 *
 * Why this exists: bank details are now validated properly — IBANs must pass the
 * ISO 7064 mod-97 checksum AND carry the selected bank's code in the right
 * positions. That is correct, and it makes manual testing tedious: you cannot
 * invent an IBAN, and copying a real one from the web fails the bank-code
 * cross-check the moment you pick a different bank.
 *
 * So this generates values that are *structurally* valid for the selected country
 * and bank. Everything is synthetic — the account numbers do not exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEVER ships to production. `isDevMode()` reads `process.env.NODE_ENV`, which
 * Next.js statically replaces at build time, so a production build folds the
 * check to `false` and dead-code-eliminates every caller. Do not swap it for a
 * runtime flag — the point is that the button cannot exist in a real deployment.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** True only in a local dev build. Statically false in production bundles. */
export function isDevMode(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * IBAN structure per country. Mirrors IBAN_COUNTRY_RULES in the backend
 * (`apps/backend/src/bank-details/iban.util.ts`) — kept as a separate copy on
 * purpose: this is throwaway dev tooling and must not become a reason to expose
 * a new endpoint. If the backend gains a country, generation here simply falls
 * back to "unsupported" and you type the value yourself.
 *
 * `bankCodeRange` is a zero-based [start, end) slice of the WHOLE IBAN, so it
 * accounts for the 2-char country code + 2 check digits before the BBAN.
 */
const IBAN_RULES: Record<string, { length: number; bankCodeRange?: [number, number] }> = {
  OM: { length: 23, bankCodeRange: [4, 7] },
  AE: { length: 23, bankCodeRange: [4, 7] },
  GB: { length: 22, bankCodeRange: [4, 8] },
  SA: { length: 24, bankCodeRange: [4, 6] },
  BH: { length: 22, bankCodeRange: [4, 8] },
  KW: { length: 30, bankCodeRange: [4, 8] },
  QA: { length: 29, bankCodeRange: [4, 8] },
};

/**
 * ISO 7064 MOD-97-10 over an alphanumeric string, folded digit by digit so the
 * (roughly 40-digit) intermediate never overflows a JS number.
 */
function mod97(input: string): number {
  let remainder = 0;
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    let piece: string;
    if (code >= 48 && code <= 57) {
      piece = ch; // 0-9
    } else if (code >= 65 && code <= 90) {
      piece = String(code - 55); // A=10 … Z=35
    } else {
      throw new Error(`Unexpected IBAN character: ${ch}`);
    }
    for (const d of piece) {
      remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder;
}

/**
 * Build a structurally valid IBAN for `country`, embedding `bankCode` where that
 * country carries it, with correctly computed check digits.
 *
 * Returns null when the country has no rule here — better to leave the field
 * empty than to fabricate something that fails validation confusingly.
 *
 * `seed` varies the filler digits so two employees do not get the same account.
 */
export function generateSampleIban(
  country: string,
  bankCode?: string | null,
  seed = 0,
): string | null {
  const cc = (country || '').toUpperCase();
  const rule = IBAN_RULES[cc];
  if (!rule) return null;

  const bbanLength = rule.length - 4;

  // Bank-code offsets translated from IBAN coordinates into BBAN coordinates.
  const start = rule.bankCodeRange ? rule.bankCodeRange[0] - 4 : 0;
  const end = rule.bankCodeRange ? rule.bankCodeRange[1] - 4 : 0;
  const width = Math.max(0, end - start);

  // Use the real bank code when known so the cross-check passes. Pad or trim to
  // the exact width the country expects; zeros when the bank has no code on file
  // (Bank.bankCode is nullable, and the Oman seed ships it null on purpose).
  const code = width
    ? ((bankCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '') + '0'.repeat(width)).slice(0, width)
    : '';

  const prefix = '0'.repeat(start) + code;
  const fillerLength = bbanLength - prefix.length;
  if (fillerLength < 0) return null;

  let filler = '';
  for (let i = 0; i < fillerLength; i += 1) {
    filler += String((seed * 7 + i * 3 + 1) % 10);
  }

  const bban = prefix + filler;

  // Check digits: 98 − mod97(BBAN + countryCode + "00").
  // This is what makes mod97(BBAN + CC + check) === 1 hold on validation.
  const check = 98 - mod97(`${bban}${cc}00`);
  return `${cc}${String(check).padStart(2, '0')}${bban}`;
}

/** Deterministic small integer from a string, so a given employee always gets the same account. */
function seedFrom(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 9973;
  return h;
}

export interface SampleFieldContext {
  country: string;
  bankCode?: string | null;
  /** Falls back to this for a name field. */
  holderName?: string;
  /** Anything stable per row (employee id) so values are reproducible. */
  seedKey?: string;
}

/**
 * A plausible value for one configured banking field, chosen from its
 * `validationType` — the same discriminator the backend validates on, so these
 * are built to pass rather than to look right.
 *
 * Returns null when nothing sensible can be generated (notably REGEX, where the
 * pattern is admin-supplied and generating a match is not worth the complexity).
 */
export function sampleValueForField(
  field: { fieldKey: string; validationType: string; label?: string },
  ctx: SampleFieldContext,
): string | null {
  const seed = seedFrom(ctx.seedKey || ctx.country || 'seed');

  switch (field.validationType) {
    case 'IBAN':
      return generateSampleIban(ctx.country, ctx.bankCode, seed);

    case 'IFSC':
      // ^[A-Z]{4}0[A-Z0-9]{6}$
      return `HDFC0${String(100000 + (seed % 900000))}`;

    case 'SWIFT':
      // ^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$ — 6 letters, then 2, optional 3.
      return `TESTBK${(ctx.country || 'OM').toUpperCase().slice(0, 2)}XXX`;

    case 'SORT_CODE':
      return String(100000 + (seed % 900000));

    case 'ROUTING':
      return String(100000000 + (seed % 900000000));

    case 'NUMBER':
      return String(1000000000 + (seed % 9000000000));

    case 'REGEX':
      // Admin-defined pattern; generating a match reliably is out of scope.
      return null;

    case 'NONE':
    default:
      if (/holder|name/i.test(field.fieldKey)) return ctx.holderName || 'Test Account Holder';
      if (/branch/i.test(field.fieldKey)) return 'Main Branch';
      return 'TEST';
  }
}

/**
 * Fill a whole field set. Fields we cannot generate are left untouched so the
 * form still shows them as required rather than silently passing something junk.
 */
export function sampleValuesForFields(
  fields: { fieldKey: string; validationType: string; label?: string }[],
  ctx: SampleFieldContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = sampleValueForField(f, ctx);
    if (v !== null) out[f.fieldKey] = v;
  }
  return out;
}
