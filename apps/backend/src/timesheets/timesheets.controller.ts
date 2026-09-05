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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { TimesheetsService } from './timesheets.service';
import {
  CreateTimesheetDto,
  UpdateTimesheetDto,
  ApproveRejectTimesheetDto,
} from './dto/create-timesheet.dto';
import { QueryTimesheetDto } from './dto/query-timesheet.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Timesheets')
@ApiBearerAuth('JWT-auth')
@Controller('timesheets')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Timesheet')
export class TimesheetsController {
  constructor(private readonly service: TimesheetsService) {}

  // Specific routes BEFORE :id to avoid conflicts
  @Get('my')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get my timesheets' })
  findMine(@CurrentUser() user: any, @Query() query: QueryTimesheetDto) {
    return this.service.findMine(user, query);
  }

  @Get('pending')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get pending timesheets awaiting approval' })
  findPending(@CurrentUser() user: any) {
    return this.service.findPending(user);
  }

  @Get('summary/daily')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Daily timesheet summary' })
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD' })
  getDailySummary(@CurrentUser() user: any, @Query('date') date?: string) {
    return this.service.getDailySummary(user, date);
  }

  @Get('summary/weekly')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Weekly timesheet summary' })
  @ApiQuery({
    name: 'weekStart',
    required: false,
    description: 'YYYY-MM-DD (Monday)',
  })
  getWeeklySummary(
    @CurrentUser() user: any,
    @Query('weekStart') weekStart?: string,
  ) {
    return this.service.getWeeklySummary(user, weekStart);
  }

  @Get('summary/monthly')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Monthly timesheet summary' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'month', required: false, type: Number })
  getMonthlySummary(
    @CurrentUser() user: any,
    @Query('year') year?: number,
    @Query('month') month?: number,
  ) {
    return this.service.getMonthlySummary(
      user,
      year ? Number(year) : undefined,
      month ? Number(month) : undefined,
    );
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get all timesheets (manager-scoped by dept)' })
  findAll(@Query() query: QueryTimesheetDto, @CurrentUser() user: any) {
    return this.service.findAll(query, user);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get timesheet by ID' })
  @ApiParam({ name: 'id', description: 'Timesheet UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOne(id, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Create draft timesheet' })
  create(@Body() dto: CreateTimesheetDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Update draft timesheet (owner only)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTimesheetDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Delete draft timesheet (owner only)' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user);
  }

  @Post(':id/submit')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Submit timesheet for approval' })
  submit(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.submit(id, user);
  }

  @Post(':id/approve')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Approve submitted timesheet' })
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveRejectTimesheetDto,
    @CurrentUser() user: any,
  ) {
    return this.service.approve(id, dto, user);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Reject submitted timesheet' })
  reject(
    @Param('id') id: string,
    @Body() dto: ApproveRejectTimesheetDto,
    @CurrentUser() user: any,
  ) {
    return this.service.reject(id, dto, user);
  }
}
