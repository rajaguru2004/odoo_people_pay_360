import {
  Body,
  Controller,
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
import { FinalSettlementsService } from './final-settlements.service';

/**
 * Final settlements.
 *
 * Approve and cancel are ADMIN-only, mirroring payroll approval: both decide
 * that money moves, and both are hard to reverse afterwards. Preparing and
 * adjusting are HR work.
 */
@ApiTags('Final settlement')
@ApiBearerAuth('JWT-auth')
@Controller('final-settlements')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('FinalSettlement')
export class FinalSettlementsController {
  constructor(private readonly service: FinalSettlementsService) {}

  @Get('stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Open settlements and the payout they represent' })
  stats() {
    return this.service.stats();
  }

  @Get('variants')
  @Roles('ADMIN', 'HR_MANAGER')
  variants() {
    return this.service.variants();
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  list(@Query('branchId') branchId?: string, @Query('status') status?: string) {
    return this.service.list(branchId, status);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Prepare a settlement',
    description:
      'Computes every line from the services that own each figure and stores ' +
      'the working. Refused when the employee already has an open settlement.',
  })
  create(@Body() dto: Record<string, unknown>, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.findOne(id, user);
  }

  @Patch(':id/lines/:lineId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Change one line',
    description:
      'A reason is required, and is stored with the figure. HR may change any ' +
      'line — they know things the system does not — but never silently.',
  })
  adjustLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: { amount: number; reason: string },
    @CurrentUser() user: any,
  ) {
    return this.service.adjustLine(id, lineId, dto, user);
  }

  @Post(':id/approve')
  @Roles('ADMIN')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.approve(id, user);
  }

  @Post(':id/pay')
  @Roles('ADMIN')
  markPaid(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.markPaid(id, user);
  }

  @Post(':id/cancel')
  @Roles('ADMIN')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.service.cancel(id, dto?.reason, user);
  }
}
