import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { PayrollReportsService } from './payroll-reports.service';

/**
 * Payroll reporting.
 *
 * `@AuditResource` is declared even though every route here is a GET, which the
 * audit interceptor skips: it costs nothing today and means the first mutating
 * route somebody adds is audited on arrival rather than landing untracked. The
 * same reasoning as `LoanReportsController`, and the same reason it is worth
 * copying.
 */
@ApiTags('Payroll — reports')
@ApiBearerAuth('JWT-auth')
@Controller('payrolls/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Payroll')
export class PayrollReportsController {
  constructor(private readonly reports: PayrollReportsService) {}

  @Get('register')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Every item in one period',
    description:
      'LOCKED runs only — a figure in a DRAFT run has not been paid to anybody. ' +
      'Carries the itemised breakdown when itemisation is on.',
  })
  register(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reports.register(Number(month), Number(year), branchId);
  }

  @Get('cost')
  @Roles('ADMIN', 'HR_MANAGER')
  cost(
    @Query('year') year: string,
    @Query('groupBy') groupBy: 'department' | 'branch',
    @Query('month') month?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reports.cost(
      Number(year),
      groupBy === 'branch' ? 'branch' : 'department',
      month ? Number(month) : undefined,
      branchId,
    );
  }

  @Get('statutory-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'What was withheld, and under which heading',
    description:
      'Prefers the itemised split (PF apart from ESI, income tax apart from ' +
      'professional tax) and falls back to the combined columns when ' +
      'itemisation has never been switched on.',
  })
  statutory(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reports.statutorySummary(Number(month), Number(year), branchId);
  }

  @Get('ytd/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  ytd(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('year') year: string,
  ) {
    return this.reports.ytd(employeeId, Number(year));
  }

  @Get('gratuity-liability')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'What we would owe if everyone left today',
    description:
      'Provision and entitlement are reported as two different numbers, because ' +
      'they are two different things.',
  })
  gratuityLiability(@Query('branchId') branchId?: string) {
    return this.reports.gratuityLiability(branchId);
  }

  @Get('variance')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Month-on-month movement',
    description:
      'Joiners and leavers are split out of the delta, so a headcount change is ' +
      'never read as a pay change.',
  })
  variance(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.reports.variance(Number(month), Number(year), branchId);
  }
}
