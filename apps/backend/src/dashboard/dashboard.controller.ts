import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { DashboardAlertService } from './dashboard-alert.service';
import { DashboardAnalyticsService } from './dashboard-analytics.service';
import { AnalyticsOverviewQueryDto } from './dto/analytics-overview-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Dashboard')
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly alertService: DashboardAlertService,
    private readonly analyticsService: DashboardAnalyticsService,
  ) {}

  @Get('overview')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get dashboard overview',
    description:
      'Get overall statistics including employees, attendance, leave requests, contracts, and payroll',
  })
  @ApiResponse({
    status: 200,
    description: 'Overview data retrieved successfully',
  })
  @ApiQuery({ name: 'date', required: false, type: String, example: '2026-07-06' })
  getOverview(
    @CurrentUser() user: any,
    @Query('date') date?: string,
  ) {
    return this.dashboardService.getOverview(user, date);
  }

  /**
   * The analytics dashboard's single aggregate.
   *
   * Deliberately a second route rather than a shape change to `overview` above:
   * that one is read by the existing widgets and answers a different question.
   * Every role may call this — the SERVICE decides which blocks come back, and
   * says so in `sections`, because a block a caller may not see is absent
   * rather than zeroed.
   */
  @Get('analytics-overview')
  @Roles('ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get the analytics dashboard aggregate',
    description:
      'One role-aware payload for the whole dashboard: workforce, attendance, ' +
      'payroll, approvals, compliance and the self block. Sections the caller ' +
      'is not entitled to are omitted, and `sections` lists what arrived.',
  })
  @ApiResponse({ status: 200, description: 'Overview retrieved successfully' })
  getAnalyticsOverview(
    @CurrentUser() user: any,
    @Query() query: AnalyticsOverviewQueryDto,
  ) {
    return this.analyticsService.overview(user, query.months ?? 6);
  }

  @Get('employee-stats')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get employee statistics',
    description: 'Get employee distribution by department, status, and gender',
  })
  @ApiResponse({ status: 200, description: 'Employee statistics retrieved' })
  getEmployeeStats(@CurrentUser() user: any) {
    return this.dashboardService.getEmployeeStats(user);
  }

  @Get('attendance-summary')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get attendance summary',
    description: 'Get attendance summary with daily trend for a specific month',
  })
  @ApiQuery({ name: 'month', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'year', required: false, type: Number, example: 2026 })
  @ApiResponse({ status: 200, description: 'Attendance summary retrieved' })
  getAttendanceSummary(
    @CurrentUser() user: any,
    @Query('month') month?: number,
    @Query('year') year?: number,
  ) {
    return this.dashboardService.getAttendanceSummary(
      user,
      month ? +month : undefined,
      year ? +year : undefined,
    );
  }

  @Get('payroll-summary')
  // Company-wide payroll totals, month by month. EMPLOYEE was admitted here,
  // which handed every member of staff the whole salary bill — their own pay is
  // `/payrolls/my-ytd-summary`, which is self-scoped.
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get payroll summary',
    description: 'Get payroll summary by month for a specific year',
  })
  @ApiQuery({ name: 'year', required: false, type: Number, example: 2026 })
  @ApiResponse({ status: 200, description: 'Payroll summary retrieved' })
  getPayrollSummary(@Query('year') year?: number) {
    return this.dashboardService.getPayrollSummary(year ? +year : undefined);
  }

  @Get('alerts')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get system alerts',
    description:
      'Get alerts for expiring contracts, pending leave requests, and frequent late employees',
  })
  @ApiResponse({ status: 200, description: 'Alerts retrieved' })
  getAlerts(@CurrentUser() user: any) {
    return this.dashboardService.getAlerts(user);
  }

  @Get('activities')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get recent activities',
    description:
      'Get recent system activities including employee updates, leave requests, and attendance',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiResponse({ status: 200, description: 'Recent activities retrieved' })
  getRecentActivities(
    @CurrentUser() user: any,
    @Query('limit') limit?: number,
  ) {
    return this.dashboardService.getRecentActivities(user, limit ? +limit : 10);
  }

  @Get('turnover-stats')
  @Roles('ADMIN', 'HR_MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get turnover statistics',
    description:
      'Get employee turnover statistics including monthly data, trend, and department breakdown',
  })
  @ApiQuery({
    name: 'months',
    required: false,
    type: Number,
    example: 6,
    description: 'Number of months for trend data',
  })
  @ApiResponse({ status: 200, description: 'Turnover statistics retrieved' })
  getTurnoverStats(@Query('months') months?: number) {
    return this.dashboardService.getTurnoverStats(months ? +months : 6);
  }

  @Get('today-snapshot')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get today snapshot',
    description:
      "Get quick snapshot of today's key metrics: working now, late today, pending approvals, expiring contracts",
  })
  @ApiResponse({ status: 200, description: 'Today snapshot retrieved' })
  @ApiQuery({ name: 'date', required: false, type: String, example: '2026-07-06' })
  getTodaySnapshot(
    @CurrentUser() user: any,
    @Query('date') date?: string,
  ) {
    return this.dashboardService.getTodaySnapshot(user, date);
  }

  @Get('contract-alerts')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get contract expiration alerts',
    description:
      'Get contracts expiring within 60 days with severity levels (HIGH/MEDIUM/LOW/INFO)',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    example: 60,
    description: 'Number of days to look ahead',
  })
  @ApiResponse({
    status: 200,
    description: 'Contract alerts retrieved successfully',
  })
  async getContractAlerts(
    @Query('days') days?: number,
    @CurrentUser() user?: any,
  ) {
    const daysNum = days ? Number(days) : 60;
    return {
      success: true,
      data: await this.alertService.getDashboardAlerts(user?.id),
      meta: { days: daysNum },
    };
  }

  @Get('contract-alerts/expiring')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get expiring contracts list',
    description:
      'Get detailed list of contracts expiring within specified days',
  })
  @ApiQuery({ name: 'days', required: false, type: Number, example: 60 })
  @ApiResponse({ status: 200, description: 'Expiring contracts retrieved' })
  async getExpiringContracts(@Query('days') days?: number) {
    const daysNum = days ? Number(days) : 60;
    const contracts = await this.alertService.getExpiringContracts(daysNum);
    return {
      success: true,
      data: contracts,
      meta: { total: contracts.length, days: daysNum },
    };
  }
}
