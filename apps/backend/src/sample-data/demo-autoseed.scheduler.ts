import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DateTime } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import {
  CompanyCronGate,
  COMPANY_CRON_TICK,
} from '../common/timezone/company-cron.gate';
import { seedTodayAttendance } from './sample-data.today-attendance';
import { runWithBranchBypass } from '../common/branch/branch-context';

/**
 * Keeps the demo server's attendance current.
 *
 * Fires at 00:30 in EACH ACTIVE BRANCH's own zone, one gate per distinct zone.
 * A single company-local gate was wrong: `seedTodayAttendance` derives every
 * employee's day from their BRANCH's zone, so at 00:30 Asia/Kolkata it is still
 * 23:00 of the previous day in Asia/Muscat — the job stamped Muscat's rows with
 * yesterday's date, found yesterday already filled, and Muscat never got a
 * today. Every branch west of the company timezone had the same silent failure
 * (New York was a full day behind). Gating per zone means each branch is seeded
 * just after its own local midnight.
 *
 * The seed itself stays company-wide and is idempotent, so the extra passes a
 * multi-zone tenant performs are no-ops for the branches already filled.
 *
 * OFF by default (`demo_autoseed_enabled`). It writes attendance rows, so it
 * must never start running on a real tenant because the image was reused.
 */
@Injectable()
export class DemoAutoseedScheduler {
  private readonly logger = new Logger(DemoAutoseedScheduler.name);
  /** One gate per IANA zone; each keeps its own once-per-local-day marker. */
  private readonly gates = new Map<string, CompanyCronGate>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly tzSvc: TimezoneService,
  ) {}

  private gateFor(zone: string): CompanyCronGate {
    let gate = this.gates.get(zone);
    if (!gate) {
      gate = new CompanyCronGate(this.tzSvc, '00:30', { zone });
      this.gates.set(zone, gate);
    }
    return gate;
  }

  /** Distinct valid branch zones, plus the company zone as the fallback one. */
  private async activeZones(): Promise<string[]> {
    const companyTz = await this.tzSvc.getCompanyTZ();
    const branches = await runWithBranchBypass(() =>
      this.prisma.branch.findMany({ select: { timezone: true } }),
    );
    const zones = new Set<string>([companyTz]);
    for (const b of branches) {
      // Skip garbage like the demo data's 'Aska/Kolkata' — an invalid zone
      // would make the gate's local-day key meaningless.
      if (b.timezone && DateTime.local().setZone(b.timezone).isValid) {
        zones.add(b.timezone);
      }
    }
    return [...zones];
  }

  @Cron(COMPANY_CRON_TICK, { name: 'demo-autoseed-attendance' })
  async tick(now: Date = new Date()) {
    // Checked before the branch read so a real tenant with the switch off does
    // no query work every five minutes.
    const enabled = await this.settings.getSetting(
      'demo_autoseed_enabled',
      'false',
    );
    if (enabled !== 'true') return;

    // Every gate is evaluated, never short-circuited: `due()` is what stamps a
    // zone's once-per-day marker, and each zone's window is only as wide as one
    // tick, so a skipped check is a skipped day for that branch.
    let due = false;
    for (const zone of await this.activeZones()) {
      if (await this.gateFor(zone).due(now)) due = true;
    }
    if (!due) return;

    return this.run(now);
  }

  /** The top-up itself — callable directly (tests, manual trigger). */
  async run(now?: Date) {
    const enabled = await this.settings.getSetting('demo_autoseed_enabled', 'false');
    if (enabled !== 'true') return null;

    const companyTz = await this.tzSvc.getCompanyTZ();
    // Demo servers may be told to fill weekly offs too, so a Fri/Sat Oman
    // weekend does not leave every screen empty for two days running. The
    // branch's real working week is never rewritten to achieve it.
    const includeOffDays =
      (await this.settings.getSetting('demo_autoseed_include_offdays', 'false')) ===
      'true';

    // The job is company-wide by design; without the bypass it would only ever
    // see the branches of whoever's context happened to be active.
    const result = await runWithBranchBypass(() =>
      seedTodayAttendance(this.prisma, { companyTz, includeOffDays, now }),
    );
    this.logger.log(
      `[Cron] demo-autoseed-attendance: ${result.created} created, ${result.closed} closed, ` +
        `${result.existing} already present, ${result.offDay} off-day.`,
    );
    return result;
  }
}
