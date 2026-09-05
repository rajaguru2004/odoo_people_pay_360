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
   * carries on the client and the same one `loan-reports.controller.ts` puts on
   * every report this payload draws from. MANAGER is a denial path, not a
   * narrowed one: the loan book and the budget position are company figures,
   * and there is no per-department version of them to hand back.
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
      "The organisation's exposure to employee money in one payload: the claim " +
      'queue and what was actually reimbursed this month, travel per diem, the ' +
      'loan book with its arrears aging, budget plan against spend, and twelve ' +
      'months of settled employee expense split by category.',
  })
  @ApiResponse({ status: 200, description: 'Finance hub summary' })
  @ApiResponse({ status: 403, description: 'Caller is not ADMIN or HR_MANAGER' })
  async hubSummary() {
    return this.hub.getHubSummary();
  }
}
