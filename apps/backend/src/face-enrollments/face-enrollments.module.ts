import { Module } from '@nestjs/common';
import { FaceEnrollmentsService } from './face-enrollments.service';
import { FaceEnrollmentsController } from './face-enrollments.controller';

@Module({
  controllers: [FaceEnrollmentsController],
  providers: [FaceEnrollmentsService],
  exports: [FaceEnrollmentsService],
})
export class FaceEnrollmentsModule {}
