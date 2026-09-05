import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { LettersModule } from '../letters/letters.module';
import { WpsModule } from '../wps/wps.module';
import { WpsFileDownloadResolver } from '../wps/wps-download.resolver';
import { TaskAttachmentsModule } from '../task-attachments/task-attachments.module';
import { TaskAttachmentDownloadResolver } from '../task-attachments/task-attachment-download.resolver';
import { SecureDownloadController } from '../storage/secure-download.controller';
import { DocumentsModule } from '../documents/documents.module';
import { DocumentAssetDownloadResolver } from '../documents/document-asset-download.resolver';
import { GeneratedDocumentDownloadResolver } from '../documents/generated-document-download.resolver';
import { SECURE_DOWNLOAD_RESOLVERS } from '../storage/secure-download.registry';
import { DocumentVaultController } from './document-vault.controller';
import { DocumentVaultService } from './document-vault.service';
import {
  EmployeeDocumentDownloadResolver,
  LetterDownloadResolver,
} from './secure-download.resolvers';

/**
 * Aggregates the four existing document sources into one screen. No new table —
 * a vault table would be a fifth copy of data that already has an owner.
 *
 * Also owns the secure-download resolver array, so StorageModule stays free of any
 * knowledge about letters, employee documents or wage files. Nest has no
 * `multi: true`, and SecureDownloadController is declared here, so every
 * downloadable kind must be injected into the one factory below — a second module
 * providing the same token would not merge.
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    StorageModule,
    LettersModule,
    WpsModule,
    // Task attachments became a downloadable kind with finding R53: they used
    // to go through the PUBLIC door, where the URL was the whole credential.
    TaskAttachmentsModule,
    // Every PDF the document engine produces is downloaded through this same
    // door, so it gets the audit row and the no-store headers for free.
    DocumentsModule,
  ],
  controllers: [DocumentVaultController, SecureDownloadController],
  providers: [
    DocumentVaultService,
    LetterDownloadResolver,
    EmployeeDocumentDownloadResolver,
    {
      // Registering a new downloadable kind: implement SecureDownloadResolver,
      // export it from its own module, and add it to `inject` here.
      provide: SECURE_DOWNLOAD_RESOLVERS,
      useFactory: (...resolvers: unknown[]) => resolvers,
      inject: [
        LetterDownloadResolver,
        EmployeeDocumentDownloadResolver,
        WpsFileDownloadResolver,
        TaskAttachmentDownloadResolver,
        GeneratedDocumentDownloadResolver,
        DocumentAssetDownloadResolver,
      ],
    },
  ],
  exports: [
    DocumentVaultService,
    LetterDownloadResolver,
    EmployeeDocumentDownloadResolver,
  ],
})
export class DocumentVaultModule {}
