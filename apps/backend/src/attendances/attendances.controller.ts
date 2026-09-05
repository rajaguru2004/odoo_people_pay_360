import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AttendancesService } from './attendances.service';
import { AttendanceHubService } from './attendance-hub.service';
import { ListAttendancesDto } from './dto/list-attendances.dto';
import { CheckInDto } from './dto/check-in.dto';
import { CheckOutDto } from './dto/check-out.dto';
import { CreateAttendanceDto } from './dto/create-attendance.dto';
import { UpdateAttendanceDto } from './dto/update-attendance.dto';
import { BulkAttendanceDto } from './dto/bulk-attendance.dto';
import { AttendanceSummaryDto } from './dto/attendance-summary.dto';
import { EmployeeHistoryDto } from './dto/employee-history.dto';
import { HubSummaryDto } from './dto/hub-summary.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Attendance')
@ApiBearerAuth('JWT-auth')
@Controller('attendances')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendancesController {
  constructor(
    private readonly attendancesService: AttendancesService,
    private readonly hubService: AttendanceHubService,
  ) {}

  /**
   * The org-wide reads below are role-gated as a set.
   *
   * They answer for the whole workforce by name — who was absent, who arrived
   * late, who has not checked out. That is a management view, and an employee
   * asking for it is asking about their colleagues rather than about
   * themselves. The two SELF routes further down stay open to everybody and
   * enforce the narrowing in the service instead, because "my own history" is a
   * question every employee is entitled to ask.
   */
  @Get()
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
  )
  @ApiOperation({ summary: 'List attendance records' })
  findAll(@Query() query: ListAttendancesDto) {
    return this.attendancesService.findAll(query);
  }

  // Every literal route below is declared before `:id`. Express matches in
  // declaration order, so with `:id` first the segment `today` would be handed
  // to ParseUUIDPipe and the panel would answer 400 on every load.

  @Get('today')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
  )
  @ApiOperation({
    summary: 'Who is in today',
    description:
      'Every non-terminated employee, including those with no row yet.',
  })
  today() {
    return this.attendancesService.today();
  }

  @Get('summary')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
  )
  @ApiOperation({
    summary: 'Attendance report',
    description: 'Totals, a per-day series and a per-department breakdown.',
  })
  summary(@Query() query: AttendanceSummaryDto) {
    return this.attendancesService.summary(query);
  }

  @Get('hub-summary')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
  )
  @ApiOperation({
    summary: 'Time & Attendance hub aggregate',
    description:
      'One window of the workforce: KPIs, trend, departments, arrivals, shifts and what needs attention.',
  })
  hubSummary(@Query() query: HubSummaryDto) {
    return this.hubService.getSummary(query.period ?? 'month', query.anchor);
  }

  @Get('employee/:employeeId')
  @ApiOperation({
    summary: "One employee's attendance history",
    description:
      'An employee may read their own; anyone else needs a management role.',
  })
  findByEmployee(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: EmployeeHistoryDto,
  ) {
    return this.attendancesService.findByEmployee(employeeId, query, user);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one attendance record',
    description:
      'An employee may read their own; anyone else needs a management role.',
  })
  findOne(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.attendancesService.findOne(id, user);
  }

  @Post('check-in')
  @ApiOperation({
    summary: 'Check in',
    description:
      "Records a punch for the caller's own employee record. Refused outside the branch geofence.",
  })
  checkIn(@CurrentUser() user: Principal, @Body() dto: CheckInDto) {
    return this.attendancesService.checkIn(user, dto);
  }

  @Post('check-out')
  @ApiOperation({
    summary: 'Check out',
    description: "Closes the caller's open punch and computes the day's hours.",
  })
  checkOut(@CurrentUser() user: Principal, @Body() dto: CheckOutDto) {
    return this.attendancesService.checkOut(user, dto);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Create an attendance record by hand' })
  create(@Body() dto: CreateAttendanceDto) {
    return this.attendancesService.create(dto);
  }

  @Post('bulk')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Mark a set of employees for one date',
    description:
      'Upserts per employee and reports the outcome of each, so one bad id does not discard the batch.',
  })
  bulk(@Body() dto: BulkAttendanceDto) {
    return this.attendancesService.bulk(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Edit an attendance record',
    description: 'Status and hours are re-derived from the resulting times.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAttendanceDto,
  ) {
    return this.attendancesService.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete an attendance record' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.attendancesService.remove(id);
  }
}
