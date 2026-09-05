import { Module } from '@nestjs/common';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { PdfService } from './pdf.service';

@Module({
  imports: [SystemSettingsModule],
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
