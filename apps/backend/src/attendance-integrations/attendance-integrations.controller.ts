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
import { AuditResource } from '../audit/audit-resource.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { DevModeGuard } from '../dev-mode/dev-mode.guard';
import { RequireDeveloper } from '../dev-mode/require-developer.decorator';
import { AttendanceIntegrationsService } from './attendance-integrations.service';
import { AttendanceSyncService } from './attendance-sync.service';
import {
  BulkMapEmployeesDto,
  MapEmployeeDto,
  PreviewSyncDto,
  RunSyncDto,
  TestIntegrationDto,
} from './dto/run-sync.dto';
import {
  CreateIntegrationDto,
  UpdateIntegrationDto,
} from './dto/upsert-integration.dto';
import { CONFLICT_POLICY_LABELS } from './types/sync.types';

/**
 * Admin surface for external attendance providers.
 *
 * ADMIN only at the class level (the same blanket pattern as
 * CopilotSettingsController) — these endpoints hold vendor credentials and can
 * rewrite attendance history, which drives payroll.
 *
 * @AuditResource makes the global AuditInterceptor capture every write here.
 *
 * Now developer mode on top of ADMIN: these hold third-party vendor credentials
 * and a sync can rewrite attendance history, which flows straight into payroll.
 */
@ApiTags('attendance-integrations')
@ApiBearerAuth('JWT-auth')
@Controller('attendance-integrations')
@UseGuards(JwtAuthGuard, RolesGuard, DevModeGuard)
@Roles('ADMIN')
@RequireDeveloper()
@AuditResource('AttendanceIntegration')
export class AttendanceIntegrationsController {
  constructor(
    private readonly integrations: AttendanceIntegrationsService,
    private readonly sync: AttendanceSyncService,
  ) {}

  // ─────────────────────────── Catalogue ───────────────────────────

  @Get('providers')
  @ApiOperation({
    summary: 'List available attendance providers and the config fields each needs',
  })
  listProviders() {
    return {
      success: true,
      data: {
        providers: this.integrations.listProviders(),
        conflictPolicies: Object.entries(CONFLICT_POLICY_LABELS).map(
          ([value, label]) => ({ value, label }),
        ),
      },
    };
  }

  // ─────────────────────────── CRUD ───────────────────────────

  @Get()
  @ApiOperation({ summary: 'List attendance integrations (secrets masked)' })
  async findAll() {
    return { success: true, data: await this.integrations.findAll() };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one attendance integration (secret masked)' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.integrations.findOne(id) };
  }

  @Post()
  @ApiOperation({ summary: 'Connect an external attendance provider to a branch' })
  async create(@Body() dto: CreateIntegrationDto) {
    return {
      success: true,
      message: 'Integration created',
      data: await this.integrations.create(dto),
    };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an integration. Omit authSecret to keep the stored one.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIntegrationDto,
  ) {
    return {
      success: true,
      message: 'Integration updated',
      data: await this.integrations.update(id, dto),
    };
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove an integration. Attendance already synced is kept.',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.remove(id);
  }

  // ─────────────────────────── Operations ───────────────────────────

  @Post(':id/test')
  @ApiOperation({
    summary: 'Live-test the connection (accepts unsaved form overrides)',
  })
  async test(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestIntegrationDto,
  ) {
    return { success: true, data: await this.integrations.testConnection(id, dto) };
  }

  @Post(':id/preview')
  @ApiOperation({
    summary: 'Dry run — fetch, map and diff a date range without writing anything',
  })
  async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewSyncDto,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.sync.preview(id, dto.from, dto.to, user?.id),
    };
  }

  @Post(':id/sync')
  @ApiOperation({ summary: 'Run a sync now for a date range (max 31 days)' })
  async runSync(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RunSyncDto,
    @CurrentUser() user: any,
  ) {
    return {
      success: true,
      data: await this.sync.runManualSync(id, dto.from, dto.to, user?.id),
    };
  }

  // ─────────────────────── Employee mapping ───────────────────────

  @Get(':id/unmapped')
  @ApiOperation({
    summary: 'External employee ids seen in recent runs with no employee linked',
  })
  async unmapped(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.integrations.listUnmapped(id) };
  }

  @Get(':id/mapped')
  @ApiOperation({ summary: 'Employees in this branch that carry an external id' })
  async mapped(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.integrations.listMapped(id) };
  }

  @Get(':id/candidates')
  @ApiOperation({
    summary: 'Unlinked ACTIVE employees in this branch, for the mapping picker',
  })
  async candidates(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('search') search?: string,
  ) {
    return {
      success: true,
      data: await this.integrations.listCandidates(id, search),
    };
  }

  @Post(':id/map')
  @ApiOperation({ summary: 'Link (or unlink) an external employee id to an employee' })
  async map(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MapEmployeeDto,
  ) {
    return this.integrations.mapEmployee(id, dto);
  }

  @Get(':id/suggestions')
  @ApiOperation({
    summary:
      'Propose an employee for each unmapped external id, scored by name. Suggestions only — never auto-applied.',
  })
  async suggestions(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.integrations.suggestMappings(id) };
  }

  @Post(':id/map/bulk')
  @ApiOperation({
    summary: 'Apply many links at once; each entry succeeds or fails independently',
  })
  async bulkMap(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BulkMapEmployeesDto,
  ) {
    return {
      success: true,
      data: await this.integrations.bulkMapEmployees(id, dto.entries),
    };
  }

  // ─────────────────────────── History ───────────────────────────

  @Get(':id/runs')
  @ApiOperation({ summary: 'Recent sync runs, newest first' })
  async runs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return {
      success: true,
      data: await this.integrations.listRuns(id, Number(limit) || 20),
    };
  }

  @Get(':id/runs/:runId')
  @ApiOperation({ summary: 'One sync run including its per-record details' })
  async run(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return { success: true, data: await this.integrations.getRun(id, runId) };
  }
}
