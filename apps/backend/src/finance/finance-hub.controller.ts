import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { FinanceHubService } from './finance-hub.service';

@ApiTags('Finance')
@ApiBearerAuth('JWT-auth')
@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FinanceHubController {
  constructor(private readonly hub: FinanceHubService) {}

  /**
   * ADMIN and HR_MANAGER only — the same gate `/dashboard/finance` already
   * carries on the client. MANAGER is a denial path, not a narrowed one: the
   * budget position is a company figure, and there is no per-department version
   * of it to hand back.
   *
   * No period parameter. These hubs render without the Today/Week/Month/Year
   * control, so there is no window for a caller to choose and nothing to
   * validate — which is also why there is no `anchor=2026-13-45` trap here.
   */
  @Get('hub-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Finance module hub summary',
    description:
      'The travel request queue and the budget plan against spend, with the ' +
      "previous month's utilisation as a baseline, in one payload.",
  })
  @ApiResponse({ status: 200, description: 'Finance hub summary' })
  @ApiResponse({ status: 403, description: 'Caller is not ADMIN or HR_MANAGER' })
  async hubSummary() {
    return this.hub.getHubSummary();
  }
}
