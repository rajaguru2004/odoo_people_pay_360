import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { TravelController } from './travel.controller';
import { TravelService } from './travel.service';

/**
 * Travel requests and their approval flow. Travel models its own trip costs;
 * nothing here creates a claim or an advance in another ledger.
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    NotificationsModule,
    SystemSettingsModule,
    ApprovalsModule,
    // Approved travel commits budget before the money is spent.
    BudgetsModule,
  ],
  controllers: [TravelController],
  providers: [TravelService],
  exports: [TravelService],
})
export class TravelModule {}
