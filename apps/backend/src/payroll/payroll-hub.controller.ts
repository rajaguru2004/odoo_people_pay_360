import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PayrollHubService } from './payroll-hub.service';
import { PayrollHubQueryDto } from './dto/hub-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * The Payroll module's landing aggregate.
 *
 * `hub-summary` is a literal path on `/payroll`, and this controller holds
 * nothing else, so it must be listed before any controller that mounts a `:id`
 * segment under the same prefix.
 */
@ApiTags('Payroll')
@ApiBearerAuth('JWT-auth')
@Controller('payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayrollHubController {
  constructor(private readonly hubService: PayrollHubService) {}

  @Get('hub-summary')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'Payroll hub summary',
    description:
      'The current period and its predecessor, runs by status, locked money ' +
      '(APPROVED and PAID only), payroll coverage of the active workforce, an ' +
      'attention strip and a 6 or 12 month trend. One request; the frontend ' +
      'does no calendar arithmetic and no counting of its own.',
  })
  hubSummary(@Query() query: PayrollHubQueryDto) {
    return this.hubService.hubSummary(query.months ?? 6);
  }
}
