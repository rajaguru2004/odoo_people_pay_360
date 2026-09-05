import { Injectable } from '@nestjs/common';
import {
  SecureDownloadResolver,
  SecureFile,
} from '../storage/secure-download.registry';
import { WpsFilesService } from './wps-files.service';

/**
 * Serves a wage file over the generic authenticated download route:
 *   GET /secure-files/wps-file/:id
 *
 * The route handles auth, auditing (SECURE_FILE_DOWNLOADED), byte streaming,
 * Cache-Control: private, no-store and RFC 6266 filenames. All this has to do is
 * locate the file and decide access — and it must THROW when access is refused,
 * because returning null reads as "not found" and would leak existence.
 *
 * The actual role + branch check lives in WpsFilesService.fileFor, next to the
 * rest of the file's authorization.
 */
@Injectable()
export class WpsFileDownloadResolver implements SecureDownloadResolver {
  readonly kind = 'wps-file';

  constructor(private readonly files: WpsFilesService) {}

  resolve(id: string, user: any): Promise<SecureFile | null> {
    return this.files.fileFor(id, user);
  }
}
