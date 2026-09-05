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
 * Imports GratuityModule for the entitlement, and reads loans, carry-forwards
 * and garnishments through Prisma directly rather than importing their modules —
 * AdvanceLoansModule's settlement service needs to see settlements, so importing
 * it here would close a cycle.
 */
@Module({
  imports: [PrismaModule, AuditModule, SystemSettingsModule, GratuityModule],
  controllers: [FinalSettlementsController],
  providers: [FinalSettlementsService, PayrollFeaturesService],
  exports: [FinalSettlementsService],
})
export class FinalSettlementsModule {}
