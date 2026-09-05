import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { PayrollsService } from './payrolls.service';
import { ListMyPayslipsDto, YtdSummaryDto } from './dto/my-payslips.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

/**
 * The read side of payroll: what an employee is shown about their own pay.
 *
 * None of these routes carries `@Roles`, and that is not an oversight. Every
 * one of them is a question somebody is entitled to ask about themselves, so
 * the narrowing happens in the service where the subject of the question is
 * known — a decorator can say which ROLE may ask, never WHOSE payslip is being
 * asked for. The run engine (creating, calculating, approving and paying a run)
 * is not part of this controller.
 */
@ApiTags('Payroll')
@ApiBearerAuth('JWT-auth')
@Controller('payrolls')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayrollsController {
  constructor(private readonly payrollsService: PayrollsService) {}

  // Every literal segment below is declared before the parameterised routes.
  // Express matches in declaration order, so `my-payslips/list` reaching a
  // `:employeeId` route first would be answered with a 400 from ParseUUIDPipe
  // rather than with the caller's payslips.

  @Get('my-payslips/list')
  @ApiOperation({
    summary: 'My payslips',
    description:
      'The most recent published payslips for the signed-in employee, newest first. Pass a year for a full calendar year instead.',
  })
  findMine(@CurrentUser() user: Principal, @Query() query: ListMyPayslipsDto) {
    return this.payrollsService.findMine(user, query.year);
  }

  @Get('my-ytd-summary')
  @ApiOperation({
    summary: 'My year to date',
    description:
      'Gross, deductions and net for the year, counting paid runs only.',
  })
  ytdSummary(@CurrentUser() user: Principal, @Query() query: YtdSummaryDto) {
    return this.payrollsService.ytdSummary(
      user,
      query.year ?? new Date().getUTCFullYear(),
    );
  }

  @Get('my-payslips/:id')
  @ApiOperation({
    summary: 'One of my payslips',
    description: 'The payslip with its earnings and deduction lines.',
  })
  findMineById(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payrollsService.findMineById(user, id);
  }

  @Get('salary-structure/:employeeId')
  @ApiOperation({
    summary: 'The standing salary structure',
    description:
      'An employee may read their own; anyone else needs a payroll role.',
  })
  salaryStructure(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.payrollsService.salaryStructure(user, employeeId);
  }

  @Get('payslip/:employeeId/:month/:year')
  @ApiOperation({
    summary: 'A payslip for one period',
    description:
      'An employee may read their own; anyone else needs a payroll role. Only the payroll office sees a run that has not been approved.',
  })
  @ApiParam({ name: 'month', description: '1–12' })
  findForPeriod(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('month', ParseIntPipe) month: number,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.payrollsService.findForPeriod(user, employeeId, month, year);
  }
}
