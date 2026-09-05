import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { LoanReadOnlyGuard } from './loan-readonly.guard';
import { LoanReportsService } from './loan-reports.service';

/**
 * Loan book reporting.
 *
 * @AuditResource is declared even though every route here is a GET, which the
 * audit interceptor skips: it costs nothing today and means the first mutating
 * route someone adds here is audited on arrival instead of landing untracked
 * (§10). Same reasoning for LoanReadOnlyGuard — a read-only auditor is the
 * intended audience of these reports, so the guard is inert on all six GETs,
 * but a future POST is closed to them by default rather than by memory.
 *
 * The UUID pipes on the filter params are not decoration: `outstanding` passes
 * them into a raw query that casts with `::uuid`, so an unvalidated value
 * answers a driver error instead of a clean 400.
 */
@ApiTags('Advance & Loan — reports')
@ApiBearerAuth('JWT-auth')
@Controller('advance-loans/reports')
@UseGuards(JwtAuthGuard, RolesGuard, LoanReadOnlyGuard)
@AuditResource('AdvanceLoan')
export class LoanReportsController {
  constructor(private readonly reports: LoanReportsService) {}

  @Get('outstanding')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Outstanding balance per employee',
    description:
      'Repaid is recomputed from PAID ledger rows, so `asOf` genuinely reports ' +
      'a historical balance instead of today\'s. Amounts sitting in an unlocked ' +
      'payroll appear under `inFlight`, never inside `outstanding`.',
  })
  @ApiQuery({ name: 'asOf', required: false, description: 'Historical date; future dates are rejected' })
  @ApiQuery({ name: 'departmentId', required: false })
  @ApiQuery({ name: 'loanTypeId', required: false })
  @ApiQuery({ name: 'type', required: false, enum: ['ADVANCE', 'LOAN'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max 200' })
  outstanding(
    @Query('asOf') asOf?: string,
    @Query('departmentId', new ParseUUIDPipe({ optional: true }))
    departmentId?: string,
    @Query('loanTypeId', new ParseUUIDPipe({ optional: true }))
    loanTypeId?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reports.outstanding({
      asOf,
      departmentId,
      loanTypeId,
      type,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('portfolio')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Book composition by status and type' })
  portfolio() {
    return this.reports.portfolio();
  }

  @Get('emi-due')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Instalments scheduled for a cycle' })
  @ApiQuery({ name: 'month', required: false, type: Number })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'includeHeld', required: false, type: Boolean })
  emiDue(
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('includeHeld') includeHeld?: string,
  ) {
    return this.reports.emiDue({
      month: month ? Number(month) : undefined,
      year: year ? Number(year) : undefined,
      includeHeld: includeHeld === 'true',
    });
  }

  @Get('overdue')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Overdue instalments, aged 1-30 / 31-60 / 61-90 / 90+' })
  @ApiQuery({ name: 'asOf', required: false })
  overdue(@Query('asOf') asOf?: string) {
    return this.reports.overdue({ asOf });
  }

  @Get('interest-earned')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Interest actually collected, by cycle',
    description:
      'Summed from PAID ledger rows. Never recomputed from the schedule — a ' +
      'reschedule rewrites future rows and would restate reported history.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  interestEarned(@Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.interestEarned({ from, to });
  }

  // Declared BEFORE the :employeeId route so the literal segment is not
  // swallowed by the param route.
  @Get('my-statement')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'My own loan statement',
    description:
      'Takes the employee from the token — there is no id parameter, so this ' +
      'route has no direct-object-reference surface at all.',
  })
  myStatement(@CurrentUser() user: any) {
    return this.reports.statement(user.employeeId);
  }

  @Get('employee/:employeeId/statement')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Full statement for one employee' })
  statement(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.reports.statement(employeeId);
  }
}
