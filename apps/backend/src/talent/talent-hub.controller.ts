import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { TalentHubService } from './talent-hub.service';

@ApiTags('Talent')
@ApiBearerAuth('JWT-auth')
@Controller('talent')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TalentHubController {
  constructor(private readonly hub: TalentHubService) {}

  /**
   * ADMIN and HR_MANAGER only — the same gate `/dashboard/talent` carries, and
   * the same one `/grievances/stats`, `/training/stats` and `/appraisal/stats`
   * each carry individually. MANAGER is a denial path: grievances can be
   * confidential and can be raised AGAINST a manager, so an org-wide talent
   * payload is not something a line manager may hold.
   */
  @Get('hub-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Talent module hub summary',
    description:
      'How people are developed, recognised and heard, in one payload: appraisal ' +
      'progress for the run in flight, training completion against nominations ' +
      'that became obligations, the grievance queue with its aging, and twelve ' +
      'months of recognition against correction.',
  })
  @ApiResponse({ status: 200, description: 'Talent hub summary' })
  @ApiResponse({ status: 403, description: 'Caller is not ADMIN or HR_MANAGER' })
  async hubSummary() {
    return this.hub.getHubSummary();
  }
}
