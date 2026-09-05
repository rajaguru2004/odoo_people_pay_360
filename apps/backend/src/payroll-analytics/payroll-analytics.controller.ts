import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PayrollAnalyticsService } from './payroll-analytics.service';
import { PayrollDashboardQueryDto } from './dto/payroll-dashboard-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * `/payroll/dashboard` — the analytics page's one endpoint.
 *
 * A separate controller on the `payroll` prefix rather than a route on
 * `PayrollsController` (`/payrolls`), because the two answer different
 * questions: that one serves runs and payslips as RECORDS, this one serves the
 * period as a SHAPE. Bolting an aggregate onto the record controller would put
 * a 400-line read behind the same `:id` param route that lists payslips, and
 * `/payrolls/dashboard` would be parsed as a run id.
 *
 * The guard matches the page's own `ProtectedRoute`, which asks for
 * VIEW_ALL_PAYROLL: this reads company-wide cost by department and by employee,
 * so it answers the same question the payslip list does and carries the same
 * audience. A MANAGER is refused here even though they may open `/dashboard`.
 */
@ApiTags('Payroll analytics')
@Controller('payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class PayrollAnalyticsController {
  constructor(private readonly service: PayrollAnalyticsService) {}

  @Get('dashboard')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Payroll analytics summary',
    description:
      'One aggregate for the whole analytics page: money, trend, departments, ' +
      'component mix, gross-to-net bridge, run funnel, attendance mix and the ' +
      'attention queue — all for a single resolved period.',
  })
  @ApiResponse({ status: 200, description: 'Summary retrieved successfully' })
  async summary(
    @Query() query: PayrollDashboardQueryDto,
    @CurrentUser() user: any,
  ) {
    // Enveloped here, not in the service, which keeps returning the bare
    // aggregate. Callers read this through the axios interceptor, which hands
    // back the whole body — a bare payload arrives as an envelope with no
    // `data`, the hook's `.data` reads undefined, and react-query rejects an
    // undefined result as a failed query. The page then prints its "could not
    // be loaded" banner over a response that arrived intact.
    return { success: true, data: await this.service.summary(query, user) };
  }
}
