import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ReimbursementsModule } from '../reimbursements/reimbursements.module';
import { AdvanceLoansModule } from '../advance-loans/advance-loans.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { TravelController } from './travel.controller';
import { TravelService } from './travel.service';

/**
 * Travel is an extension of reimbursements: it imports that module rather than
 * modelling its own expenses, and imports AdvanceLoansModule so a travel
 * advance is recovered by the ledger that already exists.
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    NotificationsModule,
    SystemSettingsModule,
    ApprovalsModule,
    ReimbursementsModule,
    AdvanceLoansModule,
    // Approved travel commits budget before the money is spent.
    BudgetsModule,
  ],
  controllers: [TravelController],
  providers: [TravelService],
  exports: [TravelService],
})
export class TravelModule {}
