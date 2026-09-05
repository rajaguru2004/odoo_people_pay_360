import { Module } from '@nestjs/common';
import { FaceEnrollmentsService } from './face-enrollments.service';
import { FaceEnrollmentsController } from './face-enrollments.controller';
import { FaceDescriptorService } from './face-descriptor.service';
import { SystemSettingsModule } from '../system-settings/system-settings.module';

@Module({
  // The match threshold is an operating parameter an administrator tunes, so it
  // is read from system settings rather than compiled in.
  imports: [SystemSettingsModule],
  controllers: [FaceEnrollmentsController],
  providers: [FaceEnrollmentsService, FaceDescriptorService],
  exports: [FaceEnrollmentsService],
})
export class FaceEnrollmentsModule {}
