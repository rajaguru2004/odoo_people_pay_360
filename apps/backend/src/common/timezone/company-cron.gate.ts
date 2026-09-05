import { TimezoneService } from './timezone.service';

/**
 * Fires a daily/monthly job at a wall clock in the ADMIN-CONFIGURED company
 * timezone (`system_timezone`) instead of a zone hardcoded at build time.
 *
 * `@Cron({ timeZone })` is baked in when the decorator is evaluated, so it can
 * never follow the setting — a job pinned to `Asia/Ho_Chi_Minh` kept firing at
 * Vietnam wall-clock for a company that had set Asia/Singapore. The pattern
 * here instead: tick on a short fixed cron and let the gate decide whether
 * "now" falls in the target window of the company-local day.
 *
 * `due()` returns true at most once per company-local day (or per month when
 * `dayOfMonth` is given), so a widened window still cannot double-fire. The
 * marker is in-memory, matching the existing daily-report cron; it resets on
 * restart, which at worst re-sends one day's job.
 */
export class CompanyCronGate {
  private lastRunKey: string | null = null;

  /**
   * @param tz          shared TimezoneService (resolves + caches company TZ)
   * @param targetHHMM  company-local firing time, 'HH:MM'
   * @param opts.windowMins  how long the window stays open (default 5 —
   *                    must be >= the tick interval so no tick is missed)
   * @param opts.dayOfMonth  restrict to one company-local day of month
   * @param opts.zone   fire on THIS zone's wall clock instead of the company
   *                    one. A job that acts per BRANCH needs one gate per
   *                    branch zone: a single company-local gate fires at an
   *                    instant when a branch west of the company has not yet
   *                    reached the new day, so the job stamps that branch's
   *                    rows with yesterday's date.
   */
  constructor(
    private readonly tz: TimezoneService,
    private readonly targetHHMM: string,
    private readonly opts: {
      windowMins?: number;
      dayOfMonth?: number;
      zone?: string;
    } = {},
  ) {}

  async due(now: Date = new Date()): Promise<boolean> {
    const zone = this.opts.zone ?? (await this.tz.getCompanyTZ());
    const target = this.tz.parseTimeHHMM(this.targetHHMM, 0);
    const nowMins = this.tz.localMinutesOfDay(now, zone);
    const windowMins = this.opts.windowMins ?? 5;

    if (nowMins < target || nowMins >= target + windowMins) return false;

    const localDay = this.tz.toLocalDateStr(now, zone); // 'YYYY-MM-DD'
    if (
      this.opts.dayOfMonth !== undefined &&
      Number(localDay.slice(8, 10)) !== this.opts.dayOfMonth
    ) {
      return false;
    }

    if (this.lastRunKey === localDay) return false;
    this.lastRunKey = localDay;
    return true;
  }
}

/**
 * Tick expression for gated jobs: every 5 minutes. Every IANA UTC offset is a
 * multiple of 5 minutes, so exactly one tick lands inside each 5-minute
 * company-local window.
 */
export const COMPANY_CRON_TICK = '*/5 * * * *';
