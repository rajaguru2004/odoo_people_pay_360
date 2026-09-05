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
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { TaskCommentsService } from './task-comments.service';
import {
  CreateTaskCommentDto,
  UpdateTaskCommentDto,
} from './dto/create-task-comment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProjectPermissionGuard } from '../projects/rbac/project-permission.guard';
import {
  RequireProjectMembership,
  RequireProjectPermission,
} from '../projects/rbac/require-project-permission.decorator';
import { PROJECT_PERMISSIONS } from '../projects/rbac/permissions.constants';

/**
 * A task's discussion is project data.
 *
 * Finding R21: this controller carried `JwtAuthGuard, RolesGuard` and a
 * global-role list that admitted every authenticated user, while every other
 * project-scoped write in the module is `@RequireProjectPermission`-gated. A
 * complete outsider — 403 on `GET /projects/:id` — read a private task's whole
 * thread including author emails, and posted into it.
 *
 * The project now decides:
 *  · READ  — membership (any role, viewer included: the catalogue calls viewer
 *    "read-only access to the project", and a thread is something to read).
 *  · WRITE — TASK_STATUS_UPDATE, the permission the `member` preset carries and
 *    `viewer` does not. It is the catalogue's line between someone who works on
 *    the project's tasks and someone who only watches them; there is no
 *    separate COMMENT key, and inventing one would put the backend out of step
 *    with the frontend mirror.
 *  · EDIT / DELETE of an existing comment — membership plus the service's own
 *    "your own comment" rule, which is the real gate there.
 */
@ApiTags('Task Comments')
@ApiBearerAuth('JWT-auth')
@Controller('task-comments')
@UseGuards(JwtAuthGuard, RolesGuard, ProjectPermissionGuard)
export class TaskCommentsController {
  constructor(private readonly service: TaskCommentsService) {}

  @Get('task/:taskId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectMembership({
    from: 'task',
    key: 'taskId',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Get all comments for a task' })
  @ApiParam({ name: 'taskId', description: 'Task UUID' })
  findByTask(@Param('taskId') taskId: string) {
    return this.service.findByTask(taskId);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_STATUS_UPDATE, {
    from: 'task',
    key: 'taskId',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Add a comment to a task' })
  create(@Body() dto: CreateTaskCommentDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectMembership({
    from: 'taskComment',
    key: 'id',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Edit own comment' })
  @ApiParam({ name: 'id', description: 'Comment UUID' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTaskCommentDto,
    @CurrentUser() user: any,
  ) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @RequireProjectMembership({
    from: 'taskComment',
    key: 'id',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Delete own comment (Admin/HR can delete any)' })
  @ApiParam({ name: 'id', description: 'Comment UUID' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user);
  }
}
