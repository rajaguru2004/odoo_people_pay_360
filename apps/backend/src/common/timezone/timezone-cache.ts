/**
 * Process-wide cache for the resolved company timezone.
 *
 * Deliberately dependency-free so SystemSettingsService can invalidate it the
 * instant an admin saves a new `system_timezone` WITHOUT importing
 * TimezoneService (which imports SystemSettingsService — a module cycle). Both
 * sides talk only to this tiny module.
 */
const TTL_MS = 60_000; // 60 s

let cachedTZ: string | null = null;
let expiry = 0;

export const companyTzCache = {
  /** Cached tz if still fresh, else null (caller should re-resolve). */
  get(): string | null {
    return Date.now() < expiry ? cachedTZ : null;
  },
  set(tz: string): void {
    cachedTZ = tz;
    expiry = Date.now() + TTL_MS;
  },
  /** Force-clear — call after the company timezone setting changes. */
  invalidate(): void {
    cachedTZ = null;
    expiry = 0;
  },
};
