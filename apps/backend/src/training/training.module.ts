import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ReimbursementsModule } from '../reimbursements/reimbursements.module';
import { CopilotSettingsModule } from '../copilot-settings/copilot-settings.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { OpenRouterToolsClient } from '../copilot/llm/openrouter-tools.client';
import { TrainingController } from './training.controller';
import { TrainingService } from './training.service';
import { TrainingNeedsService } from './training-needs.service';

/**
 * Like travel, training is an extension of reimbursements — it imports that
 * module instead of modelling its own expenses.
 *
 * OpenRouterToolsClient is provided directly (the same way AppraisalModule does)
 * so training-needs matching can reuse the configured LLM without depending on
 * the whole copilot module.
 */
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    NotificationsModule,
    SystemSettingsModule,
    ApprovalsModule,
    ReimbursementsModule,
    CopilotSettingsModule,
    // Approved training commits budget before the money is spent.
    BudgetsModule,
  ],
  controllers: [TrainingController],
  providers: [TrainingService, TrainingNeedsService, OpenRouterToolsClient],
  exports: [TrainingService, TrainingNeedsService],
})
export class TrainingModule {}
