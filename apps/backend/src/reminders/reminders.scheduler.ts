import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RemindersService } from './reminders.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import {
  CompanyCronGate,
  COMPANY_CRON_TICK,
} from '../common/timezone/company-cron.gate';

/**
 * The single expiry-reminder cron. Runs at 02:00 COMPANY-LOCAL time (the
 * `system_timezone` setting, not a zone baked into the decorator), after the
 * 00:30 and 01:00 auto-expire jobs, so anything that lapsed overnight is
 * already EXPIRED and correctly excluded from the reminder window.
 */
@Injectable()
export class RemindersScheduler {
  private readonly logger = new Logger(RemindersScheduler.name);
  private readonly gate: CompanyCronGate;

  constructor(
    private readonly reminders: RemindersService,
    private readonly tzSvc: TimezoneService,
  ) {
    this.gate = new CompanyCronGate(this.tzSvc, '02:00');
  }

  @Cron(COMPANY_CRON_TICK, { name: 'expiry-reminders' })
  async tick() {
    if (!(await this.gate.due())) return;
    return this.run();
  }

  /** The reminder sweep itself — callable directly (tests, manual trigger). */
  async run() {
    const result = await this.reminders.runAll();
    if (result.total > 0) {
      this.logger.log(`[Cron] expiry-reminders: ${JSON.stringify(result.sent)}`);
    }
    return result;
  }
}
