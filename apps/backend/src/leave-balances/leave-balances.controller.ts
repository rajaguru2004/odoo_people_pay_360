import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
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
import { LeaveBalancesService } from './leave-balances.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Leave Balances')
@Controller('leave-balances')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class LeaveBalancesController {
  constructor(private readonly service: LeaveBalancesService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get all leave balances',
    description: 'Get leave balances for all employees',
  })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Leave balances retrieved' })
  getAllBalances(@Query('year') year?: number) {
    return this.service.getAllBalances(year ? +year : undefined);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get employee leave balance' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Leave balance retrieved' })
  getBalance(
    @Param('employeeId') employeeId: string,
    @CurrentUser() user: any,
    @Query('year') year?: number,
  ) {
    return this.service.getBalance(employeeId, year ? +year : undefined, user);
  }

  @Post('employee/:employeeId/init/:year')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Initialize leave balance for year' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiParam({ name: 'year', description: 'Year', example: 2026 })
  @ApiResponse({ status: 201, description: 'Leave balance initialized' })
  initBalance(
    @Param('employeeId') employeeId: string,
    @Param('year') year: number,
  ) {
    return this.service.initBalance(employeeId, +year);
  }

  @Patch('employee/:employeeId/year/:year')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update leave balance' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiParam({ name: 'year', description: 'Year' })
  @ApiResponse({ status: 200, description: 'Leave balance updated' })
  updateBalance(
    @Param('employeeId') employeeId: string,
    @Param('year') year: number,
    @Body('annualLeave') annualLeave: number,
    @Body('sickLeave') sickLeave?: number,
  ) {
    return this.service.updateBalance(
      employeeId,
      +year,
      annualLeave,
      sickLeave,
    );
  }

  // ==================== LEAVE ACCRUAL ENDPOINTS ====================

  @Post('accrual/run')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Run leave accrual manually',
    description:
      'Manually trigger leave accrual for all active employees (1 day per month)',
  })
  @ApiResponse({ status: 200, description: 'Leave accrual completed' })
  runAccrual(@CurrentUser() user: any) {
    return this.service.accrueLeaveForAllEmployees(user.id);
  }

  @Post('accrual/employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Accrue leave for specific employee',
    description: 'Manually add leave days to an employee',
  })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Leave accrued successfully' })
  accrueForEmployee(
    @Param('employeeId') employeeId: string,
    @Body('daysToAdd') daysToAdd: number,
    @Body('notes') notes: string,
    @CurrentUser() user: any,
  ) {
    return this.service.accrueLeaveForEmployee(
      employeeId,
      daysToAdd,
      user.id,
      notes,
    );
  }

  @Get('accrual/history')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Get leave accrual history' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'month', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Accrual history retrieved' })
  getAccrualHistory(
    @Query('employeeId') employeeId?: string,
    @Query('year') year?: number,
    @Query('month') month?: number,
  ) {
    return this.service.getAccrualHistory(
      employeeId,
      year ? +year : undefined,
      month ? +month : undefined,
    );
  }

  @Get('company-overview')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Get company-wide leave overview stats' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Company leave overview retrieved' })
  getCompanyLeaveOverview(@Query('year') year?: number) {
    return this.service.getCompanyLeaveOverview(year ? +year : undefined);
  }

  @Get('leave-types')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get active leave types configuration' })
  @ApiResponse({ status: 200, description: 'Active leave types retrieved' })
  getLeaveTypes() {
    return this.service.getLeaveTypes();
  }

  @Post('set-default-allocation')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Bulk-reset allocations from library defaults' })
  @ApiResponse({ status: 200, description: 'Bulk reset completed' })
  setBulkDefaultBalances(@Body('year') year: number) {
    return this.service.setBulkDefaultBalances(+year);
  }

  @Patch(':employeeId/:year/:leaveTypeKey')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update allocation per leave type' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiParam({ name: 'year', description: 'Year' })
  @ApiParam({ name: 'leaveTypeKey', description: 'Leave type label' })
  @ApiResponse({ status: 200, description: 'Allocation updated' })
  updateTypeBalance(
    @Param('employeeId') employeeId: string,
    @Param('year') year: number,
    @Param('leaveTypeKey') leaveTypeKey: string,
    @Body('allocated') allocated: number,
    @Body('carriedOver') carriedOver?: number,
  ) {
    return this.service.updateTypeBalance(
      employeeId,
      +year,
      leaveTypeKey,
      allocated,
      carriedOver,
    );
  }
}
