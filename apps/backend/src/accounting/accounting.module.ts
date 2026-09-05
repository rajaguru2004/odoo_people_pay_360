import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { JournalPostingService } from './journal-posting.service';

/**
 * Posting loan money to a general ledger.
 *
 * One-way, like the other consumers of the loan ledger: this module reads
 * `LoanTransaction` and writes journals, and the loans module knows nothing
 * about it. A posting failure can therefore never roll back a repayment.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AccountingController],
  providers: [AccountingService, JournalPostingService],
  exports: [JournalPostingService],
})
export class AccountingModule {}
