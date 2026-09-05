import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { SchedulesService, type ScheduleActor } from './schedules.service';
import { SchedulesHubService } from './schedules-hub.service';
import { ScheduleHubSummaryDto } from './dto/hub-summary.dto';
import {
  MyScheduleDto,
  ScheduleConflictsDto,
  ScheduleOverviewDto,
  ScheduleRangeDto,
  ScheduleStatsDto,
} from './dto/schedule-range.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * Reading the roster.
 *
 * Every route here is a GET. Creating, editing and deleting a rostered shift
 * lives on `/work-schedules`, which owns the rows — one write path, one place
 * the roster rules are enforced, and no second door for a screen to reach.
 */
@ApiTags('Schedules')
@ApiBearerAuth('JWT-auth')
@Controller('schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly hub: SchedulesHubService,
  ) {}

  @Get('hub-summary')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({
    summary: 'Schedules dashboard, in one request',
    description:
      "Everything the Schedules landing page draws: the selected period's " +
      'coverage totals and the window before it (for every delta on the page), ' +
      'its trend buckets, the shift mix, the roster conflict breakdown, the ' +
      'hourly staffing curve, the department ranking and the action queue. ' +
      "Coverage divides by ACTIVE headcount in the caller's scope; a bucket " +
      'expects nobody on a day the branch calendar is closed.',
  })
  hubSummary(
    @CurrentUser() user: ScheduleActor,
    @Query() query: ScheduleHubSummaryDto,
  ) {
    return this.hub.getSummary(query.period ?? 'week', query.anchor, user);
  }

  @Get('overview')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({
    summary: 'The working-schedule grid for a window',
    description:
      'Every employee in scope, every rostered shift, the leave days already ' +
      "recorded against them, and each branch's own holidays and weekly offs — " +
      'enough to draw the whole matrix without a second request per row.',
  })
  overview(
    @CurrentUser() user: ScheduleActor,
    @Query() query: ScheduleOverviewDto,
  ) {
    return this.schedules.getOverview(
      query.startDate,
      query.endDate,
      { branchId: query.branchId, departmentId: query.departmentId },
      user,
    );
  }

  @Get('my')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'One employee calendar',
    description:
      'Defaults to the caller. Admin, HR, payroll and managers may name ' +
      'somebody else; a manager only within the departments they head.',
  })
  async myCalendar(
    @CurrentUser() user: ScheduleActor,
    @Query() query: MyScheduleDto,
  ) {
    const employeeId = await this.schedules.resolveCalendarTarget(
      user,
      query.employeeId,
    );
    return this.schedules.getEmployeeCalendar(
      employeeId,
      query.startDate,
      query.endDate,
    );
  }

  @Get('stats')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: "One month of one employee's roster, as figures" })
  async stats(
    @CurrentUser() user: ScheduleActor,
    @Query() query: ScheduleStatsDto,
  ) {
    const employeeId = await this.schedules.resolveCalendarTarget(
      user,
      query.employeeId,
    );
    return this.schedules.getScheduleStats(employeeId, query.month, query.year);
  }

  @Get('coverage')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({
    summary: 'Coverage and roster conflicts for a window',
    description:
      'Who has no shift, who is rostered on a holiday or a weekly off, whose ' +
      'shifts overlap, and which day of the window is thinnest.',
  })
  coverage(
    @CurrentUser() user: ScheduleActor,
    @Query() query: ScheduleRangeDto,
  ) {
    return this.schedules.coverageStats(query.startDate, query.endDate, user);
  }

  @Get('conflicts')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({
    summary: 'The colliding shifts for one employee in a window',
    description:
      'Half-open intervals — an end equal to the next start is a split day, ' +
      'not an overlap — and a FLEXIBLE shift collides with anything on its date.',
  })
  async conflicts(
    @CurrentUser() user: ScheduleActor,
    @Query() query: ScheduleConflictsDto,
  ) {
    // Reuses the "my calendar" authorization: reading somebody's conflicts is
    // reading their roster, and a manager must not learn about a collision in a
    // department they do not head.
    const employeeId = await this.schedules.resolveCalendarTarget(
      user,
      query.employeeId,
    );
    return this.schedules.checkScheduleConflicts(
      employeeId as string,
      query.startDate,
      query.endDate,
    );
  }
}
