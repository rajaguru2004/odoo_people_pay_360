import parsePhoneNumberFromString, { CountryCode, isSupportedCountry } from 'libphonenumber-js';

/**
 * Phone normalisation for WhatsApp delivery.
 *
 * `Employee.phone` is a free-text HR field: not unique, not verified, and stored
 * in whatever shape somebody typed ("+968-9001-0000", "+91-90000-0010",
 * "0912345678"). None of those can be handed to Evolution directly. Everything
 * that leaves this module is E.164.
 *
 * libphonenumber-js is used rather than a hand-rolled parser because the failure
 * mode here is not "no message" but "message to the wrong human" — a national
 * number normalised against the wrong country plausibly lands on a real stranger.
 */

/** Strict E.164: '+' then a non-zero country digit then 7..14 more. */
const E164_RE = /^\+[1-9]\d{7,14}$/;

/**
 * Normalise a raw phone string to E.164, or null if it cannot be parsed
 * unambiguously. `region` is an ISO-3166 alpha-2 code used only for numbers that
 * are not already international; pass '' when unknown, in which case anything
 * lacking a country code is rejected rather than guessed.
 */
export function toE164(raw: string | null | undefined, region?: string | null): string | null {
  if (!raw) return null;

  // Collapse the separators HR data is full of. Keep a leading '+' and digits.
  const cleaned = raw.replace(/[\s\-(). ​]/g, '').trim();
  if (!cleaned) return null;

  // "00" is the international access prefix in most of the world.
  const candidate = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;

  const country = normaliseRegion(region);

  // Without a '+' and without a region there is nothing to anchor the number to.
  if (!candidate.startsWith('+') && !country) return null;

  const parsed = parsePhoneNumberFromString(candidate, country);
  if (!parsed || !parsed.isValid()) return null;

  const e164 = parsed.number;
  return E164_RE.test(e164) ? e164 : null;
}

/** True when the string is already well-formed E.164. */
export function isE164(value: string | null | undefined): boolean {
  return typeof value === 'string' && E164_RE.test(value);
}

/**
 * Evolution's `number` field takes bare digits including the country code
 * (its own docs describe it as "559999999999"), not a JID and not a '+'.
 */
export function toEvolutionNumber(e164: string): string {
  return e164.replace(/^\+/, '');
}

/** Strip Evolution's JID suffix: "96890010000@s.whatsapp.net" -> "+96890010000". */
export function jidToE164(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0]?.split(':')[0]?.replace(/\D/g, '');
  if (!digits) return null;
  return isE164(`+${digits}`) ? `+${digits}` : null;
}

/**
 * Masked hint for logs and non-admin UI: "+968•••••0000".
 * A phone number in an application log is a different class of leak than an
 * email address, so the disabled-send path masks too.
 */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const plus = e164.startsWith('+');
  const digits = e164.replace(/\D/g, '');
  if (digits.length <= 4) return '••••';
  const head = digits.slice(0, Math.min(3, digits.length - 4));
  const tail = digits.slice(-4);
  const dots = '•'.repeat(Math.max(1, digits.length - head.length - 4));
  return `${plus ? '+' : ''}${head}${dots}${tail}`;
}

/**
 * Canonical form of a stored region hint: uppercase ISO-3166 alpha-2 that
 * libphonenumber actually knows, or '' when it is missing or nonsense.
 *
 * Storing a code libphonenumber does not recognise would silently degrade to
 * "no region", so it is rejected at the point of writing instead — an admin who
 * picked a country deserves to know it did not take.
 */
export function normalisePhoneRegion(region?: string | null): string {
  if (!region) return '';
  const up = region.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(up) && isSupportedCountry(up) ? up : '';
}

/**
 * First usable region in a preference order, '' if none. Callers pass the
 * chain employee -> branch -> global setting -> payroll country.
 */
export function firstRegion(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const r = normalisePhoneRegion(c);
    if (r) return r;
  }
  return '';
}

function normaliseRegion(region?: string | null): CountryCode | undefined {
  const up = normalisePhoneRegion(region);
  return up ? (up as CountryCode) : undefined;
}
