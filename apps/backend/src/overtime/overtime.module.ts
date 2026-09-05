import { Module } from '@nestjs/common';
import { OvertimeService } from './overtime.service';
import { OvertimeController } from './overtime.controller';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AttendancesModule } from '../attendances/attendances.module';
import { OvertimePolicyModule } from '../overtime-policy/overtime-policy.module';

/**
 * AttendancesModule is imported for the calendar service alone: whether a date
 * is a rest day or a holiday decides the premium tier, and that answer has to
 * be the one the attendance records already give.
 */
@Module({
  imports: [
    SystemSettingsModule,
    ApprovalsModule,
    AttendancesModule,
    OvertimePolicyModule,
  ],
  controllers: [OvertimeController],
  providers: [OvertimeService],
  exports: [OvertimeService],
})
export class OvertimeModule {}
