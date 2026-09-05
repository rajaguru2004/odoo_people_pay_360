import { Module } from '@nestjs/common';
import { LettersModule } from '../letters/letters.module';
import { DocumentVaultService } from './document-vault.service';
import { DocumentVaultController } from './document-vault.controller';
import { SecureFilesController } from './secure-files.controller';

/**
 * The small vault: one screen over the documents that already have an owner
 * elsewhere. It also owns the private-file door, so every downloadable kind is
 * registered in one place rather than each module opening its own.
 */
@Module({
  imports: [LettersModule],
  controllers: [DocumentVaultController, SecureFilesController],
  providers: [DocumentVaultService],
  exports: [DocumentVaultService],
})
export class DocumentVaultModule {}
