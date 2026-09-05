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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';
import { LeaveBalancesService } from './leave-balances.service';
import { UpdateBalanceDto } from './dto/update-balance.dto';
import { UpdateTypeBalanceDto } from './dto/update-type-balance.dto';
import { AccrueLeaveDto } from './dto/accrue-leave.dto';

@ApiTags('Leave balances')
@ApiBearerAuth('JWT-auth')
@Controller('leave-balances')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveBalancesController {
  constructor(private readonly service: LeaveBalancesService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Every employee balance for a year' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  getAll(@Query('year') year?: string) {
    return this.service.getAllBalances(year ? Number(year) : undefined);
  }

  // Literals before the `:employeeId`-shaped routes, or "leave-types" and
  // "company-overview" are parsed as uuids and answer 400.
  @Get('leave-types')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'The leave types that may be filed, with their rules',
    description:
      'Open to everybody: an employee filing leave has to see what they may pick.',
  })
  getLeaveTypes() {
    return this.service.getLeaveTypes();
  }

  @Get('company-overview')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Company-wide entitlement by leave type' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  companyOverview(@Query('year') year?: string) {
    return this.service.getCompanyLeaveOverview(
      year ? Number(year) : undefined,
    );
  }

  @Get('accrual/history')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Every credit ever made, automatic or by hand' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'month', required: false, type: Number })
  accrualHistory(
    @Query('employeeId') employeeId?: string,
    @Query('year') year?: string,
    @Query('month') month?: string,
  ) {
    return this.service.getAccrualHistory(
      employeeId,
      year ? Number(year) : undefined,
      month ? Number(month) : undefined,
    );
  }

  @Post('accrual/run')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Run the monthly accrual now',
    description:
      'Idempotent: an employee already credited for the company month is skipped.',
  })
  runAccrual(@CurrentUser() user: Principal) {
    return this.service.accrueLeaveForAllEmployees(user.id);
  }

  @Post('accrual/employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Credit days to one employee by hand' })
  accrueForEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: AccrueLeaveDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.accrueLeaveForEmployee(
      employeeId,
      dto.daysToAdd,
      user.id,
      dto.notes,
    );
  }

  @Post('set-default-allocation')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Reset every allocation to the library defaults for a year',
    description: 'Allocations only — what has already been taken is untouched.',
  })
  setDefaults(@Body('year', ParseIntPipe) year: number) {
    return this.service.setBulkDefaultBalances(year);
  }

  /**
   * Open to every role. An employee reads their own; a supervisor reads the
   * balance of somebody whose leave they are being asked to decide, because
   * "they have four days left" is the context that decision needs. The narrowing
   * is in the service, since it depends on WHOSE record it is.
   */
  @Get('employee/:employeeId')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'One employee balance for a year' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  getForEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @CurrentUser() user: Principal,
    @Query('year') year?: string,
  ) {
    return this.service.getBalance(
      employeeId,
      year ? Number(year) : undefined,
      user,
    );
  }

  @Post('employee/:employeeId/init/:year')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Create the balance rows for an employee-year' })
  init(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.service.initBalance(employeeId, year);
  }

  @Patch('employee/:employeeId/year/:year')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Edit the headline annual and sick entitlement' })
  updateBalance(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('year', ParseIntPipe) year: number,
    @Body() dto: UpdateBalanceDto,
  ) {
    return this.service.updateBalance(
      employeeId,
      year,
      dto.annualLeave,
      dto.sickLeave,
    );
  }

  @Patch('employee/:employeeId/year/:year/type/:leaveTypeKey')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Edit the allocation for one leave type' })
  updateTypeBalance(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('year', ParseIntPipe) year: number,
    @Param('leaveTypeKey') leaveTypeKey: string,
    @Body() dto: UpdateTypeBalanceDto,
  ) {
    return this.service.updateTypeBalance(
      employeeId,
      year,
      decodeURIComponent(leaveTypeKey),
      dto.allocated,
      dto.carriedOver,
    );
  }
}
