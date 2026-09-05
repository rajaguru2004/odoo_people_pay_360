import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PayrollDashboardService } from './payroll-dashboard.service';
import { PayrollDashboardQueryDto } from './dto/dashboard-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * The payroll analytics aggregate.
 *
 * `dashboard` is a literal path on `/payroll`, so this controller — like the
 * hub's and the reports' — must be listed before any controller that mounts a
 * `:id` segment under the same prefix.
 *
 * The same three roles as `/payroll/hub-summary`, which is what
 * `NavGroup.hubRoles` in the frontend already mirrors. A fourth role here would
 * mean the rail either hides a page somebody may open or offers one the server
 * refuses.
 */
@ApiTags('Payroll')
@ApiBearerAuth('JWT-auth')
@Controller('payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayrollDashboardController {
  constructor(private readonly dashboardService: PayrollDashboardService) {}

  @Get('dashboard')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'Payroll analytics aggregate',
    description:
      'Every visual on the analytics page in one request: KPIs, the money ' +
      'bridge, the trend with its running total, department and component ' +
      'rollups, attendance composition, run pipeline and the attention list. ' +
      'Filtered by period, department and employment type; an unoffered value ' +
      'is a 400 rather than a silent default. Money means APPROVED or PAID.',
  })
  dashboard(@Query() query: PayrollDashboardQueryDto) {
    return this.dashboardService.dashboard(query);
  }
}
