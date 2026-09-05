import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TravelModule } from '../travel/travel.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { FinanceHubController } from './finance-hub.controller';
import { FinanceHubService } from './finance-hub.service';

/**
 * The Finance hub reads across travel and budgets, so it belongs to neither —
 * the same reason `OrganizationHubModule` exists rather than a method on
 * `DepartmentsService`.
 *
 * It imports those modules to CALL their services. Nothing here re-queries a
 * table one of them already answers for, so there is no second definition of
 * "over budget" to drift.
 */
@Module({
  imports: [PrismaModule, TravelModule, BudgetsModule],
  controllers: [FinanceHubController],
  providers: [FinanceHubService],
  exports: [FinanceHubService],
})
export class FinanceModule {}
