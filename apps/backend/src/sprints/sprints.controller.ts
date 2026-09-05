import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

import { SprintsService } from './sprints.service';
import { SprintPayloadGuard } from './sprint-payload.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ProjectPermissionGuard } from '../projects/rbac/project-permission.guard';
import { RequireProjectPermission } from '../projects/rbac/require-project-permission.decorator';
import { PROJECT_PERMISSIONS } from '../projects/rbac/permissions.constants';

/**
 * Finding R38, the empty-name half — `@IsString() @MaxLength(150)` let `''`
 * through, `slugify('')` is `''`, and the SECOND unnamed sprint in a project
 * then collided on `@@unique([projectId, slug])`. Trim first so `'   '` is the
 * empty name it is, rather than a name whose slug is empty.
 */
const TrimmedName = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

class CreateSprintDto {
  @IsUUID() projectId: string;
  @TrimmedName() @IsString() @IsNotEmpty() @MaxLength(150) name: string;
  @IsOptional() @IsString() goal?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}
/**
 * Finding R30 — `status` is deliberately absent. The generic PATCH used to drive
 * the field in ANY direction (COMPLETED -> PLANNING included), which is what made
 * every illegal transition reachable. Transitions now belong to the lifecycle
 * verbs alone, so `{status}` here is rejected by `forbidNonWhitelisted` as the
 * unknown property it is.
 */
class UpdateSprintDto {
  @IsOptional() @TrimmedName() @IsString() @IsNotEmpty() @MaxLength(150) name?: string;
  @IsOptional() @IsString() goal?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}

@ApiTags('Sprints')
@ApiBearerAuth('JWT-auth')
@Controller('sprints')
@UseGuards(JwtAuthGuard, RolesGuard, SprintPayloadGuard, ProjectPermissionGuard)
export class SprintsController {
  constructor(private readonly service: SprintsService) {}

  @Get()
  @ApiOperation({ summary: 'List sprints for a project' })
  findByProject(@Query('projectId') projectId: string, @Query('status') status?: string) {
    return this.service.findByProject(projectId, status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get sprint by ID' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @RequireProjectPermission(PROJECT_PERMISSIONS.SPRINT_MANAGE, {
    from: 'body',
    key: 'projectId',
  })
  @ApiOperation({ summary: 'Create sprint' })
  create(@Body() dto: CreateSprintDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequireProjectPermission(PROJECT_PERMISSIONS.SPRINT_MANAGE, { from: 'sprint' })
  @ApiOperation({ summary: 'Update sprint' })
  update(@Param('id') id: string, @Body() dto: UpdateSprintDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/start')
  @RequireProjectPermission(PROJECT_PERMISSIONS.SPRINT_MANAGE, { from: 'sprint' })
  @ApiOperation({ summary: 'Start sprint' })
  start(@Param('id') id: string) {
    return this.service.start(id);
  }

  @Patch(':id/complete')
  @RequireProjectPermission(PROJECT_PERMISSIONS.SPRINT_MANAGE, { from: 'sprint' })
  @ApiOperation({ summary: 'Complete sprint' })
  complete(@Param('id') id: string) {
    return this.service.complete(id);
  }

  /**
   * Finding R37, decided — cancelling is a verb of its own, gated by the same
   * `SPRINT_MANAGE` permission as start/complete/delete. Before this there was
   * no door into `SprintStatus.CANCELLED` at all: the generic PATCH used to
   * drive the field with no verb, no message and no side effects, and the R30
   * fix that removed `status` from `UpdateSprintDto` closed even that.
   */
  @Patch(':id/cancel')
  @RequireProjectPermission(PROJECT_PERMISSIONS.SPRINT_MANAGE, { from: 'sprint' })
  @ApiOperation({
    summary:
      'Cancel sprint (PLANNING or ACTIVE -> CANCELLED; open tasks return to the backlog)',
  })
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }

  @Delete(':id')
  @RequireProjectPermission(PROJECT_PERMISSIONS.SPRINT_MANAGE, { from: 'sprint' })
  @ApiOperation({ summary: 'Delete sprint' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
