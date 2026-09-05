import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
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
import { LeaveBalancesService } from './leave-balances.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';
import { BalanceYearDto } from './dto/list-balances.dto';
import {
  AccrueLeaveDto,
  ListAccrualHistoryDto,
  SetDefaultAllocationDto,
  UpdateLeaveBalanceDto,
  UpdateTypeBalanceDto,
} from './dto/update-balance.dto';

@ApiTags('Leave Balances')
@ApiBearerAuth('JWT-auth')
@Controller('leave-balances')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveBalancesController {
  constructor(private readonly service: LeaveBalancesService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Every employee leave balance for a year' })
  getAllBalances(@Query() query: BalanceYearDto) {
    return this.service.getAllBalances(query.year);
  }

  // The literal segments are declared before the parameterised ones: Express
  // matches in order, and `leave-types` would otherwise be read as an employee
  // id and answer 400.
  @Get('leave-types')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Active leave types a request form may offer' })
  getLeaveTypes() {
    return this.service.getLeaveTypes();
  }

  @Get('company-overview')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Company-wide entitlement and request counts' })
  getCompanyLeaveOverview(@Query() query: BalanceYearDto) {
    return this.service.getCompanyLeaveOverview(query.year);
  }

  @Get('employee/:employeeId')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'One employee balance',
    description:
      'Opens the year if it has not been opened, and fills in any leave type added to the library since.',
  })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  getBalance(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: BalanceYearDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.getBalance(employeeId, query.year, user);
  }

  @Post('employee/:employeeId/init/:year')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Open a leave year for an employee' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiParam({ name: 'year', example: 2026 })
  initBalance(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.service.initBalance(employeeId, year);
  }

  @Patch('employee/:employeeId/year/:year')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Set the statutory allocations for a year' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiParam({ name: 'year', example: 2026 })
  updateBalance(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('year', ParseIntPipe) year: number,
    @Body() dto: UpdateLeaveBalanceDto,
  ) {
    return this.service.updateBalance(
      employeeId,
      year,
      dto.annualLeave,
      dto.sickLeave,
    );
  }

  @Post('set-default-allocation')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Reset every allocation for a year to library defaults',
  })
  setBulkDefaultBalances(@Body() dto: SetDefaultAllocationDto) {
    return this.service.setBulkDefaultBalances(dto.year);
  }

  @Get('accrual/history')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'What the accrual has credited, newest period first',
  })
  getAccrualHistory(@Query() query: ListAccrualHistoryDto) {
    return this.service.getAccrualHistory(query);
  }

  @Post('accrual/run')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Credit the current month to every active employee',
    description:
      'Safe to repeat: a period already credited is reported as such and nothing is written twice.',
  })
  runAccrual() {
    return this.service.runMonthlyAccrual();
  }

  @Post('accrual/employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Credit annual leave days to one employee',
    description:
      'Recorded against the current period, so the accrual history stays a complete account of how the allocation got where it is.',
  })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  accrueForEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: AccrueLeaveDto,
  ) {
    return this.service.accrueDays(employeeId, dto.daysToAdd, dto.year);
  }

  @Patch(':employeeId/:year/:leaveTypeKey')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Set the allocation for one leave type' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiParam({ name: 'year', example: 2026 })
  @ApiParam({ name: 'leaveTypeKey', description: 'Leave type label' })
  updateTypeBalance(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('year', ParseIntPipe) year: number,
    @Param('leaveTypeKey') leaveTypeKey: string,
    @Body() dto: UpdateTypeBalanceDto,
  ) {
    return this.service.updateTypeBalance(
      employeeId,
      year,
      leaveTypeKey,
      dto.allocated,
      dto.carriedOver,
    );
  }
}
