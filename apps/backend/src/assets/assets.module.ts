import { Module } from '@nestjs/common';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetAssignmentsService } from './asset-assignments.service';
import { ClearanceService } from './clearance.service';

/**
 * `ClearanceService` is exported because the paths that end an employment live
 * in other modules, and every one of them has to call it before deactivating
 * anybody — see `assertCleared`.
 */
@Module({
  imports: [SystemSettingsModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetAssignmentsService, ClearanceService],
  exports: [AssetsService, AssetAssignmentsService, ClearanceService],
})
export class AssetsModule {}
