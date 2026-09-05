import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { PayrollsModule } from '../payrolls/payrolls.module';
import { PayslipDocumentResolver } from '../payrolls/payslip-document.resolver';
import { DOCUMENT_CONTEXT_RESOLVERS } from './document-context.registry';
import { DocumentEngineModule } from './document-engine.module';
import { DocumentGenerationController } from './document-generation.controller';
import { DocumentGenerationService } from './document-generation.service';
import { DocumentHealthController } from './document-health.controller';
import { DocumentTemplateController } from './document-template.controller';
import { DocumentTemplateService } from './document-template.service';
import { DocumentAssetDownloadResolver } from './document-asset-download.resolver';
import { GeneratedDocumentDownloadResolver } from './generated-document-download.resolver';
import { LetterheadController } from './letterhead.controller';

/**
 * The document engine's public surface, and the AGGREGATOR.
 *
 * It imports every domain that owns document data and collects their context
 * resolvers through ONE factory. That single-factory shape is not a style
 * choice: Nest has no `multi: true`, so multi-provider registration has to
 * happen in exactly one place — the same reason DocumentVaultModule collects
 * its download resolvers the same way.
 *
 * The rendering core (DocumentEngineModule) stays PURE and imports no domain
 * module, so the dependency direction is always domain → engine, never back,
 * and a cycle cannot be introduced by adding a document type.
 *
 * ADDING A DOCUMENT TYPE: implement DocumentContextResolver in the module that
 * owns the data, export it from that module, import the module here, and add
 * the resolver to both `providers` and the factory's `inject` array.
 *
 * Registered in BOTH src/app.module.ts and test/utils/test-app.module.ts — a
 * module absent from the second makes every route under it 404 in e2e, and the
 * failure reads as a routing bug rather than a missing import.
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    StorageModule,
    SystemSettingsModule,
    DocumentEngineModule,
    PayrollsModule,
  ],
  controllers: [
    DocumentHealthController,
    DocumentTemplateController,
    DocumentGenerationController,
    LetterheadController,
  ],
  providers: [
    DocumentTemplateService,
    DocumentGenerationService,
    GeneratedDocumentDownloadResolver,
    DocumentAssetDownloadResolver,
    PayslipDocumentResolver,
    {
      provide: DOCUMENT_CONTEXT_RESOLVERS,
      useFactory: (...resolvers: unknown[]) => resolvers,
      inject: [PayslipDocumentResolver],
    },
  ],
  exports: [
    DocumentTemplateService,
    DocumentGenerationService,
    GeneratedDocumentDownloadResolver,
    DocumentAssetDownloadResolver,
  ],
})
export class DocumentsModule {}
