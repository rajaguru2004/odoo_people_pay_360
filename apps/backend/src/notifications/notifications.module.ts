import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationsController } from './notifications.controller';
import { PrismaModule } from '../prisma/prisma.module';
import {
  NOTIFICATION_CHANNELS,
  NotificationChannelSink,
} from './notification-channel.sink';

/**
 * In-app notifications, plus the fan-out to every delivery channel.
 *
 * No delivery channel is registered today, so the fan-out list is empty and
 * NotificationsService writes the in-app row and stops.
 *
 * Adding a channel means importing its module here and injecting its sink into
 * the factory below, and nothing else — NotificationsService fans out to
 * whatever is registered and knows about none of them. A channel module must
 * import only PrismaModule + AuditModule, so the edge cannot create a cycle
 * with the ~20 domain modules that import NotificationsModule.
 */
@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationDispatcher,
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (...channels: NotificationChannelSink[]) => channels,
      inject: [],
    },
  ],
  exports: [NotificationsService, NotificationDispatcher],
})
export class NotificationsModule {}
