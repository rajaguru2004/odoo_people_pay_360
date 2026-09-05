import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { StorageModule } from '../storage/storage.module';
import { ProfileTemplatesModule } from '../profile-templates/profile-templates.module';
import { PdfModule } from '../pdf/pdf.module';
import { DocumentEngineModule } from '../documents/document-engine.module';
import {
  LettersController,
  LetterVerificationController,
} from './letters.controller';
import { LettersService } from './letters.service';

/**
 * Letters render through PdfService (headless Chromium — the only renderer that
 * shapes Arabic correctly) and store to the PRIVATE bucket, because a salary
 * certificate must not be readable by link alone.
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    NotificationsModule,
    SystemSettingsModule,
    StorageModule,
    PdfModule,
    // For BrandAssetService: the logo has to be inlined as a data: URI or it
    // cannot paint on a no-network render page. Domain → engine, never back.
    DocumentEngineModule,
    ProfileTemplatesModule,
  ],
  controllers: [LettersController, LetterVerificationController],
  providers: [LettersService],
  exports: [LettersService],
})
export class LettersModule {}
