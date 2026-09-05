import { Injectable } from '@nestjs/common';
import {
  SecureDownloadResolver,
  SecureFile,
} from '../storage/secure-download.registry';
import { DocumentGenerationService } from './document-generation.service';

/**
 * GET /secure-files/generated-document/:id
 *
 * Every generated PDF reaches the user through the EXISTING authenticated
 * door rather than a new one, which is what buys the audit row, the
 * `Cache-Control: private, no-store`, and the RFC 6266/5987 filename encoding
 * that already handles the em dashes and Arabic these documents produce.
 */
@Injectable()
export class GeneratedDocumentDownloadResolver implements SecureDownloadResolver {
  readonly kind = 'generated-document';

  constructor(private readonly generation: DocumentGenerationService) {}

  async resolve(id: string, user: any): Promise<SecureFile | null> {
    // Throws NotFound rather than Forbidden when the caller may not have it:
    // a 403 would confirm the document exists, which for a warning letter or a
    // settlement is itself the disclosure.
    const file = await this.generation.fileFor(id, user);
    return { ref: file.privateRef, fileName: file.fileName };
  }
}
