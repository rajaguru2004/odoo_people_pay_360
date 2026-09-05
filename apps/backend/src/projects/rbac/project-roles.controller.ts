import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ProjectPermissionGuard } from './project-permission.guard';
import { RequireProjectPermission } from './require-project-permission.decorator';
import { PROJECT_PERMISSIONS, PROJECT_PERMISSION_CATALOG } from './permissions.constants';
import { ProjectRolesService } from './project-roles.service';
import {
  CreateProjectRoleDto,
  UpdateProjectRoleDto,
} from './dto/project-role.dto';

@ApiTags('Project Roles')
@ApiBearerAuth('JWT-auth')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard, ProjectPermissionGuard)
export class ProjectRolesController {
  constructor(private readonly service: ProjectRolesService) {}

  @Get('project-roles/catalog')
  @ApiOperation({ summary: 'List all assignable project permissions (grouped)' })
  catalog() {
    return { success: true, data: PROJECT_PERMISSION_CATALOG };
  }

  @Get('projects/:projectId/roles')
  @ApiOperation({ summary: 'List roles for a project' })
  @ApiParam({ name: 'projectId' })
  list(@Param('projectId') projectId: string) {
    return this.service.list(projectId);
  }

  @Post('projects/:projectId/roles')
  @RequireProjectPermission(PROJECT_PERMISSIONS.ROLE_MANAGE, {
    from: 'param',
    key: 'projectId',
  })
  @ApiOperation({ summary: 'Create a custom project role' })
  @ApiParam({ name: 'projectId' })
  create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateProjectRoleDto,
  ) {
    return this.service.create(projectId, dto);
  }

  @Patch('projects/:projectId/roles/:roleId')
  @RequireProjectPermission(PROJECT_PERMISSIONS.ROLE_MANAGE, {
    from: 'param',
    key: 'projectId',
  })
  @ApiOperation({ summary: 'Update a project role / its permissions' })
  @ApiParam({ name: 'projectId' })
  @ApiParam({ name: 'roleId' })
  update(
    @Param('projectId') projectId: string,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateProjectRoleDto,
  ) {
    return this.service.update(projectId, roleId, dto);
  }

  @Delete('projects/:projectId/roles/:roleId')
  @RequireProjectPermission(PROJECT_PERMISSIONS.ROLE_MANAGE, {
    from: 'param',
    key: 'projectId',
  })
  @ApiOperation({ summary: 'Delete a custom project role' })
  @ApiParam({ name: 'projectId' })
  @ApiParam({ name: 'roleId' })
  remove(
    @Param('projectId') projectId: string,
    @Param('roleId') roleId: string,
  ) {
    return this.service.remove(projectId, roleId);
  }
}
