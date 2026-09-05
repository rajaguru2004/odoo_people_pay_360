import {
  Controller,
  Get,
  Query,
  Param,
  Res,
  UseGuards,
  ParseIntPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ExportService } from './export.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Export')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('export')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get('employees')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Export employee list to Excel' })
  @ApiQuery({ name: 'departmentId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'position', required: false })
  async exportEmployees(
    @Query('departmentId') departmentId?: string,
    @Query('status') status?: string,
    @Query('position') position?: string,
    @Res() res: Response = null as any,
  ) {
    const buffer = await this.exportService.exportEmployees({
      departmentId,
      status,
      position,
    });

    const filename = `Employee_List_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('attendance/:month/:year')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Export monthly attendance report' })
  @ApiParam({ name: 'month', type: Number })
  @ApiParam({ name: 'year', type: Number })
  @ApiQuery({ name: 'employeeId', required: false })
  async exportAttendance(
    @Param('month', ParseIntPipe) month: number,
    @Param('year', ParseIntPipe) year: number,
    // Unvalidated, this reached a `@db.Uuid` column and Prisma answered P2023 —
    // surfaced to the caller as a 500 carrying driver text. `optional: true`
    // keeps the whole-company export working when the parameter is absent.
    @Query('employeeId', new ParseUUIDPipe({ optional: true }))
    employeeId?: string,
    @Res() res: Response = null as any,
  ) {
    const buffer = await this.exportService.exportAttendance(
      month,
      year,
      employeeId,
    );

    const filename = `Attendance_${month}_${year}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('payroll/:payrollId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Export payroll to Excel' })
  @ApiParam({ name: 'payrollId', description: 'Payroll UUID' })
  async exportPayroll(
    @Param('payrollId') payrollId: string,
    @Res() res: Response = null as any,
  ) {
    const buffer = await this.exportService.exportPayroll(payrollId);

    const filename = `Payroll_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('contracts')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Export contract list to Excel' })
  @ApiQuery({ name: 'status', required: false, description: 'Comma-separated statuses' })
  @ApiQuery({ name: 'contractType', required: false, description: 'Comma-separated contract types' })
  @ApiQuery({ name: 'departmentId', required: false, description: 'Comma-separated department IDs' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'expiring', required: false, description: "'true' to limit to contracts expiring within 30 days" })
  async exportContracts(
    @Query('status') status?: string,
    @Query('contractType') contractType?: string,
    @Query('departmentId') departmentId?: string,
    @Query('search') search?: string,
    @Query('expiring') expiring?: string,
    @Res() res: Response = null as any,
  ) {
    const buffer = await this.exportService.exportContracts({
      status,
      contractType,
      departmentId,
      search,
      expiring,
    });

    const filename = `Contract_List_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('leave-requests')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Export leave request list' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'startDate', required: false, type: Date })
  @ApiQuery({ name: 'endDate', required: false, type: Date })
  async exportLeaveRequests(
    @Query('status') status?: string,
    @Query('employeeId') employeeId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Res() res: Response = null as any,
  ) {
    const buffer = await this.exportService.exportLeaveRequests({
      status,
      employeeId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    const filename = `Leave_Requests_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
