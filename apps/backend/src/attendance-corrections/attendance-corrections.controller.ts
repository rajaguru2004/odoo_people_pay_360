import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Delete,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AttendanceCorrectionsService } from './attendance-corrections.service';
import { CreateAttendanceCorrectionDto } from './dto/create-attendance-correction.dto';
import { ApproveAttendanceCorrectionDto } from './dto/approve-correction.dto';
import { RejectAttendanceCorrectionDto } from './dto/reject-correction.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Attendance Corrections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('attendance-corrections')
@AuditResource('AttendanceCorrection')
export class AttendanceCorrectionsController {
  constructor(
    private readonly attendanceCorrectionsService: AttendanceCorrectionsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create attendance correction request' })
  create(
    @CurrentUser() user: any,
    @Body() createDto: CreateAttendanceCorrectionDto,
  ) {
    return this.attendanceCorrectionsService.create(user.employeeId, createDto);
  }

  @Post('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Create correction request for employee (HR)' })
  createForEmployee(
    @Param('employeeId') employeeId: string,
    @Body() createDto: CreateAttendanceCorrectionDto,
  ) {
    // HR-on-behalf bypasses the monthly self-service limit.
    return this.attendanceCorrectionsService.create(employeeId, createDto, true);
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List attendance correction requests' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'employeeId', required: false })
  findAll(
    @Query('status') status?: string,
    @Query('employeeId') employeeId?: string,
  ) {
    return this.attendanceCorrectionsService.findAll(status, employeeId);
  }

  @Get('stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Correction queue depth and age',
    description: 'Average resolution is over the last 30 days of decided requests only.',
  })
  stats() {
    return this.attendanceCorrectionsService.stats();
  }

  @Get('pending')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List pending correction requests' })
  findPending() {
    return this.attendanceCorrectionsService.findPending();
  }

  @Get('my-requests')
  @ApiOperation({ summary: 'My correction requests' })
  findMyRequests(@CurrentUser() user: any) {
    return this.attendanceCorrectionsService.findByEmployee(user.employeeId);
  }

  @Get('my-usage')
  @ApiOperation({ summary: 'My monthly attendance-request usage vs limit' })
  getMyUsage(@CurrentUser() user: any) {
    return this.attendanceCorrectionsService.getMonthlyUsage(user.employeeId);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Correction requests by employee' })
  findByEmployee(@Param('employeeId') employeeId: string) {
    return this.attendanceCorrectionsService.findByEmployee(employeeId);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Attendance correction details' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string) {
    const correction = await this.attendanceCorrectionsService.findOne(id);

    // This route previously carried NO @Roles at all, and RolesGuard allows
    // when the metadata is absent — so every authenticated user reached it, and
    // neither the controller nor the service checked ownership. `findOne` calls
    // assertInBranch, so the leak was bounded by branch and no further: any
    // colleague could read the reason text, both requested times and the
    // reviewer's note for anyone in their branch.
    //
    // Reviewers (ADMIN/HR) see everything; everybody else sees only their own.
    if (
      !['ADMIN', 'HR_MANAGER'].includes(user?.role) &&
      correction.employeeId !== user?.employeeId
    ) {
      throw new ForbiddenException(
        'You do not have permission to view this correction request.',
      );
    }

    return correction;
  }

  @Post(':id/approve')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Approve correction request' })
  approve(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() approveDto?: ApproveAttendanceCorrectionDto,
  ) {
    return this.attendanceCorrectionsService.approve(id, user.id, approveDto);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Reject correction request' })
  reject(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() rejectDto: RejectAttendanceCorrectionDto,
  ) {
    return this.attendanceCorrectionsService.reject(id, user.id, rejectDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel correction request' })
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.attendanceCorrectionsService.cancel(id, user.employeeId);
  }
}
