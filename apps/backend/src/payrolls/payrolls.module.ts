import { Module } from '@nestjs/common';
import { PayrollsController } from './payrolls.controller';
import { PayrollsService } from './payrolls.service';
import { PrismaModule } from '../prisma/prisma.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { OvertimeModule } from '../overtime/overtime.module';
import { OvertimePolicyModule } from '../overtime-policy/overtime-policy.module';
import { SalaryComponentsModule } from '../salary-components/salary-components.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditModule } from '../audit/audit.module';
import { PayrollFeaturesService } from './payroll-features.service';
import { PayrollItemLinesService } from './payroll-item-lines.service';
import { DeductionCarryForwardModule } from './deduction-carry-forward.module';

@Module({
  imports: [
    // Deduction balances an earlier run could not take. Its own module rather
    // than a provider here: contracts and employees need the same service on
    // termination, and none of them should import the run engine to get it.
    DeductionCarryForwardModule,
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
  ],
  exports: [PayrollsService],
})
export class PayrollsModule {}
