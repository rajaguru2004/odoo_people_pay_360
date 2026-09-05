import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { LeaveEncashmentController } from './leave-encashment.controller';
import { LeaveEncashmentService } from './leave-encashment.service';

/**
 * Leave encashment and carry-forward.
 *
 * One-way: PayrollsModule imports this so a run can pay approved requests. This
 * module must never import PayrollsModule back.
 */
@Module({
  imports: [PrismaModule, AuditModule, SystemSettingsModule],
  controllers: [LeaveEncashmentController],
  providers: [LeaveEncashmentService, PayrollFeaturesService],
  exports: [LeaveEncashmentService],
})
export class LeaveEncashmentModule {}
