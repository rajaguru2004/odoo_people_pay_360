import { Module } from '@nestjs/common';
import { TaskAttachmentsController } from './task-attachments.controller';
import { TaskAttachmentsService } from './task-attachments.service';
import { TaskAttachmentDownloadResolver } from './task-attachment-download.resolver';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { ProjectRbacModule } from '../projects/rbac/project-rbac.module';

@Module({
  imports: [PrismaModule, StorageModule, ProjectRbacModule],
  controllers: [TaskAttachmentsController],
  providers: [TaskAttachmentsService, TaskAttachmentDownloadResolver],
  // The resolver is exported so DocumentVaultModule — which declares
  // SecureDownloadController and owns the one SECURE_DOWNLOAD_RESOLVERS
  // factory — can inject it. Nest has no `multi: true`, so every downloadable
  // kind has to be listed there.
  exports: [TaskAttachmentsService, TaskAttachmentDownloadResolver],
})
export class TaskAttachmentsModule {}
