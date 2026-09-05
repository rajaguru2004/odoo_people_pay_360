import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CalendarService } from './calendar.service';
import {
  CalendarRangeDto,
  CalendarStatsDto,
  MyCalendarDto,
} from './dto/calendar-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

/**
 * The personal work calendar.
 *
 * Every route is a GET. Creating, editing and deleting a rostered shift lives
 * on `/work-schedules`, which owns the rows — one write path, and no second
 * door for a screen to reach.
 */
@ApiTags('Calendar')
@ApiBearerAuth('JWT-auth')
@Controller('calendar')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('my-calendar')
  @ApiOperation({
    summary: 'One employee’s calendar for a window',
    description:
      'Shifts, approved leave, approved overtime and the holidays their branch observes. ' +
      'Defaults to the caller; ADMIN, HR and managers may name somebody else.',
  })
  async myCalendar(
    @CurrentUser() user: Principal,
    @Query() query: MyCalendarDto,
  ) {
    const employeeId = await this.calendar.resolveCalendarTarget(
      user,
      query.employeeId,
    );
    return this.calendar.getEmployeeCalendar(
      employeeId,
      query.startDate,
      query.endDate,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'One month of one calendar, as four figures' })
  async stats(@CurrentUser() user: Principal, @Query() query: CalendarStatsDto) {
    const employeeId = await this.calendar.resolveCalendarTarget(
      user,
      query.employeeId,
    );
    return this.calendar.getCalendarStats(employeeId, query.month, query.year);
  }

  @Get('overview')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'The whole matrix for a window, in one request' })
  overview(@Query() query: CalendarRangeDto) {
    return this.calendar.getOverviewCalendar(query.startDate, query.endDate);
  }

  @Get('coverage-stats')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Coverage and roster conflicts for a window',
    description:
      'Who has no shift, who is rostered on a holiday or a weekly off, and which day is thinnest.',
  })
  coverage(@Query() query: CalendarRangeDto) {
    return this.calendar.coverageStats(query.startDate, query.endDate);
  }
}
