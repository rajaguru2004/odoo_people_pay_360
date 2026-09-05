import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectDto } from './dto/query-project.dto';
import {
  AddProjectMemberDto,
  UpdateProjectMemberDto,
} from './dto/project-member.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { ProjectPermissionGuard } from './rbac/project-permission.guard';
import {
  RequireProjectPermission,
  RequireProjectMembership,
  RequireProjectRead,
} from './rbac/require-project-permission.decorator';
import { ProjectAccessService } from './rbac/project-access.service';
import { PROJECT_PERMISSIONS } from './rbac/permissions.constants';

@ApiTags('Projects')
@ApiBearerAuth('JWT-auth')
@Controller('projects')
@UseGuards(JwtAuthGuard, RolesGuard, ProjectPermissionGuard)
@AuditResource('Project')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get project statistics' })
  getStats(@CurrentUser() user: any) {
    return this.projectsService.getStats(user);
  }

  /**
   * R12 — the escape hatch for the third branch of the owner-handover rule.
   *
   * When a hard-deleted owner has no heir (no other member carrying the `owner`
   * role, no still-active creator) the project keeps a null `ownerId` rather
   * than blocking the delete. That is only an acceptable outcome if somebody can
   * FIND the result, and before this route nothing in the API could answer
   * "which projects have nobody in charge?" — the state was reachable only by
   * reading the column. It sits ABOVE `@Get(':id')` because Nest matches in
   * declaration order and `ownerless` is not a UUID.
   */
  @Get('ownerless')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'List projects with no owner (admin remediation queue)',
    description:
      'Projects whose ownerId is null — normally the residue of a hard-deleted owner who had no eligible heir. Paired with the PROJECT_OWNER_ORPHANED audit row on each project.',
  })
  findOwnerless() {
    return this.projectsService.findOwnerless();
  }

  @Get()
  @ApiOperation({ summary: 'List projects (membership-scoped)' })
  findAll(@Query() query: QueryProjectDto, @CurrentUser() user: any) {
    return this.projectsService.findAll(query, user);
  }

  // R51 — the read door honours visibility. See `RequireProjectRead`.
  @Get('by-slug/:slug')
  @RequireProjectRead({ from: 'paramSlug', key: 'slug' })
  @ApiOperation({ summary: 'Get project by slug' })
  @ApiParam({ name: 'slug' })
  findBySlug(@Param('slug') slug: string, @CurrentUser() user: any) {
    return this.projectsService.findBySlug(slug, user);
  }

  @Get(':slug/charts')
  @RequireProjectRead({ from: 'paramSlug', key: 'slug' })
  @ApiOperation({ summary: 'Get project analytics charts' })
  @ApiParam({ name: 'slug' })
  getCharts(@Param('slug') slug: string) {
    return this.projectsService.getCharts(slug);
  }

  // R46, second half — a malformed id used to go straight into a Prisma `where`
  // on a @db.Uuid column and answer 500 for what is a client mistake.
  // `ParseUUIDPipe` makes it the 400 it always was.
  @Get(':id')
  @RequireProjectRead()
  @ApiOperation({ summary: 'Get project by ID' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.projectsService.findOne(id, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Create new project' })
  @ApiResponse({ status: 201, description: 'Project created' })
  create(@Body() dto: CreateProjectDto, @CurrentUser() user: any) {
    return this.projectsService.create(dto, user);
  }

  @Patch(':id')
  @RequireProjectPermission(PROJECT_PERMISSIONS.PROJECT_EDIT)
  @ApiOperation({ summary: 'Update project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: any,
  ) {
    return this.projectsService.update(id, dto, user);
  }

  @Delete(':id')
  @RequireProjectPermission(PROJECT_PERMISSIONS.PROJECT_DELETE)
  @ApiOperation({ summary: 'Soft delete project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.projectsService.remove(id, user);
  }

  @Post(':id/archive')
  @RequireProjectPermission(PROJECT_PERMISSIONS.PROJECT_ARCHIVE)
  @ApiOperation({ summary: 'Archive project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectsService.setArchived(id, true);
  }

  @Post(':id/unarchive')
  @RequireProjectPermission(PROJECT_PERMISSIONS.PROJECT_ARCHIVE)
  @ApiOperation({ summary: 'Unarchive project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  unarchive(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectsService.setArchived(id, false);
  }

  /**
   * Finding R9 — this was the one route on the controller with no project guard
   * at all: an EMPLOYEE who is a member of nothing got 200 on a PRIVATE project
   * they can neither list nor read.
   *
   * The guard is the same READ door as `GET /:id`, deliberately, and that is
   * what keeps the phase's OTHER result intact: the suite proved this route is
   * NOT an existence oracle, because `getAccess()` resolves a missing project
   * and a forbidden one through the same null branch, so a real PRIVATE id and
   * a random uuid returned byte-identical bodies (`PRJ-API-14`). A guard that
   * answered 404 for the unknown id and 403 for the private one would have
   * closed a small hole by opening a bigger one. `RequireProjectRead` cannot:
   * a non-member of a PRIVATE project and a caller naming a uuid that does not
   * exist both fail the same membership test, then both fail the same
   * visibility lookup, and both get the identical 403 body.
   *
   * A non-member of an INTERNAL/PUBLIC project is still admitted and still
   * truthfully told they hold no permissions — which is the answer the UI needs
   * to project its controls now that it can open the project at all.
   */
  @Get(':id/my-permissions')
  @RequireProjectRead()
  @ApiOperation({ summary: "Get current user's resolved permissions for a project" })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  async myPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    const access = await this.projectAccess.getAccess(id, user);
    return { success: true, data: access };
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  /**
   * R51, the deliberate boundary. The activity log is NOT part of the project
   * record — it is audit history, naming who did what and when — so it stays
   * membership-only whatever the visibility. Widening the read door was about
   * the project a user can already see in their list, not about handing every
   * authenticated user a project's audit trail.
   */
  @Get(':id/activity')
  @RequireProjectMembership()
  @ApiOperation({
    summary: 'Get project activity log (project + task audit events)',
  })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  getActivity(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: { page?: number; limit?: number },
  ) {
    return this.projectsService.getActivity(id, query);
  }

  /**
   * R51 — the roster travels inside `GET /:id` already (`findOne` includes
   * `members`), so refusing this route separately protected nothing and
   * recreated the same see-it-then-be-refused shape one tab over. It follows
   * the record it belongs to. Every WRITE on members below keeps
   * `MEMBER_MANAGE`.
   */
  @Get(':id/members')
  @RequireProjectRead()
  @ApiOperation({ summary: 'List project members' })
  getMembers(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectsService.getMembers(id);
  }

  @Post(':id/members')
  @RequireProjectPermission(PROJECT_PERMISSIONS.MEMBER_MANAGE)
  @ApiOperation({ summary: 'Add member(s) to project' })
  addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddProjectMemberDto,
  ) {
    return this.projectsService.addMember(id, dto);
  }

  @Patch(':id/members/:memberId')
  @RequireProjectPermission(PROJECT_PERMISSIONS.MEMBER_MANAGE)
  @ApiOperation({ summary: 'Update a member role' })
  updateMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateProjectMemberDto,
  ) {
    return this.projectsService.updateMember(id, memberId, dto);
  }

  @Delete(':id/members/:memberId')
  @RequireProjectPermission(PROJECT_PERMISSIONS.MEMBER_MANAGE)
  @ApiOperation({ summary: 'Remove a member from project' })
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.projectsService.removeMember(id, memberId);
  }
}
