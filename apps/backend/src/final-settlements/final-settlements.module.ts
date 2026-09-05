import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { GratuityModule } from '../gratuity/gratuity.module';
import { PayrollFeaturesService } from '../payrolls/payroll-features.service';
import { FinalSettlementsController } from './final-settlements.controller';
import { FinalSettlementsService } from './final-settlements.service';

/**
 * Final settlements.
 *
 * Imports GratuityModule for the entitlement, and reads carry-forwards and
 * garnishments through Prisma directly rather than importing their modules, so
 * no module that needs to see settlements can close a cycle back onto this one.
 */
@Module({
  imports: [PrismaModule, AuditModule, SystemSettingsModule, GratuityModule],
  controllers: [FinalSettlementsController],
  providers: [FinalSettlementsService, PayrollFeaturesService],
  exports: [FinalSettlementsService],
})
export class FinalSettlementsModule {}
