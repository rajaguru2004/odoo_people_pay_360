import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { OrganizationService } from './organization.service';
import { HubSummaryQueryDto } from './dto/hub-summary.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Organization')
@ApiBearerAuth('JWT-auth')
@Controller('organization')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get('hub-summary')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Organisation hub summary',
    description:
      'Headcount, branch and department distribution, management coverage, ' +
      'the change-request queue and a joiner/leaver trend over 6 or 12 months.',
  })
  hubSummary(@Query() query: HubSummaryQueryDto) {
    return this.organizationService.hubSummary(query.months ?? 6);
  }
}
