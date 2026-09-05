import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationsController } from './notifications.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { WhatsAppOutboxService } from '../whatsapp/whatsapp-outbox.service';
import { DiscordModule } from '../discord/discord.module';
import { DiscordOutboxService } from '../discord/discord-outbox.service';
import { TelegramModule } from '../telegram/telegram.module';
import { TelegramOutboxService } from '../telegram/telegram-outbox.service';
import { NOTIFICATION_CHANNELS } from './notification-channel.sink';

/**
 * In-app notifications, plus the fan-out to every delivery channel.
 *
 * Both channel modules import only PrismaModule + AuditModule precisely so
 * these edges cannot create a cycle with the ~20 domain modules that import
 * NotificationsModule. Their inbound halves, which need McpModule, are separate
 * leaf modules.
 *
 * Adding a channel means adding it to this array and nothing else —
 * NotificationsService fans out to whatever is registered and knows about none
 * of them. Telegram was the third, and it cost exactly the two lines below.
 */
@Module({
  imports: [PrismaModule, WhatsAppModule, DiscordModule, TelegramModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationDispatcher,
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (
        whatsapp: WhatsAppOutboxService,
        discord: DiscordOutboxService,
        telegram: TelegramOutboxService,
      ) => [whatsapp, discord, telegram],
      inject: [WhatsAppOutboxService, DiscordOutboxService, TelegramOutboxService],
    },
  ],
  exports: [NotificationsService, NotificationDispatcher],
})
export class NotificationsModule {}
