import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { AnalyticsService } from './analytics.service';

/**
 * HTTP surface for the per-employee aggregates.
 *
 * These have existed and been tested since the appraisal agent shipped, but
 * only the MCP tool layer could reach them — a screen that wanted "this
 * person's last quarter" had to re-derive it from raw lists. This exposes the
 * same methods over HTTP without changing them.
 *
 * Two rules, both enforced here rather than in the service (which has no
 * concept of a caller):
 *
 *  - An EMPLOYEE or MANAGER may read only their own record. `employeeId` is a
 *    path parameter, so without this check the route is an "any employee's
 *    conduct record" endpoint for anyone with a login.
 *  - The period is required and bounded. An unbounded range over attendance
 *    and worklogs is a table scan per request.
 */
@ApiTags('Analytics — per employee')
@ApiBearerAuth('JWT-auth')
@Controller('analytics/employees')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Analytics')
export class AnalyticsController {
  /** A year. Long enough for an appraisal window, short enough to bound the scan. */
  private static readonly MAX_RANGE_DAYS = 366;

  constructor(private readonly analytics: AnalyticsService) {}

  private period(from?: string, to?: string): { from: Date; to: Date } {
    const now = new Date();
    const parsedTo = to ? new Date(to) : now;
    const parsedFrom = from
      ? new Date(from)
      : new Date(parsedTo.getTime() - 90 * 24 * 60 * 60 * 1000);

    if (Number.isNaN(parsedFrom.getTime()) || Number.isNaN(parsedTo.getTime())) {
      throw new ForbiddenException('from and to must be valid dates');
    }
    if (parsedFrom > parsedTo) {
      throw new ForbiddenException('from must not be after to');
    }
    const days = (parsedTo.getTime() - parsedFrom.getTime()) / 86_400_000;
    if (days > AnalyticsController.MAX_RANGE_DAYS) {
      throw new ForbiddenException(
        `range must be ${AnalyticsController.MAX_RANGE_DAYS} days or fewer`,
      );
    }
    return { from: parsedFrom, to: parsedTo };
  }

  /** Self-only for the unprivileged roles; the id is caller-supplied. */
  private assertMayRead(user: any, employeeId: string): void {
    if (user?.role === 'ADMIN' || user?.role === 'HR_MANAGER') return;
    if (user?.employeeId && user.employeeId === employeeId) return;
    throw new ForbiddenException('You may only read your own analytics');
  }

  @Get(':employeeId/summary')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Everything the appraisal agent sees about one employee in a period',
    description:
      'Attendance, leave, overtime, tasks, projects, worklogs, timesheets, ' +
      'and conduct, for one date range. Defaults to the last 90 days.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date; defaults to 90 days ago' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date; defaults to today' })
  async summary(
    @CurrentUser() user: any,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    this.assertMayRead(user, employeeId);
    const period = { employeeId, ...this.period(from, to) };

    const [
      attendance,
      leave,
      overtime,
      tasks,
      projects,
      worklogs,
      timesheets,
      conduct,
      teams,
    ] = await Promise.all([
      this.analytics.attendanceSummary(period),
      this.analytics.leaveSummary(period),
      this.analytics.overtimeSummary(period),
      this.analytics.taskStats(period),
      this.analytics.projectContribution(period),
      this.analytics.worklogSummary(period),
      this.analytics.timesheetSummary(period),
      this.analytics.conductRecords(period),
      this.analytics.teamMembership(employeeId),
    ]);

    return {
      success: true,
      data: {
        employeeId,
        period: { from: period.from, to: period.to },
        attendance,
        leave,
        overtime,
        tasks,
        projects,
        worklogs,
        timesheets,
        conduct,
        teams,
      },
    };
  }

  @Get(':employeeId/attendance')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Attendance aggregate for one employee over a period' })
  async attendance(
    @CurrentUser() user: any,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    this.assertMayRead(user, employeeId);
    const data = await this.analytics.attendanceSummary({ employeeId, ...this.period(from, to) });
    return { success: true, data };
  }

  @Get(':employeeId/conduct')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Rewards and disciplinary records for one employee over a period' })
  async conduct(
    @CurrentUser() user: any,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    this.assertMayRead(user, employeeId);
    const data = await this.analytics.conductRecords({ employeeId, ...this.period(from, to) });
    return { success: true, data };
  }
}
