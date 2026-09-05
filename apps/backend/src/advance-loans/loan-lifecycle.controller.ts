import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { LoanReadOnlyGuard } from './loan-readonly.guard';
import { LoanLifecycleService } from './loan-lifecycle.service';
import { LoanScheduleService } from './loan-schedule.service';
import {
  LoanTopupDto,
  LoanRateChangeDto,
  CloseLoanDto,
  ConvertAdvanceDto,
  ForecloseLoanDto,
  HoldLoanDto,
  PrepayLoanDto,
  ReinstateLoanDto,
  ResumeLoanDto,
  SkipInstallmentDto,
  WaiveLoanDto,
  WriteOffLoanDto,
} from './dto/loan-lifecycle.dto';

/**
 * Post-approval money operations.
 *
 * Registered BEFORE AdvanceLoansController in the module so its literal path
 * segments are not swallowed by that controller's `GET :id`. Every `:id` is a
 * ParseUUIDPipe so a probe 400s instead of reaching Prisma.
 *
 * The static @Roles here is a coarse gate; the fine-grained, settings-driven
 * check (write-off and waiver roles) lives in the service, because a decorator
 * cannot read DB-backed configuration.
 *
 * LoanReadOnlyGuard is the same idea one level up: it reads the auditor
 * settings and refuses every mutating verb below for a caller declared
 * read-only (§8). The two GETs here are untouched by it.
 */
@ApiTags('Advance & Loan — lifecycle')
@ApiBearerAuth('JWT-auth')
@Controller('advance-loans')
@UseGuards(JwtAuthGuard, RolesGuard, LoanReadOnlyGuard)
@AuditResource('AdvanceLoan')
export class LoanLifecycleController {
  constructor(
    private readonly lifecycle: LoanLifecycleService,
    private readonly schedules: LoanScheduleService,
  ) {}

  @Get(':id/schedule')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Live amortization schedule',
    description:
      'Only rows of the CURRENT schedule version. Superseded rows are retained ' +
      'in the database as the regeneration audit trail but are never returned.',
  })
  @ApiParam({ name: 'id', description: 'Advance/Loan request UUID' })
  schedule(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.schedules.listLive(id, user);
  }

  @Get(':id/payoff-quote')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'What it would cost to settle this loan today' })
  @ApiParam({ name: 'id', description: 'Advance/Loan request UUID' })
  payoffQuote(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.lifecycle.payoffQuote(id, user);
  }

  @Post(':id/prepay')
  // EMPLOYEE is admitted at the decorator and then narrowed in the service:
  // `loan_employee_self_prepay` decides whether they may record one at all, and
  // they may only ever do it against their OWN loan. Before this the route was
  // ADMIN/HR-only, so a borrower who paid at the counter could not record it —
  // the setting existed and was read by nothing.
  @Roles('ADMIN', 'HR_MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Record a payment made outside payroll',
    description:
      'Applied in the branch’s allocation order. A payment that clears the ' +
      'balance closes the loan as an early closure. Refused while an unlocked ' +
      'payroll already holds an instalment for this loan. An employee may ' +
      'record one against their own loan only, and only while ' +
      '`loan_employee_self_prepay` is on.',
  })
  @ApiResponse({ status: 409, description: 'A payroll run is in progress' })
  prepay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PrepayLoanDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.prepay(id, user, dto);
  }

  @Post(':id/topup')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Replace this loan with a larger one',
    description:
      'One movement, not two: the new principal settles the old balance and ' +
      'only the difference reaches the employee. The old loan closes as ' +
      'TOPPED_UP with a TOPUP_SETTLEMENT ledger row — enum members that had no ' +
      'producer until now. Refused when the top-up is not larger than what is ' +
      'still owed, which would be a part-payment (use prepay).',
  })
  topup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LoanTopupDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.topup(id, user, dto);
  }

  @Post(':id/rate-change')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Change the interest on a running loan',
    description:
      'Writes a `LoanRateChange` row — a model that existed with no code behind ' +
      'it — and re-plans only what is still owed: instalments money has already ' +
      'touched are never re-priced. KEEP_TENURE moves the instalment and holds ' +
      'the end date; KEEP_EMI holds the instalment and moves the end date.',
  })
  rateChange(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LoanRateChangeDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.rateChange(id, user, dto);
  }

  @Get(':id/rate-history')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Every recorded repricing of this loan' })
  rateHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.lifecycle.rateHistory(id);
  }

  @Post(':id/foreclose')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Close a fully-repaid loan, optionally waiving remaining interest' })
  foreclose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ForecloseLoanDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.foreclose(id, user, dto);
  }

  @Post(':id/close')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Manually close a loan',
    description:
      'Only when the residual is within loan_rounding_tolerance — the ' +
      '"0.01 left after the final EMI" case. Anything larger must go through ' +
      'prepay, waive or write-off.',
  })
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseLoanDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.close(id, user, dto);
  }

  @Post(':id/write-off')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Write off company money (restricted)',
    description:
      'Role list comes from advance_loan_writeoff_roles, default ADMIN. ' +
      'Always audited and always reversible via /reinstate.',
  })
  writeOff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WriteOffLoanDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.writeOff(id, user, dto);
  }

  @Post(':id/reinstate')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Undo a write-off and resume recovery' })
  reinstate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReinstateLoanDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.reinstate(id, user, dto);
  }

  @Post(':id/waive')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Forgive interest, principal, or both' })
  waive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WaiveLoanDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.waive(id, user, dto);
  }

  @Post(':id/hold')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Pause payroll recovery for this loan' })
  hold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HoldLoanDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.hold(id, user, dto);
  }

  @Post(':id/resume')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Resume payroll recovery' })
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResumeLoanDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.resume(id, user, dto);
  }

  @Post(':id/skip-installment')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Skip one planned instalment',
    description:
      'EXTEND re-amortizes the still-owed balance (under reducing balance an ' +
      'extra period accrues extra interest, so this is not a date shift). ' +
      'FORGIVE waives the instalment.',
  })
  skipInstallment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SkipInstallmentDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.skipInstallment(id, user, dto);
  }

  @Post(':id/convert')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Convert an outstanding advance into an instalment loan',
    description:
      'Creates a NEW request that re-enters approval, rather than mutating the ' +
      'advance — the already-recovered history stays attached to the terms it ' +
      'was recovered under. The pair nets to zero via CONVERSION transactions.',
  })
  convert(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConvertAdvanceDto,
    @CurrentUser() user: any,
  ) {
    return this.lifecycle.convertToLoan(id, user, dto);
  }
}
