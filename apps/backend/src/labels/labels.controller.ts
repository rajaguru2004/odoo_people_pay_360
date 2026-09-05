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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, MaxLength } from 'class-validator';
import { LabelsService } from './labels.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ProjectPermissionGuard } from '../projects/rbac/project-permission.guard';
import {
  RequireProjectMembership,
  RequireProjectPermission,
} from '../projects/rbac/require-project-permission.decorator';
import { PROJECT_PERMISSIONS } from '../projects/rbac/permissions.constants';

class CreateLabelDto {
  @IsString() @MaxLength(100) name: string;
  @IsOptional() @IsString() @MaxLength(9) color?: string;
  @IsUUID() projectId: string;
}
class UpdateLabelDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(9) color?: string;
}

/**
 * Labels are a project's own taxonomy — sprint names, client names,
 * workstreams — and they were the third controller with no project guard at
 * all (finding R21/R60): a MANAGER who was a member of nothing wrote into a
 * PRIVATE project's label set, and any EMPLOYEE read it back.
 *
 * Read needs membership; writes need TASK_EDIT, the permission that already
 * governs the task metadata a label IS.
 */
@ApiTags('Labels')
@ApiBearerAuth('JWT-auth')
@Controller('labels')
@UseGuards(JwtAuthGuard, RolesGuard, ProjectPermissionGuard)
export class LabelsController {
  constructor(private readonly labelsService: LabelsService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectMembership({
    from: 'query',
    key: 'projectId',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'List labels for a project' })
  findAll(@Query('projectId') projectId: string) {
    return this.labelsService.findAll(projectId);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_EDIT, {
    from: 'body',
    key: 'projectId',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Create a label' })
  create(@Body() dto: CreateLabelDto) {
    return this.labelsService.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_EDIT, {
    from: 'label',
    key: 'id',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Update a label' })
  update(@Param('id') id: string, @Body() dto: UpdateLabelDto) {
    return this.labelsService.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_EDIT, {
    from: 'label',
    key: 'id',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Delete a label' })
  remove(@Param('id') id: string) {
    return this.labelsService.remove(id);
  }
}
