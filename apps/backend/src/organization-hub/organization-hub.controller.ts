import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { OrganizationHubService } from './organization-hub.service';

@ApiTags('Organization')
@ApiBearerAuth('JWT-auth')
@Controller('organization')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Department')
export class OrganizationHubController {
  constructor(private readonly hub: OrganizationHubService) {}

  /**
   * ADMIN and HR_MANAGER only, matching the `ProtectedRoute` guard on
   * `/dashboard/organization` and the existing `/employees/lifecycle-stats`
   * precedent. MANAGER is a denial path here rather than a narrowing case: the
   * payload is org-wide governance, and a per-department view of "which
   * departments have no head" is not a question a department head asks.
   */
  @Get('hub-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Organization module hub summary',
    description:
      'Governance of the structure in one payload: headcount by department and ' +
      'branch, what has nobody in charge of it, the change-request queue by ' +
      'status, and the workforce trend over the trailing window.',
  })
  @ApiQuery({
    name: 'months',
    required: false,
    enum: [6, 12],
    description: 'Trend window. Anything else is refused rather than defaulted.',
  })
  @ApiResponse({ status: 200, description: 'Hub summary retrieved' })
  @ApiResponse({ status: 400, description: 'months outside the offered window' })
  async getHubSummary(@Query('months') months?: string) {
    return { success: true, data: await this.hub.getSummary(months) };
  }
}
