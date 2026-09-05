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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GarnishmentsService } from './garnishments.service';
import {
  CreateGarnishmentDto,
  UpdateGarnishmentDto,
  WaiveCarryForwardDto,
} from './dto/garnishment.dto';

/**
 * Court-ordered attachments of earnings.
 *
 * ADMIN and HR only, and audited: an order takes money out of somebody's pay
 * ahead of every voluntary deduction, and the employee cannot see or dispute it
 * here.
 */
@ApiTags('Payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('garnishments')
@AuditResource('Garnishment')
export class GarnishmentsController {
  constructor(private readonly service: GarnishmentsService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List garnishment orders' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'activeOnly', required: false })
  findAll(
    @Query('employeeId', new ParseUUIDPipe({ optional: true })) employeeId?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.service.findAll({ employeeId, activeOnly: activeOnly === 'true' });
  }

  @Get('employee/:employeeId/carry-forwards')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Balances a run could not recover, carried to the next payroll',
  })
  carryForwards(
    @CurrentUser() user: any,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.service.carryForwardsFor(employeeId, user);
  }

  @Get(':id/collections')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'What was taken under one order, newest first' })
  collections(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.collectionHistory(id);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'One garnishment order' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Patch('carry-forwards/:id/waive')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Write off an outstanding carried balance, with a reason',
  })
  waive(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WaiveCarryForwardDto,
  ) {
    return this.service.waive(id, dto.reason, user);
  }

  @Patch(':id/revoke')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Stop an order from the next run, keeping what it already took',
  })
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.revoke(id);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Record a court order against an employee’s earnings',
    description:
      'Recovered ahead of every voluntary deduction, because payroll subtracts ' +
      'it from the pool before the recovery allocator sees the money.',
  })
  create(@Body() dto: CreateGarnishmentDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Amend an order' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGarnishmentDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Delete an order nothing has been collected under',
    description:
      'Once money has been taken the order is closed rather than deleted — the ' +
      'record of what was deducted under a court order is not ours to remove.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
