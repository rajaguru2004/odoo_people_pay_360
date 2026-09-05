import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { OvertimeService } from './overtime.service';
import { CreateOvertimeDto } from './dto/create-overtime.dto';
import { RejectOvertimeDto } from './dto/reject-overtime.dto';
import { ApproveOvertimeDto } from './dto/approve-overtime.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Overtime')
@ApiBearerAuth('JWT-auth')
@Controller('overtime')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OvertimeController {
  constructor(private readonly overtimeService: OvertimeService) {}

  @Post()
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Register overtime for yourself' })
  create(@CurrentUser() user: Principal, @Body() createDto: CreateOvertimeDto) {
    return this.overtimeService.create(user.employeeId, createDto, user.role);
  }

  @Post('employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Register overtime for an employee' })
  createForEmployee(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() createDto: CreateOvertimeDto,
  ) {
    return this.overtimeService.create(employeeId, createDto, user.role);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'List overtime requests' })
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
    @CurrentUser() user: Principal,
    @Query('status') status?: string,
    // Parsed rather than passed through: unvalidated, this reaches a `@db.Uuid`
    // column and the driver error answers with the query text.
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
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'Overtime requests awaiting a decision' })
  findPending(@CurrentUser() user: Principal) {
    return this.overtimeService.findPending(user);
  }

  @Get('my-requests')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Your own overtime requests' })
  findMyRequests(
    @CurrentUser() user: Principal,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.overtimeService.findByEmployee(
      user.employeeId ?? '',
      user,
      page,
      limit,
    );
  }

  @Get('employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'Overtime requests for one employee' })
  findByEmployee(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.overtimeService.findByEmployee(employeeId, user);
  }

  @Get('employee/:employeeId/hours/:month/:year')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Total approved overtime hours in a month' })
  getApprovedHours(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
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
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Monthly overtime report' })
  getMonthlyReport(
    @Param('month', ParseIntPipe) month: number,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.overtimeService.getMonthlyReport(month, year);
  }

  @Get(':id')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'One overtime request',
    description:
      'Carries the server-side breakdown, so the detail screen renders the policy-aware figures instead of guessing from the company settings.',
  })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.overtimeService.findOne(id, user, { withPreview: true });
  }

  // EMPLOYEE is admitted because a supervisor named on an approval chain holds
  // that role; the engine still decides whether they are eligible for the step.
  @Post(':id/approve')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'Approve an overtime request, optionally with corrections',
  })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
    // Optional in the wire sense as well as the type sense: a bodyless approve
    // has to keep meaning "approve exactly as filed".
    @Body() approveDto?: ApproveOvertimeDto,
  ) {
    return this.overtimeService.approve(id, user.id, user, approveDto);
  }

  @Post(':id/edit-preview')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'Dry-run an approver correction',
    description:
      'Returns the breakdown, allowances and rates it would produce. Writes nothing.',
  })
  editPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
    @Body() dto: ApproveOvertimeDto,
  ) {
    return this.overtimeService.previewApproverEdit(id, dto, user);
  }

  @Post(':id/reject')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Reject an overtime request' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
    @Body() rejectDto: RejectOvertimeDto,
  ) {
    return this.overtimeService.reject(id, user.id, rejectDto, user);
  }

  @Delete(':id')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Withdraw your own pending overtime request' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.overtimeService.cancel(id, user.employeeId);
  }
}
