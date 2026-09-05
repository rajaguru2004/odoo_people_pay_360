import { DateTime } from 'luxon';

/**
 * Read a date the way somebody types one into a chat.
 *
 * Accepts `YYYY-MM-DD`, `DD/MM`, `DD/MM/YYYY`, `DD-MM-YYYY`, and the words
 * today / tomorrow / next <weekday>. Returns `YYYY-MM-DD`, or null — never a
 * guess, because a mis-read date silently books the wrong leave.
 */
export function parseDateWord(raw: string | null | undefined, now = DateTime.utc()): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  if (s === 'today') return now.toISODate();
  if (s === 'tomorrow') return now.plus({ days: 1 }).toISODate();
  if (s === 'day after tomorrow') return now.plus({ days: 2 }).toISODate();
  // Backwards too. Leave is booked forwards, but an expense claim and an
  // attendance correction are always about something that already happened —
  // and their prompts said "yesterday" while the parser refused it.
  if (s === 'yesterday') return now.minus({ days: 1 }).toISODate();
  if (s === 'day before yesterday') return now.minus({ days: 2 }).toISODate();

  const nextDay = /^next\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.exec(s);
  if (nextDay) {
    const target = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(nextDay[1]) + 1;
    let d = now.plus({ days: 1 });
    // At most 7 hops: the same weekday next week is the furthest "next X" means.
    for (let i = 0; i < 7 && d.weekday !== target; i++) d = d.plus({ days: 1 });
    return d.toISODate();
  }

  const formats = ['yyyy-MM-dd', 'dd/MM/yyyy', 'dd-MM-yyyy', 'd/M/yyyy', 'd-M-yyyy'];
  for (const f of formats) {
    const d = DateTime.fromFormat(s, f, { zone: 'utc' });
    if (d.isValid) return guard(d, now);
  }

  // Day/month without a year: assume the next occurrence, so "01/09" in
  // December means next September rather than a date in the past.
  const dm = /^(\d{1,2})[/-](\d{1,2})$/.exec(s);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    let d = DateTime.utc(now.year, month, day);
    if (!d.isValid) return null;
    if (d < now.startOf('day')) d = d.plus({ years: 1 });
    return guard(d, now);
  }

  return null;
}

/**
 * Reject dates far outside any plausible leave request. An unguarded typo like
 * `2026-09-01` written as `2062-09-01` would otherwise be accepted silently.
 */
function guard(d: DateTime, now: DateTime): string | null {
  if (!d.isValid) return null;
  const months = d.diff(now, 'months').months;
  if (months > 18 || months < -18) return null;
  return d.toISODate();
}
