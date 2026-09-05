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
import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  IsArray,
  ArrayNotEmpty,
  IsBoolean,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProjectStatusesService } from './project-statuses.service';
import { ProjectStatusPayloadGuard } from './project-status-payload.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ProjectPermissionGuard } from '../projects/rbac/project-permission.guard';
import { RequireProjectPermission } from '../projects/rbac/require-project-permission.decorator';
import { PROJECT_PERMISSIONS } from '../projects/rbac/permissions.constants';

const CATEGORIES = ['TODO', 'IN_PROGRESS', 'DONE'];

class CreateStatusDto {
  @IsUUID() projectId: string;
  @IsString() @MaxLength(100) name: string;
  @IsOptional() @IsString() @MaxLength(9) color?: string;
  @IsOptional() @IsEnum(CATEGORIES) category?: string;
}
class UpdateStatusDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(9) color?: string;
  @IsOptional() @IsEnum(CATEGORIES) category?: string;
  /**
   * Finding R35 — the default column may not be deleted, so there has to be a
   * way to move the flag. Setting it demotes whichever column holds it now.
   */
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
class ReorderItem {
  @IsUUID() id: string;
  @IsInt() position: number;
}
class ReorderDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ReorderItem)
  items: ReorderItem[];
}

@ApiTags('Project Statuses')
@ApiBearerAuth('JWT-auth')
@Controller('project-statuses')
@UseGuards(
  JwtAuthGuard,
  RolesGuard,
  ProjectStatusPayloadGuard,
  ProjectPermissionGuard,
)
export class ProjectStatusesController {
  constructor(private readonly service: ProjectStatusesService) {}

  @Get()
  @ApiOperation({ summary: 'List workflow statuses (columns) for a project' })
  findByProject(@Query('projectId') projectId: string) {
    return this.service.findByProject(projectId);
  }

  @Post()
  @RequireProjectPermission(PROJECT_PERMISSIONS.STATUS_MANAGE, {
    from: 'body',
    key: 'projectId',
  })
  @ApiOperation({ summary: 'Create a workflow status (column)' })
  create(@Body() dto: CreateStatusDto) {
    return this.service.create(dto);
  }

  @Patch('reorder')
  @RequireProjectPermission(PROJECT_PERMISSIONS.STATUS_MANAGE, {
    from: 'statusItems',
  })
  @ApiOperation({ summary: 'Reorder workflow statuses' })
  reorder(@Body() dto: ReorderDto) {
    return this.service.reorder(dto.items);
  }

  @Patch(':id')
  @RequireProjectPermission(PROJECT_PERMISSIONS.STATUS_MANAGE, { from: 'status' })
  @ApiOperation({ summary: 'Update a workflow status' })
  update(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @RequireProjectPermission(PROJECT_PERMISSIONS.STATUS_MANAGE, { from: 'status' })
  @ApiOperation({ summary: 'Soft delete a workflow status (must have no tasks)' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
