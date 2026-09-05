import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { runWithBranchBypass } from '../../common/branch/branch-context';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppActionTokenService } from '../approvals/whatsapp-action-token.service';
import { WhatsAppRateLimitService } from '../runtime/whatsapp-rate-limit.service';
import { WhatsAppSessionService } from '../session/whatsapp-session.service';
import { WhatsAppSettingsService } from '../whatsapp-settings.service';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { INBOUND_STATUS } from '../whatsapp.types';
import { TimezoneService } from '../../common/timezone/timezone.service';
import {
  CompanyCronGate,
  COMPANY_CRON_TICK,
} from '../../common/timezone/company-cron.gate';

/**
 * Housekeeping for the inbound channel.
 *
 * Retry exists because processing is detached from the HTTP response: if the
 * process dies mid-message there is no broker holding it, only the claim row.
 */
@Injectable()
export class WhatsAppInboundScheduler {
  private readonly logger = new Logger(WhatsAppInboundScheduler.name);
  private running = false;
  private readonly retentionGate: CompanyCronGate;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: WhatsAppSettingsService,
    private readonly inbound: WhatsAppInboundService,
    private readonly sessions: WhatsAppSessionService,
    private readonly tokens: WhatsAppActionTokenService,
    private readonly rates: WhatsAppRateLimitService,
    private readonly tzSvc: TimezoneService,
  ) {
    this.retentionGate = new CompanyCronGate(this.tzSvc, '03:45');
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'whatsapp-inbound-retry' })
  async retry(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cfg = await this.settings.get();
      if (!cfg.inboundEnabled) return;

      await runWithBranchBypass(async () => {
        // A row stuck in PROCESSING means the process died mid-message.
        const stuck = await this.prisma.whatsAppInboundMessage.updateMany({
          where: {
            status: INBOUND_STATUS.PROCESSING,
            receivedAt: { lt: new Date(Date.now() - 2 * 60_000) },
          },
          data: { status: INBOUND_STATUS.FAILED, nextRetryAt: new Date() },
        });
        if (stuck.count) this.logger.warn(`Recovered ${stuck.count} stuck inbound message(s).`);

        const due = await this.prisma.whatsAppInboundMessage.findMany({
          where: {
            status: INBOUND_STATUS.FAILED,
            attempts: { lt: 3 },
            nextRetryAt: { lte: new Date() },
          },
          orderBy: { receivedAt: 'asc' },
          take: 20,
          select: { id: true },
        });
        for (const { id } of due) await this.inbound.process(id);
      });
    } catch (e) {
      this.logger.error(`WhatsApp inbound retry failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Idle flows, expired confirmations and expired tokens. */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'whatsapp-session-sweep' })
  async sweep(): Promise<void> {
    try {
      const cfg = await this.settings.get();
      await runWithBranchBypass(async () => {
        await this.sessions.clearIdle(cfg.sessionIdleMinutes);
        await this.prisma.whatsAppPendingAction.updateMany({
          where: { status: 'PENDING', expiresAt: { lt: new Date() } },
          data: { status: 'EXPIRED', resolvedAt: new Date() },
        });
        await this.tokens.expireStale();
      });
      this.rates.prune();
    } catch (e) {
      this.logger.warn(`WhatsApp session sweep failed: ${(e as Error).message}`);
    }
  }

  /** Conversation log retention — 03:45 company-local. */
  @Cron(COMPANY_CRON_TICK, { name: 'whatsapp-inbound-retention' })
  async retentionTick(): Promise<void> {
    if (!(await this.retentionGate.due())) return;
    return this.retention();
  }

  async retention(): Promise<void> {
    try {
      const cfg = await this.settings.get();
      const cutoff = new Date(Date.now() - cfg.inboundRetentionDays * 86_400_000);
      const res = await runWithBranchBypass(() =>
        this.prisma.whatsAppInboundMessage.deleteMany({ where: { receivedAt: { lt: cutoff } } }),
      );
      if (res.count) this.logger.log(`WhatsApp inbound retention removed ${res.count} rows.`);
    } catch (e) {
      this.logger.warn(`WhatsApp inbound retention failed: ${(e as Error).message}`);
    }
  }
}
