import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { PayrollsService } from './payrolls.service';
import {
  CreatePayrollDto,
  UpdatePayrollItemDto,
  UnlockPayrollDto,
  ListPayrollsQueryDto,
  PAYROLL_STATUSES,
} from './dto/payroll.dto';
import { ApprovePayrollDto } from './dto/approve-payroll.dto';
import { RejectPayrollDto } from './dto/reject-payroll.dto';
import { CreateRevisionDto } from './dto/create-revision.dto';
import { BulkApproveDto } from './dto/bulk-approve.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Payrolls')
@ApiBearerAuth('JWT-auth')
@Controller('payrolls')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Payroll')
export class PayrollsController {
  constructor(
    private readonly payrollsService: PayrollsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Get all payrolls' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, enum: PAYROLL_STATUSES })
  findAll(@Query() query: ListPayrollsQueryDto) {
    return this.payrollsService.findAll({
      year: query.year,
      status: query.status,
    });
  }

  // Declared before @Get(':id') so the literal path is not swallowed by the param route.
  @Get('my-ytd-summary')
  @Roles('EMPLOYEE', 'MANAGER', 'HR_MANAGER', 'ADMIN')
  @ApiOperation({
    summary: 'Get YTD summary',
    description: 'Year-to-date income and tax summary',
  })
  @ApiQuery({ name: 'year', required: false, type: Number })
  getYTDSummary(@CurrentUser() user: any, @Query('year') year?: number) {
    const currentYear = year || new Date().getFullYear();
    return this.payrollsService.getYTDSummary(user.employeeId, currentYear);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get payroll by ID',
    description: 'Get payroll with all items',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.payrollsService.findOne(id);
  }

  @Get('payslip/:employeeId/:month/:year')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get payslip',
    description: 'Get employee payslip for a month',
  })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiParam({ name: 'month', description: 'Month (1-12)' })
  @ApiParam({ name: 'year', description: 'Year' })
  async getPayslip(
    @CurrentUser() user: any,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('month') month: number,
    @Param('year') year: number,
  ) {
    // EMPLOYEE: can only view their own payslip. Without this an employee
    // could read any colleague's salary by passing their UUID — the
    // self-scoped routes above (my-payslips/list, my-payslips/:itemId) derive
    // the employee from the token, but this one takes it from the path.
    if (user?.role === 'EMPLOYEE' && user?.employeeId !== employeeId) {
      throw new ForbiddenException('You can only view your own payslip.');
    }

    // MANAGER: can only view payslips for own dept employees
    if (user?.role === 'MANAGER') {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { departmentId: true },
      });
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to view payslips outside your department.',
        );
      }
    }
    // ADMIN and HR_MANAGER own the run and may read it at any status. Everyone
    // else — the employee themselves, and a manager reading their team — sees
    // only what `my-payslips/*` would show them: APPROVED or LOCKED. A DRAFT
    // payslip is a figure HR is still working on, not a statement of pay.
    const onlyFinalized = !['ADMIN', 'HR_MANAGER'].includes(user?.role);
    return this.payrollsService.getPayslip(employeeId, +month, +year, {
      onlyFinalized,
    });
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Create payroll',
    description: 'Create monthly payroll and calculate salaries',
  })
  @ApiResponse({ status: 201, description: 'Payroll created' })
  @ApiResponse({ status: 409, description: 'Payroll already exists' })
  create(@Body() dto: CreatePayrollDto) {
    return this.payrollsService.create(dto);
  }

  @Patch(':id/items/:itemId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Update payroll item',
    description: 'Adjust salary components',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  @ApiParam({ name: 'itemId', description: 'Payroll item UUID' })
  updateItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdatePayrollItemDto,
  ) {
    return this.payrollsService.updateItem(id, itemId, dto);
  }

  @Post(':id/finalize')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Finalize payroll (deprecated alias for POST :id/lock)',
    description:
      'Kept for existing integrations. Delegates to the same code path as ' +
      'POST :id/lock, so the payroll must be APPROVED first. It previously ' +
      'locked from any status without flipping reimbursements or advance/loan ' +
      'installments to PAID, which left LOCKED meaning nothing. Prefer ' +
      'submit -> approve -> lock.',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  finalize(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.payrollsService.finalize(id, user.id);
  }

  // Employee Payslip Endpoints
  @Get('my-payslips/list')
  @Roles('EMPLOYEE', 'MANAGER', 'HR_MANAGER', 'ADMIN')
  @ApiOperation({
    summary: 'Get my payslips',
    description: 'Get all payslips for current user',
  })
  getMyPayslips(@CurrentUser() user: any) {
    return this.payrollsService.getEmployeePayslips(user.employeeId);
  }

  @Get('my-payslips/:itemId')
  @Roles('EMPLOYEE', 'MANAGER', 'HR_MANAGER', 'ADMIN')
  @ApiOperation({ summary: 'Get my payslip detail' })
  @ApiParam({ name: 'itemId', description: 'Payroll item UUID' })
  getMyPayslip(@Param('itemId', ParseUUIDPipe) itemId: string, @CurrentUser() user: any) {
    return this.payrollsService.getEmployeePayslipDetail(
      user.employeeId,
      itemId,
    );
  }

  // =====================================================
  // PAYROLL WORKFLOW ENDPOINTS
  // =====================================================

  @Post(':id/submit')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Submit payroll for approval',
    description: 'Change status from DRAFT to PENDING_APPROVAL',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  @ApiResponse({ status: 200, description: 'Payroll submitted for approval' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  submitForApproval(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.payrollsService.submitForApproval(id, user.id);
  }

  @Post(':id/approve')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Approve payroll',
    description: 'Change status from PENDING_APPROVAL to APPROVED',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  @ApiResponse({ status: 200, description: 'Payroll approved' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  approvePayroll(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApprovePayrollDto,
    @CurrentUser() user: any,
  ) {
    return this.payrollsService.approvePayroll(id, user.id, dto);
  }

  @Post(':id/reject')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Reject payroll',
    description: 'Change status from PENDING_APPROVAL to REJECTED',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  @ApiResponse({ status: 200, description: 'Payroll rejected' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  rejectPayroll(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectPayrollDto,
    @CurrentUser() user: any,
  ) {
    return this.payrollsService.rejectPayroll(id, user.id, dto);
  }

  @Post(':id/lock')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Lock payroll',
    description: 'Change status from APPROVED to LOCKED after payment',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  @ApiResponse({ status: 200, description: 'Payroll locked' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  lockPayroll(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.payrollsService.lockPayroll(id, user.id);
  }

  @Post(':id/unlock')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Unlock a locked payroll and reverse its loan recovery',
    description:
      'Returns the payroll to APPROVED so it can be corrected. Every PAID ' +
      'advance/loan recovery is REVERSED (never deleted) with a matching ' +
      'REVERSAL ledger entry, balances and schedule rows are restored, and any ' +
      'loan this run auto-closed is reopened. Refused when a LATER run has ' +
      'already recovered against the same loans, or when a locked revision ' +
      'descends from this payroll.',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  @ApiResponse({ status: 200, description: 'Payroll unlocked' })
  @ApiResponse({ status: 400, description: 'Payroll is not LOCKED' })
  @ApiResponse({
    status: 409,
    description: 'A later run or a locked revision must be reversed first',
  })
  unlockPayroll(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnlockPayrollDto,
    @CurrentUser() user: any,
  ) {
    return this.payrollsService.unlockPayroll(id, user.id, dto);
  }

  @Post(':id/create-revision')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Create revision',
    description: 'Create new version of LOCKED payroll',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  @ApiResponse({ status: 201, description: 'Revision created' })
  @ApiResponse({
    status: 400,
    description: 'Can only create revision from LOCKED payroll',
  })
  createRevision(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRevisionDto,
    @CurrentUser() user: any,
  ) {
    return this.payrollsService.createRevision(id, user.id, dto);
  }

  @Get(':id/history')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get approval history',
    description: 'Get timeline of all status changes',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  @ApiResponse({ status: 200, description: 'Approval history retrieved' })
  getApprovalHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.payrollsService.getApprovalHistory(id);
  }

  @Post('bulk-approve')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Bulk approve payrolls',
    description: 'Approve multiple payrolls at once',
  })
  @ApiResponse({ status: 200, description: 'Bulk approval completed' })
  bulkApprove(
    @Body() dto: BulkApproveDto,
    @CurrentUser() user: any,
  ) {
    return this.payrollsService.bulkApprove(dto.payrollIds, user.id, dto.notes);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Delete payroll',
    description: 'Delete a payroll cycle if it is not locked',
  })
  @ApiParam({ name: 'id', description: 'Payroll UUID' })
  @ApiResponse({ status: 200, description: 'Payroll deleted' })
  @ApiResponse({ status: 400, description: 'Cannot delete locked payroll' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.payrollsService.remove(id);
  }
}
