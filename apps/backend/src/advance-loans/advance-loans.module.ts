import { Module } from '@nestjs/common';
import { AdvanceLoansController } from './advance-loans.controller';
import { AdvanceLoansService } from './advance-loans.service';
import { AdvanceLoanAttachmentsController } from './advance-loan-attachments.controller';
import { AdvanceLoanAttachmentsService } from './advance-loan-attachments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StorageModule } from '../storage/storage.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { LoanPolicyService } from './loan-policy.service';
import { LoanRecoveryService } from './loan-recovery.service';
import { LoanScheduleService } from './loan-schedule.service';
import { LoanAccessService } from './loan-access.service';
import { LoanLifecycleService } from './loan-lifecycle.service';
import { LoanLifecycleController } from './loan-lifecycle.controller';
import { LoanEligibilityService } from './loan-eligibility.service';
import { LoanReportsService } from './loan-reports.service';
import { LoanReportsController } from './loan-reports.controller';
import { LoanImportService } from './loan-import.service';
import { LoanImportController } from './loan-import.controller';
import { LoanSettlementService } from './loan-settlement.service';
import { LoanSettlementController } from './loan-settlement.controller';
import { LoanTypesService } from './loan-types.service';
import { LoanPoliciesService } from './loan-policies.service';
import { LoanNotificationService } from './loan-notification.service';
import { LoanOverdueService } from './loan-overdue.service';
import { LoanPoliciesController } from './loan-policies.controller';
import { LoanTypesController } from './loan-types.controller';
import { AuditModule } from '../audit/audit.module';
import { TimezoneModule } from '../common/timezone/timezone.module';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    SystemSettingsModule,
    NotificationsModule,
    StorageModule,
    // Daily-wage staff are gated against rate x the month's working days.
    HolidaysModule,
    // Multi-level approval chains (falls back to the legacy approver when no
    // ADVANCE_LOAN workflow is active or the master switch is off).
    ApprovalsModule,
    // Every balance-moving lifecycle operation writes an audit row.
    AuditModule,
    // The overdue sweep runs at company-local time, not the server's.
    TimezoneModule,
  ],
  // LoanLifecycleController is listed FIRST so its literal path segments
  // (/schedule, /prepay, ...) are not swallowed by AdvanceLoansController's
  // `GET :id` route.
  controllers: [
    LoanTypesController,
    LoanPoliciesController,
    LoanImportController,
    LoanReportsController,
    LoanSettlementController,
    LoanLifecycleController,
    AdvanceLoansController,
    AdvanceLoanAttachmentsController,
  ],
  providers: [
    AdvanceLoansService,
    AdvanceLoanAttachmentsService,
    LoanPolicyService,
    LoanTypesService,
    LoanPoliciesService,
    LoanNotificationService,
    LoanOverdueService,
    LoanRecoveryService,
    LoanScheduleService,
    LoanAccessService,
    LoanLifecycleService,
    LoanSettlementService,
    LoanEligibilityService,
    LoanReportsService,
    LoanImportService,
  ],
  // PayrollsModule consumes the recovery planner. The dependency is one-way —
  // this module never imports PayrollsModule — so there is no cycle.
  exports: [
    AdvanceLoansService,
    AdvanceLoanAttachmentsService,
    LoanPolicyService,
    LoanTypesService,
    LoanNotificationService,
    LoanOverdueService,
    LoanRecoveryService,
    LoanScheduleService,
    LoanAccessService,
    // Consumed by the MCP loan tools.
    LoanLifecycleService,
    LoanSettlementService,
    LoanEligibilityService,
    LoanReportsService,
  ],
})
export class AdvanceLoansModule {}
