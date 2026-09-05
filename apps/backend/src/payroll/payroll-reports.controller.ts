import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PayrollReportsService } from './payroll-reports.service';
import {
  CostReportQueryDto,
  RunReportQueryDto,
  YtdReportQueryDto,
} from './dto/report-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * The payroll reports.
 *
 * Every route reads `APPROVED` and `PAID` runs only, and naming an unlocked run
 * is a 400 with a sentence rather than a page of unapproved figures.
 *
 * All four paths are literal under `payroll/reports`, so this controller must
 * be declared before any controller that mounts a `:id` segment on `payroll`.
 */
@ApiTags('Payroll')
@ApiBearerAuth('JWT-auth')
@Controller('payroll/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayrollReportsController {
  constructor(private readonly reportsService: PayrollReportsService) {}

  @Get('register')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'Payroll register',
    description:
      'Every payslip in a locked run, with its lines exactly as they were ' +
      'snapshotted at generation.',
  })
  register(@Query() query: RunReportQueryDto) {
    return this.reportsService.register(query.runId);
  }

  @Get('cost')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'Cost by department or branch',
    description:
      'Gross, deductions, net and employer cost per group, with each share ' +
      'of the total. A share is null, never 0, when there is nothing ' +
      'to divide by.',
  })
  cost(@Query() query: CostReportQueryDto) {
    return this.reportsService.cost(query.runId, query.groupBy ?? 'department');
  }

  @Get('statutory')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'Statutory deductions and employer contributions',
    description:
      'Totals per line code and label, grouped in the database on the ' +
      'payslip snapshot rather than through the component behind it.',
  })
  statutory(@Query() query: RunReportQueryDto) {
    return this.reportsService.statutory(query.runId);
  }

  @Get('ytd/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'One employee year-to-date',
    description:
      'Calendar-year totals across locked runs only, with a per-period ' +
      'breakdown whose labels arrive formatted by the server.',
  })
  ytd(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: YtdReportQueryDto,
  ) {
    return this.reportsService.ytd(employeeId, query.year);
  }
}
