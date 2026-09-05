import { Injectable } from '@nestjs/common';
import { LettersService } from '../letters/letters.service';
import {
  SecureDownloadResolver,
  SecureFile,
} from '../storage/secure-download.registry';
import { DocumentVaultService } from './document-vault.service';

/** GET /secure-files/letter/:id */
@Injectable()
export class LetterDownloadResolver implements SecureDownloadResolver {
  readonly kind = 'letter';
  constructor(private readonly letters: LettersService) {}

  resolve(id: string, user: any): Promise<SecureFile | null> {
    // Throws Forbidden for anyone but the owner or HR.
    return this.letters.fileFor(id, user) as Promise<SecureFile | null>;
  }
}

/** GET /secure-files/employee-document/:id */
@Injectable()
export class EmployeeDocumentDownloadResolver implements SecureDownloadResolver {
  readonly kind = 'employee-document';
  constructor(private readonly vault: DocumentVaultService) {}

  resolve(id: string, user: any): Promise<SecureFile | null> {
    return this.vault.fileFor(id, user) as Promise<SecureFile | null>;
  }
}
