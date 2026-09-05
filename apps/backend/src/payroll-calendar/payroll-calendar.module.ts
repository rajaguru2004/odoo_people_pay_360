import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { PayrollCalendarController } from './payroll-calendar.controller';
import { PayrollCalendarService } from './payroll-calendar.service';

@Module({
  imports: [PrismaModule, AuditModule, SystemSettingsModule],
  controllers: [PayrollCalendarController],
  providers: [PayrollCalendarService, PayrollFeaturesService],
  exports: [PayrollCalendarService],
})
export class PayrollCalendarModule {}
