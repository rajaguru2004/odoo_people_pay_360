import { Module } from '@nestjs/common';
import { AttendancesModule } from '../attendances/attendances.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * The main dashboard: one aggregate, every role, role-shaped payload.
 *
 * Imports rather than reimplements the two services it needs.
 * `AttendancesModule` already exports `AttendanceCalendarService`, which owns
 * the branch calendar — two definitions of "working day" is how a dashboard and
 * an attendance report start disagreeing about the same morning.
 * `SystemSettingsModule` exports the settings reader, so the compliance panel
 * counts down by the SAME `visa_expiry_alert_days` the visa report uses.
 *
 * Nothing in `attendances/`, `payroll/`, `employees/`, `contracts/` or
 * `legal-documents/` is edited: this module reads from them and owns none of
 * them.
 */
@Module({
  imports: [AttendancesModule, SystemSettingsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
