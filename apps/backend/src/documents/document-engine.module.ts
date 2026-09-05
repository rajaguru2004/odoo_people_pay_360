import { Module } from '@nestjs/common';
import { PdfModule } from '../pdf/pdf.module';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { BrandAssetService } from './brand-asset.service';
import { CompanyIdentityService } from './company-identity.service';
import { DocumentRenderService } from './document-render.service';
import { LetterheadService } from './letterhead.service';

/**
 * The rendering core. PURE by construction: it imports infrastructure only,
 * and NO domain module.
 *
 * That constraint is the whole point. A domain that wants to render a document
 * imports this; the aggregator (DocumentsModule) is the single leaf that knows
 * about every domain. So the dependency arrow is always domain → engine, and a
 * cycle — payroll needing the engine while the engine needs payroll — cannot
 * be introduced by accident.
 */
@Module({
  imports: [PdfModule, PrismaModule, StorageModule, SystemSettingsModule, AuditModule],
  providers: [BrandAssetService, CompanyIdentityService, DocumentRenderService, LetterheadService],
  exports: [
    BrandAssetService,
    CompanyIdentityService,
    DocumentRenderService,
    LetterheadService,
    PdfModule,
  ],
})
export class DocumentEngineModule {}
