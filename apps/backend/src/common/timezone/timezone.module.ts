import { Module } from '@nestjs/common';
import { TimezoneService } from './timezone.service';
import { SystemSettingsModule } from '../../system-settings/system-settings.module';

@Module({
  imports: [SystemSettingsModule],
  providers: [TimezoneService],
  exports: [TimezoneService],
})
export class TimezoneModule {}
