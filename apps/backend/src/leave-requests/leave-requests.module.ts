import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { LeaveRequestsController } from './leave-requests.controller';
import { LeaveRequestsService } from './leave-requests.service';
import { LeaveHubService } from './leave-hub.service';
import { WorkingDaysService } from './working-days.service';

@Module({
  imports: [PrismaModule, SystemSettingsModule, LeaveBalancesModule],
  controllers: [LeaveRequestsController],
  providers: [LeaveRequestsService, LeaveHubService, WorkingDaysService],
  // `WorkingDaysService` is exported because the overtime module classifies its
  // days with it. See the note at the top of that file for why it lives here
  // rather than in `holidays/`.
  exports: [LeaveRequestsService, WorkingDaysService],
})
export class LeaveRequestsModule {}
