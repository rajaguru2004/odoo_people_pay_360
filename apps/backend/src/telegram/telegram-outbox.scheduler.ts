import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TelegramOutboxService } from './telegram-outbox.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import { CompanyCronGate, COMPANY_CRON_TICK } from '../common/timezone/company-cron.gate';

/**
 * Durability backstop for the Telegram outbox.
 *
 * Enqueue already fires an opportunistic inline attempt, so this cron exists for
 * the cases that attempt cannot cover: a process restart mid-send, a Telegram
 * outage, and rows whose backoff has since elapsed. Same shape and same
 * reasoning as WhatsAppOutboxScheduler, including the absence of a `timeZone` —
 * an every-two-minutes job has no meaningful local time and a timeZone would
 * only add a DST edge case. Overlap is harmless: TelegramOutboxService guards
 * with an in-process flag and, underneath that, the conditional-updateMany claim.
 *
 * This lives in the INBOUND module rather than the outbound one, which is where
 * TimezoneModule can be imported without putting a SystemSettingsModule edge on
 * the path NotificationsModule takes into this channel.
 */
@Injectable()
export class TelegramOutboxScheduler {
  private readonly logger = new Logger(TelegramOutboxScheduler.name);

  /** Nightly sweep at 03:40 company-local — ten minutes after WhatsApp's. */
  private readonly sweepGate: CompanyCronGate;

  constructor(
    private readonly outbox: TelegramOutboxService,
    private readonly tzSvc: TimezoneService,
  ) {
    this.sweepGate = new CompanyCronGate(this.tzSvc, '03:40');
  }

  @Cron('*/2 * * * *', { name: 'telegram-outbox-drain' })
  async drain() {
    const result = await this.outbox.drain();
    if (result.processed > 0) {
      this.logger.log(
        `[Cron] telegram-outbox-drain: processed=${result.processed} sent=${result.sent} failed=${result.failed}`,
      );
    }
    return result;
  }

  @Cron(COMPANY_CRON_TICK, { name: 'telegram-outbox-sweep' })
  async sweepTick() {
    if (!(await this.sweepGate.due())) return;
    return this.sweep();
  }

  async sweep() {
    return this.outbox.sweep();
  }
}
