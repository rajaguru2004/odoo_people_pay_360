import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

/**
 * One-time repair for work schedules whose start/end were stored in the WRONG
 * timezone, run automatically on deploy (from prisma/seed.ts).
 *
 * The defect: ScheduleModal / BulkScheduleModal built the instant with
 * `new Date(\`${date}T${time}\`)`, which resolves the typed wall clock in the
 * BROWSER's zone. An admin in Asia/Kolkata scheduling 08:00 for an
 * Asia/Singapore company stored 02:30Z — a 10:30 SGT shift whose reminder email
 * fired at 08:00 IST. The frontend now builds the instant in the company zone
 * (utils/tzDate.ts → buildUTCFromLocal), but rows written before that ship are
 * still off by `offset(entryTz) - offset(companyTZ)`.
 *
 * Design notes:
 *  • Runs ONCE. A marker row in system_settings records completion, so a
 *    restart, a re-deploy or a crashed boot cannot shift the same rows twice.
 *  • Skipped silently when entry TZ == company TZ (delta 0), which is the case
 *    for every deployment whose admins sit in the company's own zone.
 *  • Scoped to TODAY ONWARD by default: those are the rows that still drive
 *    reminders and payroll. Past shifts are history — moving them would rewrite
 *    reports that have already been sent. Set SCHEDULE_TZ_BACKFILL_FROM=all (or
 *    a YYYY-MM-DD) to widen the window.
 *  • Never throws into the boot path. On failure it logs and leaves the marker
 *    unwritten, so the next deploy retries.
 *
 * Env:
 *   SCHEDULE_TZ_BACKFILL_ENTRY_TZ  IANA zone the times were TYPED in
 *                                  (the admin's browser). Default Asia/Kolkata.
 *   SCHEDULE_TZ_BACKFILL_FROM      'today' (default) | 'all' | 'YYYY-MM-DD'
 *   SCHEDULE_TZ_BACKFILL_SKIP      '1' to disable the backfill entirely.
 */

const MARKER_KEY = 'schedule_tz_backfill_v1';
const DEFAULT_ENTRY_TZ = 'Asia/Kolkata';

/** Company zone as the app resolves it (TimezoneService.getCompanyTZ). */
async function companyTimezone(prisma: PrismaClient): Promise<string> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: 'system_timezone' },
  });
  const tz = row?.value?.trim();
  return tz && DateTime.now().setZone(tz).isValid ? tz : 'Asia/Kolkata';
}

/** Lower bound on `date` for the rows to repair. `null` = no bound. */
function scopeFrom(companyTZ: string): Date | null {
  const raw = (process.env.SCHEDULE_TZ_BACKFILL_FROM || 'today').trim();
  if (raw.toLowerCase() === 'all') return null;
  if (raw.toLowerCase() === 'today') {
    const today = DateTime.now().setZone(companyTZ);
    return new Date(Date.UTC(today.year, today.month - 1, today.day));
  }
  const parsed = DateTime.fromISO(raw, { zone: 'utc' });
  if (!parsed.isValid) {
    throw new Error(`SCHEDULE_TZ_BACKFILL_FROM is not a date: '${raw}'`);
  }
  return parsed.startOf('day').toJSDate();
}

export async function backfillScheduleTimezone(
  prisma: PrismaClient,
): Promise<void> {
  if (process.env.SCHEDULE_TZ_BACKFILL_SKIP === '1') return;

  const marker = await prisma.systemSetting.findUnique({
    where: { key: MARKER_KEY },
  });
  if (marker) return; // already repaired on an earlier deploy

  const entryTZ = (
    process.env.SCHEDULE_TZ_BACKFILL_ENTRY_TZ || DEFAULT_ENTRY_TZ
  ).trim();
  if (!DateTime.now().setZone(entryTZ).isValid) {
    console.warn(
      `⚠️  Schedule TZ backfill skipped: SCHEDULE_TZ_BACKFILL_ENTRY_TZ='${entryTZ}' is not a valid IANA zone.`,
    );
    return;
  }

  const companyTZ = await companyTimezone(prisma);
  if (entryTZ === companyTZ) {
    // Nothing to repair: the browser zone the times were typed in IS the
    // company zone, so the old code stored the right instant.
    await writeMarker(prisma, { entryTZ, companyTZ, shifted: 0, scanned: 0 });
    return;
  }

  const from = scopeFrom(companyTZ);
  const rows = await prisma.workSchedule.findMany({
    where: {
      shiftType: { not: 'FLEXIBLE' },
      startTime: { not: null },
      endTime: { not: null },
      ...(from ? { date: { gte: from } } : {}),
    },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      priorEmailSent: true,
      postEmailSent: true,
    },
  });

  if (rows.length === 0) {
    await writeMarker(prisma, { entryTZ, companyTZ, shifted: 0, scanned: 0 });
    return;
  }

  console.log(
    `🕓 Repairing work-schedule timezones (${entryTZ} → ${companyTZ}) over ${rows.length} row(s)` +
      `${from ? ` from ${from.toISOString().slice(0, 10)}` : ''}...`,
  );

  const now = Date.now();
  let shifted = 0;

  for (const row of rows) {
    const start = row.startTime!;
    const end = row.endTime!;

    // How far the stored instant sits from the intended one, AT THAT INSTANT so
    // DST transitions stay correct: the same wall clock resolved in the entry
    // zone lands `offset(company) - offset(entry)` later than in the company
    // zone (08:00 IST = 02:30Z, 08:00 SGT = 00:00Z → 150 min too late).
    const deltaMins =
      DateTime.fromJSDate(start).setZone(companyTZ).offset -
      DateTime.fromJSDate(start).setZone(entryTZ).offset;
    if (deltaMins === 0) continue;

    const newStart = new Date(start.getTime() - deltaMins * 60_000);
    const newEnd = new Date(end.getTime() - deltaMins * 60_000);

    // A reminder already sent against the WRONG instant must be allowed to go
    // out again at the corrected one, as long as that is still ahead of us.
    const stillUpcoming = newStart.getTime() > now;

    await prisma.workSchedule.update({
      where: { id: row.id },
      data: {
        startTime: newStart,
        endTime: newEnd,
        ...(stillUpcoming ? { priorEmailSent: false, postEmailSent: false } : {}),
      },
    });
    shifted++;
  }

  await writeMarker(prisma, {
    entryTZ,
    companyTZ,
    shifted,
    scanned: rows.length,
  });
  console.log(
    `✅ Work-schedule timezone repair: ${shifted} of ${rows.length} row(s) corrected.`,
  );
}

async function writeMarker(
  prisma: PrismaClient,
  detail: { entryTZ: string; companyTZ: string; shifted: number; scanned: number },
): Promise<void> {
  const value = JSON.stringify({ ...detail, at: new Date().toISOString() });
  await prisma.systemSetting.upsert({
    where: { key: MARKER_KEY },
    update: { value },
    create: { key: MARKER_KEY, value },
  });
}
