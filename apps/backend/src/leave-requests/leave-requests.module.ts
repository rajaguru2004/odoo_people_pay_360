import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AttendancesModule } from '../attendances/attendances.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { LeaveRequestsController } from './leave-requests.controller';
import { LeaveRequestsService } from './leave-requests.service';
import { LeaveWorkingDaysService } from './leave-working-days.service';

@Module({
  imports: [
    PrismaModule,
    // The branch calendar decides which of a leave range's dates are working
    // days, and the same answer has to drive both the charged duration and the
    // attendance rows written on approval.
    AttendancesModule,
    ApprovalsModule,
    LeaveBalancesModule,
  ],
  controllers: [LeaveRequestsController],
  providers: [LeaveRequestsService, LeaveWorkingDaysService],
  exports: [LeaveRequestsService],
})
export class LeaveRequestsModule {}
