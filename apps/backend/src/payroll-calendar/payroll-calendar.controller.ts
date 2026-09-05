import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { PayrollCalendarService } from './payroll-calendar.service';

@ApiTags('Payroll calendar')
@ApiBearerAuth('JWT-auth')
@Controller('payroll-calendars')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('PayrollCalendar')
export class PayrollCalendarController {
  constructor(private readonly service: PayrollCalendarService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  list(@Query('branchId') branchId?: string) {
    return this.service.list(branchId);
  }

  @Get('window')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'The window one period covers',
    description:
      'Falls back to the calendar month when the feature is off or no calendar ' +
      'exists, so a caller never has to know which.',
  })
  window(
    @Query('branchId') branchId: string,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    return this.service
      .windowForPeriod(branchId || null, Number(month), Number(year))
      .then((data) => ({ success: true, data }));
  }

  @Get('branch/:branchId/:year')
  @Roles('ADMIN', 'HR_MANAGER')
  forBranch(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('year') year: string,
  ) {
    return this.service.findForBranch(branchId, Number(year));
  }

  @Post()
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Create or replace a branch’s calendar for one year',
    description:
      'Whole-year at a time. A calendar with three of twelve months configured ' +
      'is worse than none, because a run in an unconfigured month behaves ' +
      'differently from its neighbours without saying so.',
  })
  upsert(@Body() dto: any, @CurrentUser() user: any) {
    return this.service.upsertYear(dto, user);
  }

  @Patch(':id/periods/:month/enforcement')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Turn cut-off enforcement on or off for one period',
    description:
      'Per period rather than globally, so a branch can pilot enforcement ' +
      'without changing behaviour for anyone else.',
  })
  setEnforcement(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('month') month: string,
    @Body() dto: { enforceCutOff: boolean },
    @CurrentUser() user: any,
  ) {
    return this.service.setEnforcement(
      id,
      Number(month),
      Boolean(dto?.enforceCutOff),
      user,
    );
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user);
  }
}
