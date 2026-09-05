import { Module } from '@nestjs/common';
import { AttendancesModule } from '../attendances/attendances.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AttendanceIntegrationsController } from './attendance-integrations.controller';
import { AttendanceIntegrationsService } from './attendance-integrations.service';
import { AttendanceSyncService } from './attendance-sync.service';
import { FusionAnalyticsProvider } from './providers/fusion-analytics.provider';
import { ProviderRegistry } from './providers/provider.registry';

/**
 * External attendance provider framework.
 *
 * Imports AttendancesModule so every synced row is written through
 * AttendancesService — work hours, lunch deduction and the late/early flags stay
 * in the service that owns those rules, and a synced row ends up numerically
 * identical to a manually entered one.
 *
 * Adding a vendor: implement AttendanceProvider, add it to `providers` below and
 * to ProviderRegistry's constructor. Nothing else changes.
 */
@Module({
  imports: [PrismaModule, AttendancesModule],
  controllers: [AttendanceIntegrationsController],
  providers: [
    FusionAnalyticsProvider,
    ProviderRegistry,
    AttendanceIntegrationsService,
    AttendanceSyncService,
  ],
  exports: [AttendanceIntegrationsService, AttendanceSyncService, ProviderRegistry],
})
export class AttendanceIntegrationsModule {}
