import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Delete,
  HttpCode,
  Patch,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AdvanceLoansService } from './advance-loans.service';
import { LoanNotificationService } from './loan-notification.service';
import { CreateAdvanceLoanDto } from './dto/create-advance-loan.dto';
import { CreateAdvanceLoanOnBehalfDto } from './dto/create-on-behalf.dto';
import {
  DisburseLoanDto,
  UpdateAdvanceLoanDto,
} from './dto/update-advance-loan.dto';
import { EligibilityCheckDto } from './dto/eligibility-check.dto';
import { ApproveAdvanceLoanDto } from './dto/approve-advance-loan.dto';
import { RejectAdvanceLoanDto } from './dto/reject-advance-loan.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { AllowReadOnly, LoanReadOnlyGuard } from './loan-readonly.guard';

@ApiTags('Salary Advances & Loans')
@ApiBearerAuth()
// LoanReadOnlyGuard closes every mutating verb on this controller to a caller
// the auditor settings declare read-only (§8). It is a no-op for GETs and for
// the routes marked @AllowReadOnly.
@UseGuards(JwtAuthGuard, RolesGuard, LoanReadOnlyGuard)
@Controller('advance-loans')
@AuditResource('AdvanceLoan')
export class AdvanceLoansController {
  constructor(
    private readonly advanceLoansService: AdvanceLoansService,
    private readonly loanNotifications: LoanNotificationService,
  ) {}

  @Post()
  @Roles('HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Create salary advance or loan request (admins administer, they do not submit)',
  })
  create(@CurrentUser() user: any, @Body() createDto: CreateAdvanceLoanDto) {
    return this.advanceLoansService.create(user.employeeId, createDto);
  }

  @Post('on-behalf')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'File a request for another employee',
    description:
      'For staff who cannot file for themselves — no portal account, or a ' +
      'paper form. Same eligibility gate as the ordinary path: an on-behalf ' +
      'request is not a way around a rule. The filer is recorded on the ' +
      'request, and the loan carries approvalSource = ON_BEHALF.',
  })
  createOnBehalf(
    @CurrentUser() user: any,
    @Body() dto: CreateAdvanceLoanOnBehalfDto,
  ) {
    const { employeeId, ...rest } = dto;
    return this.advanceLoansService.create(employeeId, rest as CreateAdvanceLoanDto, {
      userId: user.id,
    });
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List advance/loan requests' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED'],
  })
  @ApiQuery({ name: 'type', required: false, enum: ['ADVANCE', 'LOAN'] })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description:
      'Pagination is opt-in. Supply page/limit for the {data, meta, summary} ' +
      'envelope; omit both for the plain array older clients expect.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max 200' })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Matches employee name, employee code or reference number.',
  })
  findAll(
    @Query('status') status?: string,
    @Query('type') type?: string,
    // Optional UUID pipe rather than none: this value reaches a Prisma `where`
    // on a uuid column, so a malformed one used to answer a raw driver 500
    // instead of a 400 (same omission as §22, one layer along).
    @Query('employeeId', new ParseUUIDPipe({ optional: true }))
    employeeId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.advanceLoansService.findAll(
      status,
      employeeId,
      type,
      page !== undefined ? Number(page) : undefined,
      limit !== undefined ? Number(limit) : undefined,
      search,
    );
  }

  @Post('eligibility')
  @HttpCode(200)
  // A POST only because the question does not fit in a query string: it
  // persists nothing, so a read-only auditor may still ask it.
  @AllowReadOnly()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'What-if eligibility check',
    description:
      'Persists nothing. Returns one pass/fail/warn row per rule so the reason ' +
      'is visible BEFORE submit instead of arriving as an opaque 400.',
  })
  checkEligibility(@CurrentUser() user: any, @Body() dto: EligibilityCheckDto) {
    // A non-privileged caller may only ask about themselves.
    const employeeId =
      ['ADMIN', 'HR_MANAGER', 'MANAGER'].includes(user?.role) && dto.employeeId
        ? dto.employeeId
        : user.employeeId;
    return this.advanceLoansService.checkEligibility({
      employeeId,
      amount: dto.amount,
      installments: dto.installments,
      type: dto.type,
    });
  }

  @Get('pending')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Pending advance/loan requests for the current approver' })
  findPending(@CurrentUser() user: any) {
    return this.advanceLoansService.findPending(user);
  }

  @Get('my-requests')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'My advance/loan requests' })
  findMyRequests(@CurrentUser() user: any) {
    return this.advanceLoansService.findByEmployee(user.employeeId);
  }

  @Post('notifications/retry')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Re-send loan notices that failed',
    description:
      'Walks `advance_loan_notification_logs` for FAILED rows under the attempt ' +
      'limit. Before the log existed a failed notice left no trace at all, so ' +
      'there was nothing to retry and nothing to notice.',
  })
  @HttpCode(200)
  retryNotifications() {
    return this.loanNotifications.retryFailed();
  }

  @Get(':id/notifications')
  @AllowReadOnly()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'What was sent about this loan, and whether it arrived',
  })
  notificationHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.loanNotifications.history(id);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Advance/loan request details' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.advanceLoansService.findOne(id, user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Edit a request',
    description:
      'A DRAFT or PENDING request may be changed freely and is re-checked ' +
      'against the same eligibility gate it passed to be created. Once ' +
      'approved, only the reason and the recovery priority can be changed here ' +
      'and a reason for the change is required — everything else is a term ' +
      'somebody accepted, and altering those is a restructure. Send ' +
      '`expectedUpdatedAt` to be told when somebody else edited first, instead ' +
      'of silently overwriting them.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Body() dto: UpdateAdvanceLoanDto & { expectedUpdatedAt?: string },
  ) {
    return this.advanceLoansService.update(id, user, dto);
  }

  @Post(':id/submit')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submit a draft for approval',
    description:
      'Re-runs eligibility: a draft may have sat for weeks, and the rules it ' +
      'passed when it was written are not the rules it is judged by now.',
  })
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.advanceLoansService.submit(id, user);
  }

  @Post(':id/disburse')
  @Roles('ADMIN', 'HR_MANAGER')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record that the money was paid out',
    description:
      'APPROVED → DISBURSED. Stamps the date the money actually moved and what ' +
      'was actually handed over — principal minus any fee taken at source, ' +
      'which reduces the payout and never the debt. If the payout date differs ' +
      'from the agreed start, the schedule is rebuilt from reality.',
  })
  disburse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Body() dto?: DisburseLoanDto,
  ) {
    return this.advanceLoansService.disburse(id, user, dto ?? {});
  }

  @Post(':id/approve')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Approve advance/loan request' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Body() approveDto?: ApproveAdvanceLoanDto,
  ) {
    return this.advanceLoansService.approve(id, user, approveDto);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Reject advance/loan request' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Body() rejectDto: RejectAdvanceLoanDto,
  ) {
    return this.advanceLoansService.reject(id, user, rejectDto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Cancel advance/loan request' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.advanceLoansService.cancel(id, user.employeeId);
  }
}
