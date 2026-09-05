import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PayrollRunsService } from './payroll-runs.service';
import { PayrollExportService } from './payroll-export.service';
import { CreatePayrollRunDto } from './dto/create-payroll-run.dto';
import { PreflightPayrollRunDto } from './dto/preflight-payroll-run.dto';
import { RejectPayrollRunDto } from './dto/reject-payroll-run.dto';
import { ListPayrollRunsDto } from './dto/list-payroll-runs.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

/**
 * Payroll runs.
 *
 * The role split is not invented here: `utils/permissions.ts` gives a
 * PAYROLL_OFFICER `MANAGE_PAYROLL` and deliberately NOT `APPROVE_PAYROLL` —
 * the person who runs payroll must not be the person who signs it off. The
 * decorators below mirror that exactly, because a rail that offers a button the
 * server refuses is a defect `docs/MIGRATION.md` §8 already records once.
 */
@ApiTags('Payroll')
@ApiBearerAuth('JWT-auth')
@Controller('payroll-runs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
export class PayrollRunsController {
  constructor(
    private readonly runs: PayrollRunsService,
    private readonly exporter: PayrollExportService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List payroll runs' })
  findAll(@Query() query: ListPayrollRunsDto) {
    return this.runs.findAll(query);
  }

  // Declared before `:id`. Express matches in declaration order, so with `:id`
  // first the literal segment would be handed to ParseUUIDPipe and every
  // pre-flight would answer 400.
  @Post('preflight')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'Everything a run for this period would refuse. Writes nothing.',
  })
  preflight(@Body() dto: PreflightPayrollRunDto) {
    return this.runs.preflight(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One run with its payslips' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.findOne(id);
  }

  @Get(':id/export')
  @ApiOperation({ summary: 'Download the run as a spreadsheet' })
  async export(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { filename, buffer } = await this.exporter.runWorkbook(id);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.length),
    });
    return res.end(buffer);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({ summary: 'Open a draft run for a period' })
  create(@Body() dto: CreatePayrollRunDto) {
    return this.runs.create(dto);
  }

  @Post(':id/calculate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({ summary: 'Generate this run’s payslips' })
  calculate(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.calculate(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  // ADMIN only. Separation of duties: the officer who ran it does not sign it.
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Approve a calculated run' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.runs.approve(id, user.id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Send a calculated run back to draft with a reason',
  })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectPayrollRunDto,
  ) {
    return this.runs.reject(id, dto.reason);
  }

  @Post(':id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Record that an approved run has been paid' })
  markPaid(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.markPaid(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({ summary: 'Cancel a run that has not been paid' })
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.cancel(id);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete a draft run' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.remove(id);
  }
}
