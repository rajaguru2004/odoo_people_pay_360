import { Injectable } from '@nestjs/common';
import { SecureDownloadResolver, SecureFile } from '../storage/secure-download.registry';
import { LetterheadService } from './letterhead.service';

/**
 * GET /secure-files/document-asset/:id
 *
 * Letterheads live in the PRIVATE bucket, so even the admin screen that shows
 * a preview of one has to fetch it through the authenticated door. That is the
 * point: a public letterhead URL is a forgery kit.
 */
@Injectable()
export class DocumentAssetDownloadResolver implements SecureDownloadResolver {
  readonly kind = 'document-asset';

  constructor(private readonly letterheads: LetterheadService) {}

  async resolve(id: string): Promise<SecureFile | null> {
    const file = await this.letterheads.fileFor(id);
    return { ref: file.privateRef, fileName: file.fileName };
  }
}
