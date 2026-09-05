import { Module } from '@nestjs/common';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { LettersService } from './letters.service';
import {
  LettersController,
  LetterVerificationController,
} from './letters.controller';

/**
 * Issued letters are written to the private store and filed in the employee's
 * vault. Nothing here serves a file: downloads go through the vault's
 * authenticated route, which is the only door that checks the caller.
 */
@Module({
  imports: [SystemSettingsModule],
  controllers: [LettersController, LetterVerificationController],
  providers: [LettersService],
  exports: [LettersService],
})
export class LettersModule {}
