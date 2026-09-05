/**
 * tzDate.ts — Frontend timezone utility (Workday/SAP model)
 *
 * Two distinct TZ concepts:
 *  - Display TZ:  user.timezone ?? system_timezone  → shown to the logged-in employee
 *  - Business TZ: system_timezone                   → company office-hours rules (admin views)
 *
 * Usage:
 *   import { formatInTZ, toLocalDateStr, nowInTZ, getDisplayTZ } from '@/utils/tzDate';
 */

import { DateTime } from 'luxon';
import { useBrandingStore } from '@/store/brandingStore';
import { useAuthStore } from '@/store/authStore';

// ── TZ Resolvers ─────────────────────────────────────────────────────────────

/**
 * Returns the IANA timezone to use when displaying timestamps to the current user.
 * Falls back chain: user.timezone → system_timezone → 'Asia/Kolkata'
 */
export function getDisplayTZ(): string {
  const authUser = (useAuthStore.getState() as any)?.user;
  const userTimezone = authUser?.timezone || authUser?.employee?.timezone;
  const systemTZ = useBrandingStore.getState().branding.system_timezone;
  const tz = userTimezone || systemTZ || 'Asia/Kolkata';
  // Validate
  const valid = DateTime.now().setZone(tz).isValid;
  return valid ? tz : 'Asia/Kolkata';
}

/**
 * Returns the company timezone (for business rule display, admin reports).
 * Never uses user's personal TZ.
 */
export function getBusinessTZ(): string {
  const tz = useBrandingStore.getState().branding.system_timezone || 'Asia/Kolkata';
  const valid = DateTime.now().setZone(tz).isValid;
  return valid ? tz : 'Asia/Kolkata';
}

// ── Formatters ───────────────────────────────────────────────────────────────

/**
 * Format a date/time string or Date object in a given IANA timezone.
 *
 * @param date  ISO string, JS Date, or luxon-compatible input
 * @param fmt   Luxon format string, e.g. 'HH:mm', 'dd MMM yyyy', 'dd/MM/yyyy HH:mm'
 * @param tz    IANA timezone. Defaults to display TZ (user's own or company TZ).
 */
export function formatInTZ(
  date: string | Date | null | undefined,
  fmt: string,
  tz?: string,
): string {
  if (!date) return '—';
  try {
    const zone = tz ?? getDisplayTZ();
    const dt =
      typeof date === 'string'
        ? DateTime.fromISO(date, { zone: 'utc' }).setZone(zone)
        : DateTime.fromJSDate(date, { zone: 'utc' }).setZone(zone);
    return dt.isValid ? dt.toFormat(fmt) : '—';
  } catch {
    return '—';
  }
}

/**
 * Format a date/time string as time only (HH:mm) in display TZ.
 * Convenience wrapper for attendance tables.
 */
export function formatTimeInTZ(
  date: string | Date | null | undefined,
  tz?: string,
): string {
  return formatInTZ(date, 'HH:mm', tz);
}

/**
 * Format a date/time as a date string (dd MMM yyyy) in display TZ.
 */
export function formatDateInTZ(
  date: string | Date | null | undefined,
  tz?: string,
): string {
  return formatInTZ(date, 'dd MMM yyyy', tz);
}

// ── Local wall-clock → UTC instant ────────────────────────────────────────────

/**
 * Turn a company-local wall clock ('YYYY-MM-DD' + 'HH:mm') into the UTC ISO
 * instant to persist.
 *
 * NEVER use `new Date(\`${date}T${time}\`)` for this: that resolves the wall
 * clock in the BROWSER's timezone, so an admin in Asia/Kolkata scheduling an
 * 08:00 shift for an Asia/Singapore company stored 02:30Z — an 10:30 SGT shift
 * whose reminder fired at 08:00 IST. Business times belong to the company TZ,
 * not to whoever happens to be typing them.
 *
 * @param dateStr  'YYYY-MM-DD' (company-local calendar date)
 * @param timeHHMM 'HH:mm' (company-local wall clock)
 * @param tz       IANA timezone. Defaults to the company/business TZ.
 */
export function buildUTCFromLocal(
  dateStr: string,
  timeHHMM: string,
  tz?: string,
): string {
  const zone = tz ?? getBusinessTZ();
  const dt = DateTime.fromISO(`${dateStr}T${timeHHMM}`, { zone });
  return dt.isValid ? dt.toUTC().toISO()! : new Date(`${dateStr}T${timeHHMM}`).toISOString();
}

/**
 * Inverse of {@link buildUTCFromLocal}: an instant back to an 'HH:mm' wall
 * clock in the company TZ, for populating `<input type="time">` fields.
 */
export function toLocalTimeStr(
  date: string | Date | null | undefined,
  tz?: string,
): string {
  const out = formatInTZ(date, 'HH:mm', tz ?? getBusinessTZ());
  return out === '—' ? '' : out;
}

// ── Date boundaries ───────────────────────────────────────────────────────────

/**
 * Get today's date as 'YYYY-MM-DD' in the display TZ (employee's own midnight).
 */
export function todayStr(tz?: string): string {
  const zone = tz ?? getDisplayTZ();
  return DateTime.now().setZone(zone).toISODate() ?? '';
}

/**
 * Get the ISO date string ('YYYY-MM-DD') for a given date in the given TZ.
 */
export function toLocalDateStr(
  date: string | Date | null | undefined,
  tz?: string,
): string {
  if (!date) return '';
  try {
    const zone = tz ?? getDisplayTZ();
    const dt =
      typeof date === 'string'
        ? DateTime.fromISO(date, { zone: 'utc' }).setZone(zone)
        : DateTime.fromJSDate(date, { zone: 'utc' }).setZone(zone);
    return dt.isValid ? (dt.toISODate() ?? '') : '';
  } catch {
    return '';
  }
}

// ── Current time ──────────────────────────────────────────────────────────────

/**
 * Returns the current DateTime in the specified IANA timezone.
 * Defaults to display TZ.
 */
export function nowInTZ(tz?: string): DateTime {
  return DateTime.now().setZone(tz ?? getDisplayTZ());
}

/**
 * Returns a live clock string 'HH:mm:ss' for the given TZ.
 * Use inside a setInterval to update a clock display.
 */
export function nowTimeStr(tz?: string): string {
  return nowInTZ(tz).toFormat('HH:mm:ss');
}

// ── UTC offset label ──────────────────────────────────────────────────────────

/**
 * Returns a human-readable UTC offset label for a given IANA timezone, e.g. 'UTC+5:30'.
 * DST-aware: uses current moment to compute offset.
 */
export function utcOffsetLabel(tz: string): string {
  try {
    const dt = DateTime.now().setZone(tz);
    if (!dt.isValid) return tz;
    const offset = dt.offset; // minutes
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return m === 0
      ? `UTC${sign}${h}`
      : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
  } catch {
    return tz;
  }
}

/**
 * Returns a grouped list of all IANA timezones with labels.
 * Groups by region (Africa, America, Asia, Atlantic, Australia, Europe, Pacific).
 */
export function getGroupedTimezones(): {
  group: string;
  zones: { value: string; label: string; offset: string }[];
}[] {
  const rawZones: string[] =
    typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl
      ? (Intl as any).supportedValuesOf('timeZone')
      : ['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London'];

  const groups: Record<string, { value: string; label: string; offset: string }[]> = {};

  for (const zone of rawZones) {
    const [region] = zone.split('/');
    if (!groups[region]) groups[region] = [];
    const offset = utcOffsetLabel(zone);
    const label = `(${offset}) ${zone.replace(/_/g, ' ')}`;
    groups[region].push({ value: zone, label, offset });
  }

  // Sort each group by offset then name
  for (const g of Object.values(groups)) {
    g.sort((a, b) => {
      const aOff = DateTime.now().setZone(a.value).offset;
      const bOff = DateTime.now().setZone(b.value).offset;
      return aOff !== bOff ? aOff - bOff : a.value.localeCompare(b.value);
    });
  }

  return Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, zones]) => ({ group, zones }));
}
