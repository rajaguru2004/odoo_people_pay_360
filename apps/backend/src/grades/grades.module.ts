import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { GradesController } from './grades.controller';
import { GradesService } from './grades.service';

@Module({
  imports: [PrismaModule, AuditModule, SystemSettingsModule],
  controllers: [GradesController],
  providers: [GradesService, PayrollFeaturesService],
  exports: [GradesService],
})
export class GradesModule {}
