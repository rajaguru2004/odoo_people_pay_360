import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Delete,
  ParseIntPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { OvertimeService } from './overtime.service';
import { CreateOvertimeDto } from './dto/create-overtime.dto';
import { RejectOvertimeDto } from './dto/reject-overtime.dto';
import { ApproveOvertimeDto } from './dto/approve-overtime.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Overtime')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('overtime')
@AuditResource('OvertimeRequest')
export class OvertimeController {
  constructor(private readonly overtimeService: OvertimeService) {}

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Register overtime' })
  create(@CurrentUser() user: any, @Body() createDto: CreateOvertimeDto) {
    return this.overtimeService.create(user.employeeId, createDto, user.role);
  }

  @Post('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Register overtime for employee (HR)' })
  createForEmployee(
    @CurrentUser() user: any,
    @Param('employeeId') employeeId: string,
    @Body() createDto: CreateOvertimeDto,
  ) {
    return this.overtimeService.create(employeeId, createDto, user.role);
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'List of overtime requests' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'month', required: false, type: Number })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiQuery({ name: 'otType', required: false, type: String })
  findAll(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    // Unvalidated, this reached a `@db.Uuid` column and answered 500 with the
    // Prisma invocation and the absolute source path in the body.
    @Query('employeeId', new ParseUUIDPipe({ optional: true }))
    employeeId?: string,
    @Query('month', new ParseIntPipe({ optional: true })) month?: number,
    @Query('year', new ParseIntPipe({ optional: true })) year?: number,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('search') search?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('otType') otType?: string,
  ) {
    return this.overtimeService.findAll(
      status,
      employeeId,
      month,
      year,
      page,
      limit,
      user,
      search,
      startDate,
      endDate,
      otType,
    );
  }

  @Get('pending')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'List of pending overtime requests' })
  findPending(@CurrentUser() user: any) {
    return this.overtimeService.findPending(user);
  }

  @Get('my-requests')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'My overtime requests' })
  findMyRequests(
    @CurrentUser() user: any,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.overtimeService.findByEmployee(user.employeeId, user, page, limit);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Overtime requests by employee' })
  findByEmployee(
    @CurrentUser() user: any,
    @Param('employeeId') employeeId: string,
  ) {
    return this.overtimeService.findByEmployee(employeeId, user);
  }

  @Get('employee/:employeeId/hours/:month/:year')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Total approved overtime hours in month' })
  getApprovedHours(
    @Param('employeeId') employeeId: string,
    @Param('month', ParseIntPipe) month: number,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.overtimeService.getApprovedOvertimeHours(
      employeeId,
      month,
      year,
    );
  }

  @Get('report/:month/:year')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Monthly overtime report' })
  getMonthlyReport(
    @Param('month', ParseIntPipe) month: number,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.overtimeService.getMonthlyReport(month, year);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Overtime request details' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    // withPreview: the detail screen renders the server's live breakdown
    // (policy-aware food allowance / OT type) instead of guessing from globals.
    return this.overtimeService.findOne(id, user, { withPreview: true });
  }

  @Post(':id/approve')
  // EMPLOYEE admitted for supervisor approvers; engine enforces step eligibility.
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Approve overtime request, optionally with approver corrections',
  })
  approve(
    @Param('id') id: string,
    @CurrentUser() user: any,
    // Optional in the wire sense as well as the type sense: a caller may post
    // no body at all, and that must keep meaning "approve exactly as filed".
    @Body() approveDto?: ApproveOvertimeDto,
  ) {
    return this.overtimeService.approve(id, user.id, user, approveDto);
  }

  @Post(':id/edit-preview')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Dry-run an approver correction: the breakdown, allowances and rates it would produce. Writes nothing.',
  })
  editPreview(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() dto: ApproveOvertimeDto,
  ) {
    return this.overtimeService.previewApproverEdit(id, dto, user);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Reject overtime request' })
  reject(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() rejectDto: RejectOvertimeDto,
  ) {
    return this.overtimeService.reject(id, user.id, rejectDto, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Cancel overtime request' })
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.overtimeService.cancel(id, user.employeeId);
  }
}
