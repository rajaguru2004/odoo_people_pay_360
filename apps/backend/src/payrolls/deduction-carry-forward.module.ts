import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DeductionCarryForwardService } from './deduction-carry-forward.service';

/**
 * Its own module rather than an export of `PayrollsModule`.
 *
 * Contracts, employees and payroll all need the carry-forward ledger, and
 * importing the whole payroll module for one service would drag the run engine
 * into two modules that have no business with it — and would make a cycle the
 * moment payroll needs anything back from them.
 */
@Module({
  imports: [PrismaModule],
  providers: [DeductionCarryForwardService],
  exports: [DeductionCarryForwardService],
})
export class DeductionCarryForwardModule {}
