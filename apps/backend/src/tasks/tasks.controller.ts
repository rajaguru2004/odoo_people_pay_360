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
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { AddDependencyDto } from './dto/add-dependency.dto';
import { MoveStatusDto } from './dto/move-status.dto';
import {
  QueryTaskDto,
  AssignTaskDto,
  ChangeStatusDto,
  BulkAssignDto,
} from './dto/query-task.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { ProjectPermissionGuard } from '../projects/rbac/project-permission.guard';
import { RequireProjectPermission } from '../projects/rbac/require-project-permission.decorator';
import { PROJECT_PERMISSIONS } from '../projects/rbac/permissions.constants';

@ApiTags('Tasks')
@ApiBearerAuth('JWT-auth')
@Controller('tasks')
@UseGuards(JwtAuthGuard, RolesGuard, ProjectPermissionGuard)
@AuditResource('Task')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get task statistics for current user' })
  getStats(@CurrentUser() user: any) {
    return this.tasksService.getTaskStats(user);
  }

  @Get('my-tasks')
  @ApiOperation({ summary: 'Get tasks assigned to current user' })
  getMyTasks(@CurrentUser() user: any, @Query() query: QueryTaskDto) {
    return this.tasksService.findMyTasks(user, query);
  }

  @Get()
  @ApiOperation({ summary: 'List tasks (visibility scoped by project role)' })
  findAll(@Query() query: QueryTaskDto, @CurrentUser() user: any) {
    return this.tasksService.findAll(query, user);
  }

  @Get('kanban')
  @ApiOperation({ summary: 'Get project tasks grouped by workflow status (board)' })
  getKanban(@Query() query: QueryTaskDto, @CurrentUser() user: any) {
    return this.tasksService.getKanban(query.projectId as string, user, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get task details with comments, attachments, activity',
  })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.tasksService.findOne(id, user);
  }

  @Post()
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_CREATE, {
    from: 'body',
    key: 'projectId',
  })
  @ApiOperation({ summary: 'Create new task' })
  @ApiResponse({ status: 201, description: 'Task created' })
  create(@Body() dto: CreateTaskDto, @CurrentUser() user: any) {
    return this.tasksService.create(dto, user);
  }

  @Patch(':id')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_EDIT, { from: 'task' })
  @ApiOperation({ summary: 'Update task' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() user: any,
  ) {
    return this.tasksService.update(id, dto, user);
  }

  @Delete(':id')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_DELETE, { from: 'task' })
  @ApiOperation({ summary: 'Soft delete task' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.tasksService.remove(id, user);
  }

  @Post(':id/archive')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_DELETE, { from: 'task' })
  @ApiOperation({ summary: 'Archive task' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  archive(@Param('id') id: string, @CurrentUser() user: any) {
    return this.tasksService.archive(id, user);
  }

  @Post(':id/assign')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_ASSIGN, { from: 'task' })
  @ApiOperation({ summary: 'Assign / reassign task to employee' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  assign(
    @Param('id') id: string,
    @Body() dto: AssignTaskDto,
    @CurrentUser() user: any,
  ) {
    return this.tasksService.assign(id, dto, user);
  }

  @Post(':id/status')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_STATUS_UPDATE, {
    from: 'task',
  })
  @ApiOperation({ summary: 'Change task status' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  changeStatus(
    @Param('id') id: string,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.tasksService.changeStatus(id, dto, user);
  }

  // No `@Roles` and no single `@RequireProjectPermission`: the payload may span
  // several projects, so `TasksService.bulkAssign()` resolves each task's
  // project and demands TASK_ASSIGN on every one of them — the same permission
  // the single-task door above is gated by (finding R8).
  @Post('bulk-assign')
  @ApiOperation({
    summary: 'Bulk assign tasks to an employee (TASK_ASSIGN on every project touched)',
  })
  bulkAssign(@Body() dto: BulkAssignDto, @CurrentUser() user: any) {
    return this.tasksService.bulkAssign(dto, user);
  }

  @Post(':id/move-status')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_STATUS_UPDATE, {
    from: 'task',
  })
  @ApiOperation({ summary: 'Move task to a workflow status (kanban drag-drop)' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  // `@Body() dto: MoveStatusDto`, not `@Body('statusId')` — finding R40. See
  // the DTO for why the bare binding meant no validation ran at all.
  moveStatus(
    @Param('id') id: string,
    @Body() dto: MoveStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.tasksService.moveStatus(id, dto.statusId, user);
  }

  // ─── Subtasks ─────────────────────────────────────────────────────────────────

  @Get(':id/subtasks')
  @ApiOperation({ summary: 'List subtasks of a task' })
  getSubtasks(@Param('id') id: string) {
    return this.tasksService.getSubtasks(id);
  }

  @Post(':id/subtasks')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_CREATE, { from: 'task' })
  @ApiOperation({ summary: 'Create a subtask under a task' })
  createSubtask(
    @Param('id') id: string,
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: any,
  ) {
    return this.tasksService.createSubtask(id, dto, user);
  }

  // ─── Dependencies ─────────────────────────────────────────────────────────────

  @Get(':id/dependencies')
  @ApiOperation({ summary: 'Get task dependencies (dependsOn / blocks)' })
  getDependencies(@Param('id') id: string) {
    return this.tasksService.getDependencies(id);
  }

  @Post(':id/dependencies')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_EDIT, { from: 'task' })
  @ApiOperation({ summary: 'Add a dependency (this task depends on blockingTaskId)' })
  addDependency(@Param('id') id: string, @Body() dto: AddDependencyDto) {
    return this.tasksService.addDependency(id, dto.blockingTaskId, dto.type);
  }

  // Gated like every other dependency write (finding R55): it carried no
  // `@Roles` and no `@RequireProjectPermission` at all, so any logged-in user
  // could cut an edge in a project they cannot read.
  @Delete('dependencies/:depId')
  @RequireProjectPermission(PROJECT_PERMISSIONS.TASK_EDIT, {
    from: 'taskDependency',
    key: 'depId',
    onMissing: 'next',
  })
  @ApiOperation({ summary: 'Remove a dependency' })
  removeDependency(@Param('depId') depId: string) {
    return this.tasksService.removeDependency(depId);
  }
}
