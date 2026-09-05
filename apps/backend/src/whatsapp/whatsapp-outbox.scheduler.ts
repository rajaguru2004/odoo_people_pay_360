import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WhatsAppOutboxService } from './whatsapp-outbox.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import {
  CompanyCronGate,
  COMPANY_CRON_TICK,
} from '../common/timezone/company-cron.gate';

/**
 * Durability backstop for the outbox.
 *
 * Enqueue already fires an opportunistic inline attempt, so this cron exists for
 * the cases that attempt cannot cover: a process restart mid-send, a gateway
 * that was down, and rows whose backoff has since elapsed.
 *
 * No `timeZone` on the drainer — unlike the 02:00 reminder cron, an
 * every-two-minutes job has no meaningful local time and a timeZone would only
 * add a DST edge case. Overlap is harmless anyway: WhatsAppOutboxService guards
 * with an in-process flag and, underneath that, the conditional-updateMany claim.
 */
@Injectable()
export class WhatsAppOutboxScheduler {
  private readonly logger = new Logger(WhatsAppOutboxScheduler.name);

  /** Nightly sweep at 03:30 company-local. */
  private readonly sweepGate: CompanyCronGate;

  constructor(
    private readonly outbox: WhatsAppOutboxService,
    private readonly tzSvc: TimezoneService,
  ) {
    this.sweepGate = new CompanyCronGate(this.tzSvc, '03:30');
  }

  @Cron('*/2 * * * *', { name: 'whatsapp-outbox-drain' })
  async drain() {
    const result = await this.outbox.drain();
    if (result.processed > 0) {
      this.logger.log(
        `[Cron] whatsapp-outbox-drain: processed=${result.processed} sent=${result.sent} failed=${result.failed}`,
      );
    }
    return result;
  }

  @Cron(COMPANY_CRON_TICK, { name: 'whatsapp-outbox-sweep' })
  async sweepTick() {
    if (!(await this.sweepGate.due())) return;
    return this.sweep();
  }

  async sweep() {
    return this.outbox.sweep();
  }
}
