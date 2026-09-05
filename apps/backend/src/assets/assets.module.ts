import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetAssignmentsService } from './asset-assignments.service';
import { ClearanceService } from './clearance.service';

/**
 * `ClearanceService` is exported because the three deactivation paths live
 * elsewhere (contracts, employees) and all of them must call it — see
 * `assertCleared`.
 */
@Module({
  imports: [PrismaModule, AuditModule, NotificationsModule, SystemSettingsModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetAssignmentsService, ClearanceService],
  exports: [AssetsService, AssetAssignmentsService, ClearanceService],
})
export class AssetsModule {}
