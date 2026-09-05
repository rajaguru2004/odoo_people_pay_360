import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { EmployeeTransfersController } from './employee-transfers.controller';
import { EmployeeTransfersService } from './employee-transfers.service';

@Module({
  imports: [PrismaModule, AuditModule, SystemSettingsModule],
  controllers: [EmployeeTransfersController],
  providers: [EmployeeTransfersService, PayrollFeaturesService],
  exports: [EmployeeTransfersService],
})
export class EmployeeTransfersModule {}
