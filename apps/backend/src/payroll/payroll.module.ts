import { Module } from '@nestjs/common';
import { AttendancesModule } from '../attendances/attendances.module';
import { PayrollHubController } from './payroll-hub.controller';
import { PayrollHubService } from './payroll-hub.service';
import { PayrollDashboardController } from './payroll-dashboard.controller';
import { PayrollDashboardService } from './payroll-dashboard.service';
import { PayrollReportsController } from './payroll-reports.controller';
import { PayrollReportsService } from './payroll-reports.service';
import { PayrollRunsController } from './payroll-runs.controller';
import { PayrollRunsService } from './payroll-runs.service';
import { PayrollExportService } from './payroll-export.service';
import { PayslipsController } from './payslips.controller';
import { PayslipsService } from './payslips.service';

/**
 * Payroll: runs, payslips, the hub and the reports.
 *
 * `AttendancesModule` is imported for `AttendanceCalendarService`, which it
 * already exports. Payroll reads the branch calendar through that one service
 * rather than re-deriving working days, because two definitions of "working
 * day" is how a payslip and an attendance report start disagreeing about the
 * same month. Nothing in `attendances/` is edited.
 */
@Module({
  imports: [AttendancesModule],
  // Order matters. Routes are matched in registration order, and
  // `/payroll/hub-summary`, `/payroll/dashboard` and `/payroll/reports/*` are
  // literal paths that a `:id` sibling on another controller would otherwise
  // swallow.
  controllers: [
    PayrollHubController,
    PayrollDashboardController,
    PayrollReportsController,
    PayrollRunsController,
    PayslipsController,
  ],
  providers: [
    PayrollHubService,
    PayrollDashboardService,
    PayrollReportsService,
    PayrollRunsService,
    PayrollExportService,
    PayslipsService,
  ],
  exports: [PayrollRunsService, PayslipsService],
})
export class PayrollModule {}
