import { Injectable } from '@nestjs/common';
import {
  SecureDownloadResolver,
  SecureFile,
} from '../storage/secure-download.registry';
import { TaskAttachmentsService } from './task-attachments.service';

/**
 * GET /secure-files/task-attachment/:id
 *
 * Finding R53: task attachments were the one file kind with no resolver at all.
 * They went through the PUBLIC storage door, so the unsigned `fileUrl` was the
 * whole credential — a member's `severance-schedule-*.pdf` was readable by
 * anyone who had the link, member of the project or not.
 */
@Injectable()
export class TaskAttachmentDownloadResolver implements SecureDownloadResolver {
  readonly kind = 'task-attachment';
  constructor(private readonly attachments: TaskAttachmentsService) {}

  resolve(id: string, user: any): Promise<SecureFile | null> {
    // Throws Forbidden for anyone who is not in the attachment's project.
    return this.attachments.fileFor(id, user);
  }
}
