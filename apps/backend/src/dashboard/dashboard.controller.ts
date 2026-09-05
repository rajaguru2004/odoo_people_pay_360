import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { DashboardService } from './dashboard.service';
import { DashboardOverviewQueryDto } from './dto/dashboard-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

/**
 * The main dashboard's aggregate.
 *
 * ALL FIVE roles, on purpose. `/dashboard` is the one route every account can
 * open — everybody holds `VIEW_DASHBOARD` — so refusing the endpoint by role
 * would refuse the landing page to the people it was built for.
 *
 * The narrowing therefore happens in the SERVICE, against `@CurrentUser`: which
 * blocks come back depends on who is asking, and a section the caller may not
 * see is absent from the payload rather than zeroed. This is the `attendances`
 * idiom — whether an answer is allowed depends on whose record it is, and a
 * decorator cannot see that.
 */
@ApiTags('Dashboard')
@ApiBearerAuth('JWT-auth')
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'The main dashboard, in one request',
    description:
      'Workforce, attendance, payroll, approvals, compliance and the ' +
      "caller's own corner — each present only if the caller's role is " +
      'entitled to it, and ABSENT rather than zeroed when it is not. ' +
      '`sections` lists what arrived. `me` is always present. `months` must ' +
      'be 6 or 12; anything else is a 400 rather than a silent default.',
  })
  overview(
    @CurrentUser() user: Principal,
    @Query() query: DashboardOverviewQueryDto,
  ) {
    return this.dashboardService.overview(user, query);
  }
}
