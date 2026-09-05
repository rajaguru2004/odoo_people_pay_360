import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { LeaveRequestsService } from './leave-requests.service';
import { LeaveHubService } from './leave-hub.service';
import type { HubPeriod } from '../common/hub/hub-range.util';
import {
  CreateLeaveRequestDto,
  ApproveRejectDto,
} from './dto/create-leave-request.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Leave Requests')
@ApiBearerAuth('JWT-auth')
@Controller('leave-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('LeaveRequest')
export class LeaveRequestsController {
  constructor(
    private readonly leaveRequestsService: LeaveRequestsService,
    private readonly leaveHubService: LeaveHubService,
  ) {}

  // Like team-balances, this must precede `:id` or Nest reads "hub-summary"
  // as a leave-request UUID and answers 400 for the whole dashboard.
  @Get('hub-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Leave & Overtime module hub summary',
    description:
      'Everything the Leave & Overtime landing dashboard draws, in one ' +
      "request: the selected period's request counts (all four statuses, " +
      'CANCELLED included), leave days prorated to the part of each request ' +
      'inside the window, the year balance the window ends in, the overtime ' +
      'worked, plus the same window one step back for every delta on the ' +
      'page. Rates are null, never 0%, when there was nothing to divide by.',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['today', 'week', 'month', 'year'],
    example: 'month',
  })
  @ApiQuery({
    name: 'anchor',
    required: false,
    type: String,
    description:
      'Any date inside the period being viewed (YYYY-MM-DD). Defaults to today; ' +
      'page with the prevAnchor/nextAnchor the response returns.',
  })
  @ApiResponse({ status: 200, description: 'Leave & Overtime hub summary retrieved' })
  async getHubSummary(
    @CurrentUser() user: any,
    @Query('period') period?: HubPeriod,
    @Query('anchor') anchor?: string,
  ) {
    return this.leaveHubService.getHubSummary(period || 'month', anchor, user);
  }

  // Item 21 — team-balances must be before :id to avoid route conflict
  @Get('team-balances')
  @Roles('MANAGER')
  @ApiOperation({
    summary: 'Get team leave balances (Manager only)',
    description:
      "Returns remaining leave balances for all employees in the manager's department",
  })
  @ApiResponse({ status: 200, description: 'Team balances retrieved' })
  getTeamBalances(@CurrentUser() user: any) {
    return this.leaveRequestsService.getTeamBalances(user);
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get all leave requests' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'leaveType', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @CurrentUser() user: any,
    @Query()
    query: {
      employeeId?: string;
      status?: string;
      leaveType?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    return this.leaveRequestsService.findAll(query, user);
  }

  @Get('pending')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Get pending requests',
    description: 'Get all pending leave requests for approval',
  })
  findPending(@CurrentUser() user: any) {
    return this.leaveRequestsService.findPending(user);
  }

  @Get('my-requests')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get my leave requests',
    description: 'Get current user leave requests',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'leaveType', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  getMyRequests(
    @CurrentUser() user: any,
    @Query()
    query: {
      status?: string;
      leaveType?: string;
      startDate?: string;
      endDate?: string;
    },
  ) {
    // An ADMIN account need not be linked to an employee record. Passing an
    // undefined id straight through reached
    // `findUnique({ where: { id: undefined } })` and answered 500.
    if (!user?.employeeId) {
      return { success: true, data: [] };
    }
    return this.leaveRequestsService.findByEmployee(user.employeeId, query, user);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get employee leave requests' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  findByEmployee(
    @Param('employeeId') employeeId: string,
    @CurrentUser() user: any,
  ) {
    return this.leaveRequestsService.findByEmployee(employeeId, undefined, user);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get leave request by ID' })
  @ApiParam({ name: 'id', description: 'Leave request UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.leaveRequestsService.findOne(id, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Create leave request',
    description: 'Submit a new leave request',
  })
  @ApiResponse({ status: 201, description: 'Leave request created' })
  create(@Body() dto: CreateLeaveRequestDto, @CurrentUser() user: any) {
    return this.leaveRequestsService.create(dto, user.id, user.employeeId, user);
  }

  @Post(':id/approve')
  // EMPLOYEE is admitted so a supervisor (who may hold no elevated role) can act;
  // per-step eligibility is enforced in the approval engine, not the route guard.
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Approve leave request' })
  @ApiParam({ name: 'id', description: 'Leave request UUID' })
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveRejectDto,
    @CurrentUser() user: any,
  ) {
    return this.leaveRequestsService.approve(
      id,
      user.id,
      dto?.comment || dto?.rejectedReason,
      user,
    );
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Reject leave request' })
  @ApiParam({ name: 'id', description: 'Leave request UUID' })
  reject(
    @Param('id') id: string,
    @Body() dto: ApproveRejectDto,
    @CurrentUser() user: any,
  ) {
    return this.leaveRequestsService.reject(
      id,
      user.id,
      dto?.comment || dto?.rejectedReason,
      user,
    );
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Cancel leave request',
    description: 'Cancel own pending request',
  })
  @ApiParam({ name: 'id', description: 'Leave request UUID' })
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.leaveRequestsService.cancel(id, user.id, user.employeeId);
  }
}
