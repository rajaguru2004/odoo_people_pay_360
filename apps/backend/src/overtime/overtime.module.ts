import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { OvertimePolicyModule } from '../overtime-policy/overtime-policy.module';
// The working-day helpers belong to the leave module, which exports them. See
// the note at the top of working-days.service.ts for why they live there.
import { LeaveRequestsModule } from '../leave-requests/leave-requests.module';
import { OvertimeController } from './overtime.controller';
import { OvertimeService } from './overtime.service';

@Module({
  imports: [
    PrismaModule,
    SystemSettingsModule,
    OvertimePolicyModule,
    LeaveRequestsModule,
  ],
  controllers: [OvertimeController],
  providers: [OvertimeService],
  exports: [OvertimeService],
})
export class OvertimeModule {}
