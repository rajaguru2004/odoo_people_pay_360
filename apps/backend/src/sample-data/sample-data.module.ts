import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PayrollsModule } from '../payrolls/payrolls.module';
import { SampleDataService } from './sample-data.service';
import { SampleDataController } from './sample-data.controller';
import { DemoAutoseedScheduler } from './demo-autoseed.scheduler';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';

/**
 * Sample/demo data seeding. Kept in its own module (not SystemSettingsModule)
 * because it depends on PayrollsModule, and PayrollsModule already depends on
 * SystemSettingsModule — housing it here avoids a circular module dependency.
 */
@Module({
  imports: [PrismaModule, PayrollsModule, TimezoneModule, SystemSettingsModule],
  controllers: [SampleDataController],
  providers: [SampleDataService, DemoAutoseedScheduler],
  exports: [SampleDataService],
})
export class SampleDataModule {}
