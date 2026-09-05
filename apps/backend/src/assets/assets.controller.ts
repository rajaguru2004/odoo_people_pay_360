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
import { UserRole } from '@prisma/client';
import { AssetsService } from './assets.service';
import { AssetAssignmentsService } from './asset-assignments.service';
import { ClearanceService } from './clearance.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { AssignAssetDto } from './dto/assign-asset.dto';
import { ReturnAssetDto } from './dto/return-asset.dto';
import { AcknowledgeAssetDto } from './dto/acknowledge-asset.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Assets')
@ApiBearerAuth('JWT-auth')
@Controller('assets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly assignments: AssetAssignmentsService,
    private readonly clearance: ClearanceService,
  ) {}

  // The literal routes come first so 'my', 'summary' and 'assignments' are
  // never swallowed by `:id`.

  @Get('my')
  @ApiOperation({ summary: 'Assets assigned to the caller' })
  @ApiQuery({ name: 'openOnly', required: false, type: Boolean })
  myAssets(@CurrentUser() user: Principal, @Query('openOnly') openOnly?: string) {
    if (!user?.employeeId) return [];
    return this.assignments.findByEmployee(user.employeeId, openOnly === 'true');
  }

  @Post('assignments/:id/acknowledge')
  @ApiOperation({ summary: 'Confirm you received an assigned asset' })
  acknowledge(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcknowledgeAssetDto,
  ) {
    return this.assignments.acknowledge(id, dto, user);
  }

  @Get('summary')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Register totals' })
  summary() {
    return this.assets.getSummary();
  }

  @Get('assignments/open')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'Everything currently held, optionally by one person' })
  @ApiQuery({ name: 'employeeId', required: false })
  openAssignments(
    @CurrentUser() user: Principal,
    @Query('employeeId') employeeId?: string,
  ) {
    return this.assignments.findOpen(user, employeeId);
  }

  @Get('clearance/reports/outstanding')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Assets still held by people who have left' })
  outstanding() {
    return this.clearance.getOutstandingForInactive();
  }

  @Get('clearance/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({
    summary: 'Whether an employee can be offboarded, and what they still hold',
  })
  clearanceStatus(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.clearance.getClearanceStatus(employeeId, user);
  }

  @Post('assignments')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Hand an asset to an employee' })
  assign(@CurrentUser() user: Principal, @Body() dto: AssignAssetDto) {
    return this.assignments.assign(dto, user.id);
  }

  @Post('assignments/:id/return')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Record the return of an assigned asset' })
  returnAsset(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnAssetDto,
  ) {
    return this.assignments.return(id, dto, user.id);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'The asset register' })
  findAll(@Query() query: QueryAssetsDto) {
    return this.assets.findAll(query);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Add an asset to the register' })
  create(@Body() dto: CreateAssetDto) {
    return this.assets.create(dto);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'One asset and its full custody history' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.findOne(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Edit an asset' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssetDto,
  ) {
    return this.assets.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Delete an asset that has never been in anybody’s hands',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.remove(id);
  }
}
