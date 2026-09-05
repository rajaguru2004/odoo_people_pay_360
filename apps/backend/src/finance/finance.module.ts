import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ReimbursementsModule } from '../reimbursements/reimbursements.module';
import { TravelModule } from '../travel/travel.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { AdvanceLoansModule } from '../advance-loans/advance-loans.module';
import { FinanceHubController } from './finance-hub.controller';
import { FinanceHubService } from './finance-hub.service';

/**
 * The Finance hub reads across reimbursements, travel, the loan ledger and
 * budgets, so it belongs to none of them — the same reason
 * `OrganizationHubModule` exists rather than a method on `DepartmentsService`.
 *
 * It imports those four modules to CALL their services. Nothing here re-queries
 * a table one of them already answers for, so there is no second definition of
 * "outstanding" or "over budget" to drift.
 */
@Module({
  imports: [
    PrismaModule,
    ReimbursementsModule,
    TravelModule,
    BudgetsModule,
    AdvanceLoansModule,
  ],
  controllers: [FinanceHubController],
  providers: [FinanceHubService],
  exports: [FinanceHubService],
})
export class FinanceModule {}
