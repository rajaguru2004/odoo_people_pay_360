import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { LeaveRequestsService } from './leave-requests.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';
import {
  ApproveRejectLeaveDto,
  CreateLeaveRequestDto,
} from './dto/create-leave-request.dto';
import {
  ListLeaveRequestsDto,
  ListMyLeaveRequestsDto,
} from './dto/list-leave-requests.dto';

@ApiTags('Leave Requests')
@ApiBearerAuth('JWT-auth')
@Controller('leave-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveRequestsController {
  constructor(private readonly service: LeaveRequestsService) {}

  // Every literal segment is declared before `:id` — Express matches in
  // declaration order, and with the parameterised route first `pending` would
  // reach ParseUUIDPipe and answer 400 for the whole screen.
  @Get('pending')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'Requests awaiting a decision' })
  findPending(@CurrentUser() user: Principal) {
    return this.service.findPending(user);
  }

  @Get('my-requests')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'My own leave requests',
    description:
      'An account not linked to an employee record — an administrator, typically — gets an empty list rather than an error.',
  })
  getMyRequests(
    @Query() query: ListMyLeaveRequestsDto,
    @CurrentUser() user: Principal,
  ) {
    if (!user.employeeId) return [];
    return this.service.findByEmployee(user.employeeId, query, user);
  }

  @Get('team-balances')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: "Remaining balances across the caller's department",
  })
  getTeamBalances(@CurrentUser() user: Principal) {
    return this.service.getTeamBalances(user);
  }

  @Get('employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: "One employee's leave history" })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  findByEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: ListMyLeaveRequestsDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.findByEmployee(employeeId, query, user);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({
    summary: 'List leave requests',
    description:
      'A department head sees their own department and nothing else.',
  })
  findAll(
    @Query() query: ListLeaveRequestsDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.findAll(query, user);
  }

  @Get(':id')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'One leave request' })
  @ApiParam({ name: 'id', description: 'Leave request UUID' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.findOne(id, user);
  }

  @Post()
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'Raise a leave request',
    description:
      'Filing for another employee is an HR privilege; anyone else may only file for themselves.',
  })
  create(@Body() dto: CreateLeaveRequestDto, @CurrentUser() user: Principal) {
    return this.service.create(dto, user);
  }

  // EMPLOYEE is admitted so a supervisor — who typically holds no elevated
  // role — can act on a step of a configured chain. Per-step eligibility is
  // enforced by the approval engine, not by this guard.
  @Post(':id/approve')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Approve a leave request' })
  @ApiParam({ name: 'id', description: 'Leave request UUID' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveRejectLeaveDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.approve(id, dto?.comment ?? dto?.rejectedReason, user);
  }

  @Post(':id/reject')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Reject a leave request' })
  @ApiParam({ name: 'id', description: 'Leave request UUID' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveRejectLeaveDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.reject(id, dto?.rejectedReason ?? dto?.comment, user);
  }

  @Delete(':id')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'Withdraw a pending request',
    description: 'The employee who raised it, or an administrator.',
  })
  @ApiParam({ name: 'id', description: 'Leave request UUID' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.cancel(id, user);
  }
}
