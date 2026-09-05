import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Body,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AttendancesService } from './attendances.service';
import {
  AttendanceHubService,
  type HubPeriod,
} from './attendance-hub.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { CreateManualAttendanceDto } from './dto/create-manual-attendance.dto';
import { CheckInDto } from './dto/check-in.dto';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Attendances')
@ApiBearerAuth('JWT-auth')
@Controller('attendances')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Attendance')
export class AttendancesController {
  constructor(
    private readonly attendancesService: AttendancesService,
    private readonly attendanceHubService: AttendanceHubService,
  ) {}

  @Post('check-in')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Check in',
    description: 'Record check-in time for current user',
  })
  @ApiResponse({ status: 201, description: 'Checked in successfully' })
  @ApiResponse({ status: 400, description: 'Already checked in today' })
  checkIn(@CurrentUser() user: any, @Body() dto: CheckInDto) {
    return this.attendancesService.checkIn(user.employeeId, false, dto);
  }

  @Post('check-in/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Check in for employee',
    description: 'Record check-in for specific employee (HR only)',
  })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  async checkInForEmployee(@Param('employeeId') employeeId: string) {
    // The id came from the URL, so it is the caller's to prove. Self-service
    // punches are NOT guarded this way — see assertEmployeeInBranch's comment.
    await this.attendancesService.assertEmployeeInBranch(employeeId);
    return this.attendancesService.checkIn(employeeId, false, undefined, true);
  }

  @Post('check-out')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Check out',
    description: 'Record check-out time for current user',
  })
  @ApiResponse({ status: 201, description: 'Checked out successfully' })
  @ApiResponse({ status: 400, description: 'No check-in record found' })
  checkOut(@CurrentUser() user: any, @Body() dto: CheckInDto) {
    // The body was never bound, so a position the client sent was silently
    // discarded and the service's range check — which only runs WHEN
    // coordinates are supplied — could never fire from the portal. A geofenced
    // branch was protected on the way in and not on the way out.
    return this.attendancesService.checkOut(user.employeeId, false, {
      latitude: dto?.latitude,
      longitude: dto?.longitude,
      accuracy: dto?.accuracy,
    });
  }

  @Post('check-out/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Check out for employee',
    description: 'Record check-out for specific employee (HR only)',
  })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  async checkOutForEmployee(@Param('employeeId') employeeId: string) {
    await this.attendancesService.assertEmployeeInBranch(employeeId);
    return this.attendancesService.checkOut(employeeId);
  }

  @Post('lunch-check-out')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Lunch check out',
    description: 'Record lunch check-out time for current user',
  })
  @ApiResponse({ status: 201, description: 'Lunch break started successfully' })
  lunchCheckOut(@CurrentUser() user: any) {
    return this.attendancesService.lunchCheckOut(user.employeeId);
  }

  @Post('lunch-check-in')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Lunch check in',
    description: 'Record lunch check-in time for current user',
  })
  @ApiResponse({ status: 201, description: 'Checked back in from lunch break successfully' })
  lunchCheckIn(@CurrentUser() user: any) {
    return this.attendancesService.lunchCheckIn(user.employeeId);
  }

  @Get('lunch-status')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get lunch break status',
    description: 'Get lunch break status for today',
  })
  getLunchStatus(@CurrentUser() user: any) {
    return this.attendancesService.getLunchBreakStatus(user.employeeId);
  }

  @Get('today')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get today attendance',
    description: 'Get current user attendance for today',
  })
  getToday(@CurrentUser() user: any) {
    return this.attendancesService.getTodayAttendance(user.employeeId);
  }

  @Get('my')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get my attendances',
    description: 'Get attendance records for the currently logged-in employee',
  })
  @ApiQuery({ name: 'month', required: false, type: Number, example: 3 })
  @ApiQuery({ name: 'year', required: false, type: Number, example: 2026 })
  getMyAttendances(
    @CurrentUser() user: any,
    @Query('month') month?: number,
    @Query('year') year?: number,
  ) {
    return this.attendancesService.getEmployeeAttendances(
      user.employeeId,
      month,
      year,
    );
  }

  @Get('today/all')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get all today attendances',
    description: 'Get all employees attendance for today (Admin only)',
  })
  getTodayAll() {
    return this.attendancesService.getTodayAllAttendances();
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get employee attendances',
    description: 'Get attendance records for an employee',
  })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiQuery({ name: 'month', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'year', required: false, type: Number, example: 2026 })
  async getEmployeeAttendances(
    @CurrentUser() user: any,
    @Param('employeeId') employeeId: string,
    @Query('month') month?: number,
    @Query('year') year?: number,
  ) {
    // EMPLOYEE scope: self only. The route admits EMPLOYEE, and without this
    // an employee reads any colleague's entire month — times, hours and
    // lateness — by id. `GET /attendances/:id` already carries the same check;
    // this is its sibling door, which never got it.
    if (user?.role === 'EMPLOYEE' && employeeId !== user.employeeId) {
      throw new ForbiddenException(
        'You do not have permission to view this employee’s attendance.',
      );
    }

    // Branch envelope, for the id the CALLER supplied. `/my` reaches the same
    // service method with the id from the token and is deliberately not guarded
    // here — a user must never lose their own attendance because the branch
    // picker points elsewhere.
    if (employeeId !== user?.employeeId) {
      await this.attendancesService.assertEmployeeInBranch(employeeId);
    }

    // MANAGER scope: can only view employees in own department
    if (user?.role === 'MANAGER') {
      const emp = await this.attendancesService.getEmployeeDept(employeeId);
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to perform this action outside your department.',
        );
      }
    }
    return this.attendancesService.getEmployeeAttendances(
      employeeId,
      month,
      year,
    );
  }

  @Get('report')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get monthly report',
    description: 'Get attendance report for all employees',
  })
  @ApiQuery({ name: 'month', required: true, type: Number, example: 1 })
  @ApiQuery({ name: 'year', required: true, type: Number, example: 2026 })
  getMonthlyReport(@Query('month') month: number, @Query('year') year: number) {
    return this.attendancesService.getMonthlyReport(month, year);
  }

  @Get('statistics')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get attendance statistics',
    description: 'Get statistics for a month',
  })
  @ApiQuery({ name: 'month', required: false, type: Number })
  @ApiQuery({ name: 'year', required: false, type: Number })
  getStatistics(@Query('month') month?: number, @Query('year') year?: number) {
    return this.attendancesService.getStatistics(month, year);
  }

  @Get('absenteeism-stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get absenteeism statistics',
    description:
      'Get absenteeism and late statistics for today, week, and month with trend data',
  })
  @ApiResponse({ status: 200, description: 'Absenteeism statistics retrieved' })
  getAbsenteeismStats() {
    return this.attendancesService.getAbsenteeismStats();
  }

  @Post('auto-mark-absent')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Manually trigger auto-absent marking',
    description:
      'Mark employees as absent if they did not check-in (normally runs automatically at 7 PM)',
  })
  @ApiResponse({ status: 201, description: 'Auto-absent marking completed' })
  manualAutoMarkAbsent() {
    return this.attendancesService.autoMarkAbsent(true);
  }

  @Get('validate')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Validate attendance data',
    description:
      'Check for missing days and incomplete records for a specific month',
  })
  @ApiQuery({ name: 'month', required: true, type: Number, example: 2 })
  @ApiQuery({ name: 'year', required: true, type: Number, example: 2026 })
  @ApiResponse({ status: 200, description: 'Validation results returned' })
  validateAttendanceData(
    @Query('month') month: number,
    @Query('year') year: number,
  ) {
    return this.attendancesService.validateAttendanceData(
      Number(month),
      Number(year),
    );
  }

  @Post('manual')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Manually record/override attendance for employee',
    description:
      'Manually record check-in and check-out for specific employee and date (HR/Admin only)',
  })
  createManualAttendance(@Body() dto: CreateManualAttendanceDto) {
    return this.attendancesService.createManualAttendance(dto);
  }

  @Get('overview')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Get attendance overview',
    description:
      'Get aggregated stats, trend data, recent check-ins and department breakdown for a period',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['today', 'week', 'month', 'custom'],
    example: 'today',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    type: String,
    description: 'Reference date YYYY-MM-DD',
  })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Overview data retrieved' })
  getOverview(
    @CurrentUser() user: any,
    @Query('period') period?: 'today' | 'week' | 'month' | 'custom',
    @Query('date') date?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.attendancesService.getOverview(period || 'today', user, date, startDate, endDate);
  }

  @Get('hub-summary')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Time & Attendance module hub summary',
    description:
      'Everything the module landing dashboard draws, in one request: the ' +
      "selected period's totals and the window before it (for every delta on " +
      'the page), its trend buckets, the department ranking, plus the live ' +
      'today snapshot the foot of the page needs regardless of period. Rates ' +
      "divide by EXPECTED employees — the branch's working calendar minus " +
      'approved leave — not by headcount.',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['today', 'week', 'month', 'year'],
    example: 'today',
  })
  @ApiQuery({
    name: 'anchor',
    required: false,
    type: String,
    description:
      'Any date inside the period being viewed (YYYY-MM-DD). Defaults to today; ' +
      'page with the prevAnchor/nextAnchor the response returns.',
  })
  @ApiResponse({ status: 200, description: 'Hub summary retrieved' })
  getHubSummary(
    @CurrentUser() user: any,
    @Query('period') period?: HubPeriod,
    @Query('anchor') anchor?: string,
  ) {
    return this.attendanceHubService.getHubSummary(
      period || 'today',
      anchor,
      user,
    );
  }

  @Get('list')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get paginated attendance list for a period',
    description:
      'Returns filterable, paginated attendance records for today, week or month/custom range',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['today', 'week', 'month', 'custom'],
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'departmentId', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'date',
    required: false,
    type: String,
    description: 'Reference date YYYY-MM-DD',
  })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Attendance list retrieved' })
  getAttendanceList(
    @CurrentUser() user: any,
    @Query('period') period?: 'today' | 'week' | 'month' | 'custom',
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('departmentId') departmentId?: string,
    @Query('search') search?: string,
    @Query('date') date?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.attendancesService.getAttendanceList(
      { period, page, limit, status, departmentId, search, date, startDate, endDate },
      user,
    );
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get attendance by ID',
    description: 'Get details of a specific attendance record',
  })
  @ApiParam({ name: 'id', description: 'Attendance UUID' })
  async getAttendanceById(@CurrentUser() user: any, @Param('id') id: string) {
    const result = await this.attendancesService.getAttendanceById(id);
    const attendance = result.data;

    // Authorization check: Employees can only view their own attendance records
    if (
      user?.role === 'EMPLOYEE' &&
      attendance.employeeId !== user.employeeId
    ) {
      throw new ForbiddenException(
        'You do not have permission to view this attendance record.',
      );
    }

    // MANAGER scope: can only view employees in own department
    if (
      user?.role === 'MANAGER' &&
      !isDeptInManagerScope(user, attendance.employee?.department?.id)
    ) {
      throw new ForbiddenException(
        'You do not have permission to view attendance records outside your department.',
      );
    }

    return result;
  }
}
