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
import { DevModeGuard } from '../dev-mode/dev-mode.guard';
import { RequireDeveloper } from '../dev-mode/require-developer.decorator';
import { isSelfServiceOnly } from '../common/utils/self-service.util';
import { ProfileTemplateService } from './profile-template.service';
import { ProfileTemplateResolverService } from './profile-template-resolver.service';
import {
  ActiveTemplateQueryDto,
  AdoptTemplateDto,
  ListTemplatesQueryDto,
  RenameTemplateDto,
  ReorderDto,
  UpsertFieldDto,
  UpsertSectionDto,
} from './dto/profile-template.dto';
import { TemplateMode } from './profile-template.types';

/**
 * Developer mode is applied per route, NOT to the class. Designing the employee
 * form is operator work, but the READ routes are the hot path that renders that
 * form for everyone — `GET active` is reachable by EMPLOYEE and `GET resolve/:id`
 * by HR. Gating the class would blank out the employee profile page for the
 * whole tenant. Only the writes (every ADMIN-only route below) are gated.
 */
@ApiTags('Employee Profile Templates')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard, DevModeGuard)
@AuditResource('ProfileTemplate')
@Controller('profile-templates')
export class ProfileTemplateController {
  constructor(
    private readonly templates: ProfileTemplateService,
    private readonly resolver: ProfileTemplateResolverService,
  ) {}

  // ── Runtime (hot path) ────────────────────────────────────────────────────

  /**
   * The template the caller should render, already filtered to what their role
   * may see. Every authenticated user reaches this — an employee needs it to
   * render their own profile form.
   *
   * Declared before `:id` so "active" is never parsed as a template id.
   */
  @Get('active')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Active template for the caller, projected by role' })
  async active(
    @Query() query: ActiveTemplateQueryDto,
    @CurrentUser() user: any,
  ) {
    // Self only when the caller is looking at their own record. A privileged
    // user opening their own profile still gets the full field set; the SELF
    // projection is about restricted roles, not about whose record it is.
    const isSelf =
      isSelfServiceOnly(user) &&
      (!query.employeeId || query.employeeId === user?.employeeId);

    const data = await this.resolver.resolveForActor(
      { role: user?.role ?? 'EMPLOYEE', isSelf },
      {
        branchId: query.branchId ?? user?.branchId ?? null,
        mode: (query.mode as TemplateMode) ?? 'EDIT',
      },
    );
    return { success: true, data };
  }

  @Get('resolve/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Which template applies to an employee, and why' })
  async resolveFor(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    const data = await this.resolver.resolveForEmployee(employeeId);
    return { success: true, data };
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  @Get('presets')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Country presets available to adopt' })
  presets() {
    return this.templates.presets();
  }

  @Get('presets/:country')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Full definition of one country preset' })
  preset(@Param('country') country: string) {
    return this.templates.preset(country);
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List configured templates' })
  list(@Query() query: ListTemplatesQueryDto) {
    return this.templates.list(query);
  }

  @Post('adopt')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Copy a country preset into a new company or branch template' })
  adopt(@Body() dto: AdoptTemplateDto, @CurrentUser() user: any) {
    return this.templates.adopt(dto, user?.id);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'One template with its sections and fields' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.findOne(id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Rename a template' })
  rename(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.templates.rename(id, dto.name, user?.id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Archive a template (soft; nothing is deleted)' })
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.templates.archive(id, user?.id);
  }

  @Post(':id/reseed')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Re-apply the shipped preset; never overwrites customizations' })
  reseed(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.templates.reseed(id, user?.id);
  }

  // ── Sections ──────────────────────────────────────────────────────────────

  @Post(':id/sections')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Add a section' })
  createSection(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertSectionDto,
    @CurrentUser() user: any,
  ) {
    return this.templates.upsertSection(id, dto, undefined, user?.id);
  }

  @Post(':id/sections/reorder')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Reorder sections' })
  reorderSections(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderDto,
    @CurrentUser() user: any,
  ) {
    return this.templates.reorderSections(id, dto, user?.id);
  }

  @Patch(':id/sections/:sectionId')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Update a section' })
  updateSection(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @Body() dto: UpsertSectionDto,
    @CurrentUser() user: any,
  ) {
    return this.templates.upsertSection(id, dto, sectionId, user?.id);
  }

  @Delete(':id/sections/:sectionId')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Hide a section (soft; fields and values are kept)' })
  removeSection(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sectionId', ParseUUIDPipe) sectionId: string,
    @CurrentUser() user: any,
  ) {
    return this.templates.removeSection(id, sectionId, user?.id);
  }

  // ── Fields ────────────────────────────────────────────────────────────────

  @Post(':id/fields')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Add a custom field (always stored as JSONB)' })
  createField(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertFieldDto,
    @CurrentUser() user: any,
  ) {
    return this.templates.createField(id, dto, user?.id);
  }

  @Post(':id/fields/reorder')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Reorder fields, optionally moving them to a section' })
  reorderFields(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderDto,
    @CurrentUser() user: any,
  ) {
    return this.templates.reorderFields(id, dto, user?.id);
  }

  @Patch(':id/fields/:fieldId')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Update a field' })
  updateField(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() dto: UpsertFieldDto,
    @CurrentUser() user: any,
  ) {
    return this.templates.updateField(id, fieldId, dto, user?.id);
  }

  @Delete(':id/fields/:fieldId')
  @Roles('ADMIN')
  @RequireDeveloper()
  @ApiOperation({ summary: 'Hide a field (soft; stored values are kept)' })
  removeField(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @CurrentUser() user: any,
  ) {
    return this.templates.removeField(id, fieldId, user?.id);
  }
}
