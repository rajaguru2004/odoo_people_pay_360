import { GarnishmentsModule } from '../garnishments/garnishments.module';
import { GratuityModule } from '../gratuity/gratuity.module';
import { LeaveEncashmentModule } from '../leave-encashment/leave-encashment.module';
import { Module } from '@nestjs/common';
import { BudgetsModule } from '../budgets/budgets.module';
import { PayrollsController } from './payrolls.controller';
import { PayrollsService } from './payrolls.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { OvertimeModule } from '../overtime/overtime.module';
import { OvertimePolicyModule } from '../overtime-policy/overtime-policy.module';
import { SalaryComponentsModule } from '../salary-components/salary-components.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdvanceLoansModule } from '../advance-loans/advance-loans.module';
import { AuditModule } from '../audit/audit.module';
import { PayrollFeaturesService } from './payroll-features.service';
import { PayrollItemLinesService } from './payroll-item-lines.service';
import { PayrollValidationService } from './payroll-validation.service';
import { PayrollHubService } from './payroll-hub.service';
import { PayrollCalendarModule } from '../payroll-calendar/payroll-calendar.module';
import { EmployeeRecoveriesModule } from '../employee-recoveries/employee-recoveries.module';
import { BankDetailsModule } from '../bank-details/bank-details.module';

@Module({
  imports: [
    // End-of-service provisions are written when a run locks and reversed when
    // it is unlocked or deleted. One-way: GratuityModule never imports this one.
    GratuityModule,
    // Approved encashment requests are paid by the next run.
    LeaveEncashmentModule,
    // The pre-run checklist validates against the calendar's window.
    PayrollCalendarModule,
    // Asset damage, training bonds and notice shortfalls, after the loan ladder.
    EmployeeRecoveriesModule,
    // The hub's payment-readiness check reuses BankingConfigService rather than
    // growing a second opinion about what a valid bank record is. One-way:
    // BankDetailsModule never imports this one.
    BankDetailsModule,
    // Locking a payroll realizes the budget commitments it pays out.
    BudgetsModule,
    // Loan recovery planning (candidate selection + the affordability/priority
    // allocator). One-way: AdvanceLoansModule never imports this one.
    AdvanceLoansModule,
    // Court orders are subtracted from the pool before loan recovery sees it.
    // One-way, like AdvanceLoansModule: GarnishmentsModule never imports this.
    GarnishmentsModule,
    PrismaModule,
    HolidaysModule,
    OvertimeModule,
    OvertimePolicyModule,
    SalaryComponentsModule,
    SystemSettingsModule,
    NotificationsModule,
    // Payroll writes its OWN audit entries with named verbs. The global
    // AuditInterceptor derives `action` from the HTTP verb, and every lifecycle
    // transition is a POST — so without these, submit, approve, reject, lock and
    // unlock were all recorded as `CREATE` and were indistinguishable.
    AuditModule,
  ],
  controllers: [PayrollsController],
  providers: [
    PayrollsService,
    // Which extensions are on. Resolved once per run, BEFORE any transaction
    // opens, so a switch that is off costs the run no statements at all.
    PayrollFeaturesService,
    // The itemised breakdown behind each payslip. Additive: the columns on
    // PayrollItem stay the authoritative money.
    PayrollItemLinesService,
    // "Is this run safe?", shared with create()'s own guards via pure rules.
    PayrollValidationService,
    // The module hub's one read-only aggregate. Kept out of PayrollsService,
    // which is already 3.6k lines and owns the write path.
    PayrollHubService,
  ],
  exports: [PayrollsService],
})
export class PayrollsModule {}
