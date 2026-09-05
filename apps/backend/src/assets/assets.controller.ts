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
import { AssetsService } from './assets.service';
import { AssetAssignmentsService } from './asset-assignments.service';
import { ClearanceService } from './clearance.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { AssignAssetDto } from './dto/assign-asset.dto';
import { ReturnAssetDto } from './dto/return-asset.dto';
import { AcknowledgeAssetDto } from './dto/acknowledge-asset.dto';

@ApiTags('Assets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assets')
@AuditResource('AssetItem')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly assignments: AssetAssignmentsService,
    private readonly clearance: ClearanceService,
  ) {}

  // ── ESS ────────────────────────────────────────────────────────────────────
  // Declared before the `:id` routes so 'my' is not swallowed as an id.

  @Get('my')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Assets assigned to the current user' })
  myAssets(@CurrentUser() user: any, @Query('openOnly') openOnly?: string) {
    if (!user?.employeeId) return { success: true, data: [] };
    return this.assignments.findByEmployee(user.employeeId, openOnly === 'true');
  }

  @Post('assignments/:id/acknowledge')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Digitally acknowledge receipt of an assigned asset' })
  acknowledge(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcknowledgeAssetDto,
  ) {
    return this.assignments.acknowledge(id, dto, user);
  }

  // ── Register ───────────────────────────────────────────────────────────────

  @Get('summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Asset register totals' })
  summary() {
    return this.assets.getSummary();
  }

  @Get('assignments/open')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Assets currently held, optionally by employee' })
  openAssignments(
    @CurrentUser() user: any,
    @Query('employeeId') employeeId?: string,
  ) {
    return this.assignments.findOpen(user, employeeId);
  }

  @Get('clearance/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Whether an employee can be offboarded, and what they still hold',
  })
  clearanceStatus(
    @CurrentUser() user: any,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    // The principal is passed through so the service can answer the two
    // authorization questions this door used to skip (R26/R27/R28): the branch
    // envelope (404), and a MANAGER's department scope (403).
    return this.clearance
      .getClearanceStatus(employeeId, user)
      .then((data) => ({ success: true, data }));
  }

  @Get('clearance/reports/outstanding')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Assets still held by employees who are no longer active',
  })
  outstanding() {
    return this.clearance.getOutstandingForInactive();
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'List assets' })
  findAll(@Query() query: QueryAssetsDto) {
    return this.assets.findAll(query);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Add an asset to the register' })
  create(@CurrentUser() user: any, @Body() dto: CreateAssetDto) {
    return this.assets.create(dto, user.id);
  }

  @Post('assignments')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Assign an asset to an employee' })
  assign(@CurrentUser() user: any, @Body() dto: AssignAssetDto) {
    return this.assignments.assign(dto, user.id);
  }

  @Post('assignments/:id/return')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Record the return of an assigned asset' })
  returnAsset(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnAssetDto,
  ) {
    return this.assignments.return(id, dto, user.id);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Asset detail with its full custody history' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.findOne(id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update an asset' })
  update(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssetDto,
  ) {
    return this.assets.update(id, dto, user.id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete an asset (only when nobody holds it)' })
  remove(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.remove(id, user.id);
  }
}
