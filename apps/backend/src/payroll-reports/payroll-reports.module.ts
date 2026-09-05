import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { PayrollReportsController } from './payroll-reports.controller';
import { PayrollReportsService } from './payroll-reports.service';

/**
 * Declared BEFORE PayrollsModule wherever both are imported, so
 * `payrolls/reports/...` is matched before `payrolls/:id`.
 */
@Module({
  imports: [PrismaModule, SystemSettingsModule],
  controllers: [PayrollReportsController],
  // `PayrollFeaturesService` is a stateless resolver over system settings, so it
  // is provided here directly rather than importing PayrollsModule — which must
  // load AFTER this one for the route-order reason above.
  providers: [PayrollReportsService, PayrollFeaturesService],
  exports: [PayrollReportsService],
})
export class PayrollReportsModule {}
