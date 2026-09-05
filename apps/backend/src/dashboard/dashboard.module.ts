import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { DashboardAlertService } from './dashboard-alert.service';
import { DashboardAnalyticsService } from './dashboard-analytics.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TimezoneModule } from '../common/timezone/timezone.module';
import { PayrollAnalyticsModule } from '../payroll-analytics/payroll-analytics.module';

@Module({
  // The payroll block of the dashboard is the SAME aggregate the analytics page
  // reads, so it is imported rather than re-derived: two implementations of one
  // month's net is how the dashboard and the analytics page start disagreeing
  // about what August paid.
  imports: [PrismaModule, TimezoneModule, PayrollAnalyticsModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardAlertService, DashboardAnalyticsService],
  exports: [DashboardService, DashboardAlertService, DashboardAnalyticsService],
})
export class DashboardModule {}
