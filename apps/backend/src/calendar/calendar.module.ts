import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { SchedulesHubService } from './schedules-hub.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShiftNotificationScheduler } from './shift-notification.scheduler';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { HolidaysModule } from '../holidays/holidays.module';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    SystemSettingsModule,
    NotificationsModule,
    TimezoneModule,
    HolidaysModule,
  ],
  controllers: [CalendarController],
  providers: [CalendarService, SchedulesHubService, ShiftNotificationScheduler],
  exports: [CalendarService],
})
export class CalendarModule {}
