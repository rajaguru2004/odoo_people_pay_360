import { isSupportedCountry } from 'libphonenumber-js';

/**
 * Canonical form of a stored region hint: uppercase ISO-3166 alpha-2 that
 * libphonenumber actually knows, or '' when it is missing or nonsense.
 *
 * `Employee.phone` is a free-text HR field stored in whatever shape somebody
 * typed ("+968-9001-0000", "0912345678"), so `phoneCountryCode` is what tells a
 * national number which country it belongs to. Storing a code libphonenumber
 * does not recognise would silently degrade to "no region", so it is rejected at
 * the point of writing instead — an admin who picked a country deserves to know
 * it did not take.
 */
export function normalisePhoneRegion(region?: string | null): string {
  if (!region) return '';
  const up = region.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(up) && isSupportedCountry(up) ? up : '';
}
