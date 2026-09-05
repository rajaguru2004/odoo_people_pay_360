import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import { CalendarService, CalendarActor } from './calendar.service';
import { SchedulesHubService } from './schedules-hub.service';
import type { HubPeriod } from '../common/hub/hub-range.util';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { BulkCreateScheduleDto } from './dto/bulk-create-schedule.dto';
import {
  CalendarRangeQueryDto,
  CalendarStatsQueryDto,
  ConflictsQueryDto,
  MyCalendarQueryDto,
} from './dto/calendar-query.dto';

/**
 * `employeeId` is OPTIONAL: `User.employeeId` is nullable and an administrator
 * who is not a member of staff is the ordinary reason for it. Typing it as
 * required is what let it be passed straight into a Prisma filter, where
 * `undefined` is rejected and the caller got a 500 on a route their own role
 * grants them.
 */
type CurrentUserPayload = CalendarActor;

@ApiTags('Calendar')
@ApiBearerAuth('JWT-auth')
@Controller('calendar')
@UseGuards(JwtAuthGuard, RolesGuard)
// Every write below changes when somebody is expected at work. The same actions
// performed through the MCP shift tools were already audited
// (`mcp/tools/shifts.tools.ts` sets `auditResourceType: 'WorkSchedule'`), so
// until now a shift created by chat was on the record and one created in the UI
// was not.
@AuditResource('WorkSchedule')
export class CalendarController {
  constructor(
    private calendarService: CalendarService,
    private schedulesHubService: SchedulesHubService,
  ) {}

  @Get('my-calendar')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get my work calendar' })
  @ApiQuery({
    name: 'startDate',
    required: true,
    description: 'Start date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'endDate',
    required: true,
    description: 'End date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'employeeId',
    required: false,
    description: 'Employee ID (Admin/HR/Manager only to view other employees)',
  })
  async getMyCalendar(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: MyCalendarQueryDto,
  ) {
    const { startDate, endDate, employeeId } = query;
    // The override is resolved and AUTHORIZED in one place. Note it can only
    // ever narrow to an id the CALLER supplied — the token-derived default is
    // never passed through the guard, because guarding self-service is how
    // "my calendar" breaks for everyone the moment the branch picker moves.
    const targetEmployeeId = await this.calendarService.resolveCalendarTarget(
      user,
      employeeId,
    );
    return this.calendarService.getEmployeeCalendar(
      targetEmployeeId,
      startDate,
      endDate,
    );
  }

  @Get('overview')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get calendar overview for all employees' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  async getOverview(@Query() query: CalendarRangeQueryDto) {
    return this.calendarService.getOverviewCalendar(
      query.startDate,
      query.endDate,
    );
  }

  @Get('stats')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get calendar stats for a month' })
  @ApiQuery({ name: 'month', required: true, type: Number })
  @ApiQuery({ name: 'year', required: true, type: Number })
  async getStats(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: CalendarStatsQueryDto,
  ) {
    return this.calendarService.getCalendarStats(
      user.employeeId,
      query.month,
      query.year,
    );
  }

  // ==================== SCHEDULE MANAGEMENT ====================

  @Post('schedules')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Create work schedule (HR/Admin only)' })
  @ApiBody({ type: CreateScheduleDto })
  async createSchedule(@Body() dto: CreateScheduleDto) {
    return this.calendarService.createSchedule(dto);
  }

  @Get('schedules/:id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get schedule by ID' })
  async getSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.calendarService.getScheduleById(id, user);
  }

  @Put('schedules/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update work schedule (HR/Admin only)' })
  @ApiBody({ type: UpdateScheduleDto })
  async updateSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScheduleDto,
  ) {
    return this.calendarService.updateSchedule(id, dto);
  }

  @Delete('schedules/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete work schedule (HR/Admin only)' })
  async deleteSchedule(@Param('id', ParseUUIDPipe) id: string) {
    return this.calendarService.deleteSchedule(id);
  }

  @Post('schedules/bulk')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Bulk create work schedules (HR/Admin only)' })
  @ApiBody({ type: BulkCreateScheduleDto })
  async bulkCreateSchedules(@Body() dto: BulkCreateScheduleDto) {
    return this.calendarService.bulkCreateSchedules(dto);
  }

  @Get('hub-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Schedules module hub summary',
    description:
      'Everything the Schedules landing dashboard draws, in one request: the ' +
      "selected period's coverage totals and the window before it (for every " +
      'delta on the page), its trend buckets, the shift mix, the roster ' +
      'conflict breakdown, the hourly staffing curve, the department ranking ' +
      'and the action queue. Coverage divides by ACTIVE, non-admin headcount; ' +
      'a bucket expects nobody on a day the branch calendar is closed.',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['today', 'week', 'month', 'year'],
    example: 'week',
  })
  @ApiQuery({
    name: 'anchor',
    required: false,
    type: String,
    description:
      'Any date inside the period being viewed (YYYY-MM-DD). Defaults to today; ' +
      'page with the prevAnchor/nextAnchor the response returns.',
  })
  @ApiResponse({ status: 200, description: 'Schedules hub summary retrieved' })
  async getHubSummary(
    @CurrentUser() user: any,
    @Query('period') period?: HubPeriod,
    @Query('anchor') anchor?: string,
  ) {
    return this.schedulesHubService.getHubSummary(period || 'week', anchor, user);
  }

  @Get('coverage-stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Coverage and roster conflicts for a window',
    description:
      'Who has no shift, who is rostered on a holiday or a weekly off, and ' +
      'which day of the window is thinnest.',
  })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  async coverageStats(@Query('startDate') startDate: string, @Query('endDate') endDate: string) {
    return this.calendarService.coverageStats(startDate, endDate);
  }

  @Get('schedules/conflicts/check')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Check schedule conflicts' })
  @ApiQuery({ name: 'employeeId', required: true })
  @ApiQuery({
    name: 'startDate',
    required: true,
    description: 'Start date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'endDate',
    required: true,
    description: 'End date (YYYY-MM-DD)',
  })
  async checkConflicts(@Query() query: ConflictsQueryDto) {
    return this.calendarService.checkScheduleConflicts(
      query.employeeId,
      query.startDate,
      query.endDate,
    );
  }
}
