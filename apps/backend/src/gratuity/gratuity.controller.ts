import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { GratuityService } from './gratuity.service';

/**
 * End-of-service benefits.
 *
 * Rule writes are ADMIN-only because a rule IS the calculation: changing
 * `daysPerYear` re-prices every future accrual and every settlement quoted from
 * it. Reads are open to anyone who may see the employee's record, because "what
 * would I get if I left today" is a question HR is asked constantly and
 * answering it is zero-risk.
 */
@ApiTags('Gratuity / End of service')
@ApiBearerAuth('JWT-auth')
@Controller('gratuity')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('GratuityRule')
export class GratuityController {
  constructor(private readonly gratuity: GratuityService) {}

  // Literal paths before `:id`, or `rules` is read as a rule id.
  @Get('rules')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'End-of-service rules, by country' })
  listRules(@Query('country') country?: string) {
    return this.gratuity.listRules(country);
  }

  @Post('rules')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Add a rule band',
    description:
      'Refused when it overlaps an existing active rule for the same country ' +
      'and nationality class: two overlapping rules make an entitlement depend ' +
      'on which row is read first.',
  })
  createRule(@Body() dto: Record<string, unknown>, @CurrentUser() user: any) {
    return this.gratuity.createRule(dto, user?.id);
  }

  @Patch('rules/:id')
  @Roles('ADMIN')
  updateRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: any,
  ) {
    return this.gratuity.updateRule(id, dto, user?.id);
  }

  @Delete('rules/:id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Retire a rule',
    description:
      'Deactivates rather than deletes: accruals reference the rule they were ' +
      'computed under, and one whose rule has vanished cannot be explained.',
  })
  deactivateRule(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    return this.gratuity.deactivateRule(id, user?.id);
  }

  @Get('nationality-classes')
  @Roles('ADMIN', 'HR_MANAGER')
  nationalityClasses() {
    return this.gratuity.nationalityClasses();
  }

  @Get('liability')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'What we would owe if everyone left today, by branch',
  })
  liability(
    @Query('branchId') branchId?: string,
    @Query('asOf') asOf?: string,
  ) {
    return this.gratuity.liability(
      branchId,
      asOf ? new Date(asOf) : undefined,
    );
  }

  @Get('my-entitlement')
  @ApiOperation({ summary: 'The signed-in employee’s own entitlement' })
  myEntitlement(@CurrentUser() user: any, @Query('asOf') asOf?: string) {
    // No id parameter at all, so this route cannot be pointed at anyone else.
    return this.gratuity.entitlementFor(
      user?.employeeId,
      user,
      asOf ? new Date(asOf) : undefined,
    );
  }

  @Get('employee/:employeeId/entitlement')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  entitlement(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @CurrentUser() user: any,
    @Query('asOf') asOf?: string,
  ) {
    return this.gratuity.entitlementFor(
      employeeId,
      user,
      asOf ? new Date(asOf) : undefined,
    );
  }

  @Get('employee/:employeeId/accruals')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  accruals(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @CurrentUser() user: any,
  ) {
    return this.gratuity.accrualsFor(employeeId, user);
  }
}
