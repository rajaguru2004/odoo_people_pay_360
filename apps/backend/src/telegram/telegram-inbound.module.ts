import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { TelegramModule } from './telegram.module';
import { TelegramInboundService } from './inbound/telegram-inbound.service';
import { TelegramWebhookController } from './inbound/telegram-webhook.controller';
import { TelegramOutboxScheduler } from './telegram-outbox.scheduler';

/**
 * Telegram channel — INBOUND half (webhook), plus the outbox cron.
 *
 * A leaf, like WhatsAppInboundModule and DiscordInboundModule: nothing imports
 * it. That is what lets it depend on TimezoneModule — which pulls in
 * SystemSettingsModule — without putting that edge on the path
 * NotificationsModule takes into TelegramModule.
 *
 * The scheduler lives here for exactly that reason: it needs TimezoneService
 * for the company-local nightly sweep, and TelegramModule must stay a two-import
 * leaf. A cron in a leaf module still runs — app.module imports this.
 */
@Module({
  imports: [PrismaModule, TimezoneModule, TelegramModule],
  controllers: [TelegramWebhookController],
  providers: [TelegramInboundService, TelegramOutboxScheduler],
  exports: [TelegramInboundService],
})
export class TelegramInboundModule {}
