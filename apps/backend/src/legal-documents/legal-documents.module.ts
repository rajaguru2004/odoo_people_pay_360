import { Module } from '@nestjs/common';
import { LegalDocumentsService } from './legal-documents.service';
import { LegalDocumentsController } from './legal-documents.controller';
import { SystemSettingsModule } from '../system-settings/system-settings.module';

@Module({
  // The alert window is a configured setting, so the service needs the
  // settings module rather than a constant of its own.
  imports: [SystemSettingsModule],
  controllers: [LegalDocumentsController],
  providers: [LegalDocumentsService],
  exports: [LegalDocumentsService],
})
export class LegalDocumentsModule {}
