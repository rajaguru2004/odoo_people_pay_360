const MS_PER_DAY = 86_400_000;

/**
 * Midnight UTC of the given instant.
 *
 * Date-only columns (`@db.Date`) come back from Prisma at midnight UTC, so
 * comparing them against a raw `new Date()` mixes a wall-clock instant with a
 * calendar date and puts a document that expires today one day out. Both sides
 * of every expiry comparison go through here first.
 */
export function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

export function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * MS_PER_DAY);
}

/**
 * Whole days from today to `date` — negative once the date has passed, zero on
 * the day itself. Both operands are snapped to a UTC day so the result is an
 * exact integer rather than a fraction of an hour either way.
 */
export function daysUntil(date: Date, from: Date = new Date()): number {
  return Math.round(
    (startOfUtcDay(date).getTime() - startOfUtcDay(from).getTime()) /
      MS_PER_DAY,
  );
}
