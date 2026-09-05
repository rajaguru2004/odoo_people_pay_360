import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { GratuityController } from './gratuity.controller';
import { GratuityService } from './gratuity.service';

/**
 * End-of-service benefits.
 *
 * One-way dependency: PayrollsModule imports this so `applyLock` can write the
 * monthly provision. This module must never import PayrollsModule back.
 */
@Module({
  imports: [PrismaModule, AuditModule, SystemSettingsModule],
  controllers: [GratuityController],
  providers: [GratuityService, PayrollFeaturesService],
  exports: [GratuityService],
})
export class GratuityModule {}
