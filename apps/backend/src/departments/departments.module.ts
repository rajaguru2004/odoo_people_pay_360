import { Module } from '@nestjs/common';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { DepartmentChangeRequestsService } from './department-change-requests.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, MailModule, SystemSettingsModule, NotificationsModule],
  controllers: [DepartmentsController],
  providers: [DepartmentsService, DepartmentChangeRequestsService],
  exports: [DepartmentsService, DepartmentChangeRequestsService],
})
export class DepartmentsModule {}
