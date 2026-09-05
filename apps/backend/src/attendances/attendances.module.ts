import { Module } from '@nestjs/common';
import { AttendancesController } from './attendances.controller';
import { AttendancesService } from './attendances.service';
import { AttendanceHubService } from './attendance-hub.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [PrismaModule, HolidaysModule, SystemSettingsModule, TimezoneModule, MailModule],
  controllers: [AttendancesController],
  providers: [AttendancesService, AttendanceHubService],
  exports: [AttendancesService, AttendanceHubService],
})
export class AttendancesModule {}
