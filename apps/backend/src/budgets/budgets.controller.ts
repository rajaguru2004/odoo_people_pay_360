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
import { BudgetsService } from './budgets.service';
import {
  CreateBudgetDto,
  SetBudgetStatusDto,
} from './dto/create-budget.dto';
import { UpsertBudgetLineDto } from './dto/upsert-budget-line.dto';

@ApiTags('Budgets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('budgets')
@AuditResource('Budget')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get('variance-summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Variance across every active budget',
    description: 'Runs the per-budget report and adds it up — one implementation, not two.',
  })
  varianceSummary(@Query('fiscalYear') fiscalYear?: string) {
    return this.budgets.varianceSummary(fiscalYear ? Number(fiscalYear) : undefined);
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List budgets' })
  findAll(
    @Query('fiscalYear') fiscalYear?: string,
    @Query('status') status?: string,
  ) {
    return this.budgets.findAll({
      fiscalYear: fiscalYear ? Number(fiscalYear) : undefined,
      status,
    });
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Create a budget for a fiscal period' })
  create(@CurrentUser() user: any, @Body() dto: CreateBudgetDto) {
    return this.budgets.create(dto, user.id);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Budget detail with its lines' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.findOne(id);
  }

  @Get(':id/variance')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary:
      'Planned vs Committed vs Actual vs Remaining, plus any real spend with no budget line to attach to',
  })
  variance(@Param('id', ParseUUIDPipe) id: string) {
    return this.budgets.varianceReport(id);
  }

  @Patch(':id/status')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'DRAFT | ACTIVE | CLOSED — only an ACTIVE budget attracts commitments',
  })
  setStatus(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetBudgetStatusDto,
  ) {
    return this.budgets.setStatus(id, dto.status, user.id);
  }

  @Post(':id/lines')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary:
      'Create or update a budget line. Omit departmentId for the company-wide fallback line.',
  })
  upsertLine(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertBudgetLineDto,
  ) {
    return this.budgets.upsertLine(id, dto, user.id);
  }

  @Delete(':id/lines/:lineId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete a budget line (blocked while it has open commitments)' })
  removeLine(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
  ) {
    return this.budgets.removeLine(id, lineId, user.id);
  }
}
