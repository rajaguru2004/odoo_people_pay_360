import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { WorkplaceHubService } from './workplace-hub.service';

@ApiTags('Workplace')
@ApiBearerAuth('JWT-auth')
@Controller('workplace')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkplaceHubController {
  constructor(private readonly hub: WorkplaceHubService) {}

  /**
   * ADMIN and HR_MANAGER only — the same gate `/dashboard/workplace` carries,
   * and the same one `/assets/summary`, `/assets/clearance/reports/outstanding`
   * and `/letters/stats` each carry.
   */
  @Get('hub-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Workplace module hub summary',
    description:
      'What the company owns and owes: the asset register with its exceptions ' +
      'and the value tied up in them, outstanding clearances, the letter desk ' +
      'with its issue turnaround, and twelve months of letter volume.',
  })
  @ApiResponse({ status: 200, description: 'Workplace hub summary' })
  @ApiResponse({ status: 403, description: 'Caller is not ADMIN or HR_MANAGER' })
  async hubSummary() {
    return this.hub.getHubSummary();
  }
}
