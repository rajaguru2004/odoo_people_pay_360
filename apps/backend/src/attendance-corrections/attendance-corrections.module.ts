import { Module } from '@nestjs/common';
import { AttendanceCorrectionsController } from './attendance-corrections.controller';
import { AttendanceCorrectionsService } from './attendance-corrections.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    SystemSettingsModule,
    TimezoneModule,
    NotificationsModule,
  ],
  controllers: [AttendanceCorrectionsController],
  providers: [AttendanceCorrectionsService],
  exports: [AttendanceCorrectionsService],
})
export class AttendanceCorrectionsModule {}
