import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { BudgetsController } from './budgets.controller';
import { BudgetsService } from './budgets.service';
import { BudgetCommitmentService } from './budget-commitment.service';
import { BudgetActualsService } from './budget-actuals.service';

/**
 * `BudgetCommitmentService` is exported because the commit/release/realize call
 * sites live in other modules — travel and training approval, and payroll lock.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [BudgetsController],
  providers: [BudgetsService, BudgetCommitmentService, BudgetActualsService],
  exports: [BudgetCommitmentService, BudgetActualsService, BudgetsService],
})
export class BudgetsModule {}
