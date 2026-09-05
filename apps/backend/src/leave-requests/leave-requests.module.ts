import { Module } from '@nestjs/common';
import { LeaveRequestsController } from './leave-requests.controller';
import { LeaveRequestsService } from './leave-requests.service';
import { LeaveHubService } from './leave-hub.service';
import { PrismaModule } from '../prisma/prisma.module';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { MailModule } from '../mail/mail.module';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    PrismaModule,
    LeaveBalancesModule,
    HolidaysModule,
    SystemSettingsModule,
    MailModule,
    TimezoneModule,
    ApprovalsModule,
    NotificationsModule,
  ],
  controllers: [LeaveRequestsController],
  providers: [LeaveRequestsService, LeaveHubService],
  exports: [LeaveRequestsService],
})
export class LeaveRequestsModule {}
