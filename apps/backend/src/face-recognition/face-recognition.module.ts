import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FaceRecognitionController } from './face-recognition.controller';
import { FaceRecognitionService } from './face-recognition.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { AttendancesModule } from '../attendances/attendances.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AttendancesModule,
    ConfigModule,
    SystemSettingsModule,
  ],
  controllers: [FaceRecognitionController],
  providers: [FaceRecognitionService],
  exports: [FaceRecognitionService],
})
export class FaceRecognitionModule {}
