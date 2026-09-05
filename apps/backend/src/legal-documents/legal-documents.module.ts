import { Module } from '@nestjs/common';
import { LegalDocumentsController } from './legal-documents.controller';
import { LegalDocumentsService } from './legal-documents.service';
import { LegalDocumentAttachmentsService } from './legal-document-attachments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { TimezoneModule } from '../common/timezone/timezone.module';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    MailModule,
    NotificationsModule,
    SystemSettingsModule,
    TimezoneModule,
  ],
  controllers: [LegalDocumentsController],
  providers: [LegalDocumentsService, LegalDocumentAttachmentsService],
  exports: [LegalDocumentsService, LegalDocumentAttachmentsService],
})
export class LegalDocumentsModule {}
