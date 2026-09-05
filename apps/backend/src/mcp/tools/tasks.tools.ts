import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TasksService } from '../../tasks/tasks.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'CANCELLED', 'BLOCKED'] as const;
const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

@Injectable()
export class TaskTools implements DomainToolProvider {
  constructor(private readonly tasks: TasksService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'task_list',
        description:
          'List tasks with filters. Set mine:true for the caller own tasks. Paginated.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          mine: z.boolean().optional().describe('Only tasks assigned to the caller'),
          projectId: z.string().uuid().optional(),
          assigneeId: z.string().uuid().optional(),
          status: z.enum(TASK_STATUSES).optional(),
          priority: z.enum(TASK_PRIORITIES).optional(),
          search: z.string().optional(),
          dueDateFrom: z.string().optional().describe('YYYY-MM-DD'),
          dueDateTo: z.string().optional().describe('YYYY-MM-DD'),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        auditResourceType: 'Task',
        execute: (a, user) => {
          const { mine, ...query } = a;
          return mine ? this.tasks.findMyTasks(user, query) : this.tasks.findAll(query, user);
        },
      },
      {
        name: 'task_get',
        description: 'Get one task by id with details (assignees, comments count, project).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Task',
        resourceIdArg: 'id',
        execute: (a, user) => this.tasks.findOne(a.id, user),
      },
      {
        name: 'task_create',
        description: 'Create a task (optionally inside a project, with assignees). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          title: z.string().min(1),
          description: z.string().optional(),
          projectId: z.string().uuid().optional(),
          assigneeId: z.string().uuid().optional(),
          assigneeIds: z.array(z.string().uuid()).optional(),
          priority: z.enum(TASK_PRIORITIES).optional(),
          status: z.enum(TASK_STATUSES).optional(),
          startDate: z.string().optional().describe('YYYY-MM-DD'),
          dueDate: z.string().optional().describe('YYYY-MM-DD'),
          estimatedHours: z.number().positive().optional(),
          parentTaskId: z.string().uuid().optional(),
        },
        auditResourceType: 'Task',
        execute: (a, user) => this.tasks.create(a, user),
      },
      {
        name: 'task_update',
        description: 'Update task fields (only provided fields change). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          title: z.string().optional(),
          description: z.string().optional(),
          priority: z.enum(TASK_PRIORITIES).optional(),
          status: z.enum(TASK_STATUSES).optional(),
          dueDate: z.string().optional().describe('YYYY-MM-DD'),
          estimatedHours: z.number().positive().optional(),
        },
        auditResourceType: 'Task',
        resourceIdArg: 'id',
        preview: async (a, user) => {
          const cur: any = await this.tasks.findOne(a.id, user);
          const d = cur?.data ?? cur;
          const { id: _id, ...changes } = a;
          return {
            action: 'Update task',
            task: { id: a.id, title: d?.title, status: d?.status },
            changes,
          };
        },
        execute: (a, user) => {
          const { id, ...dto } = a;
          return this.tasks.update(id, dto, user);
        },
      },
      {
        name: 'task_assign',
        description: 'Assign a task to an employee. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          assigneeId: z.string().uuid().describe('Employee id of the new assignee'),
        },
        auditResourceType: 'Task',
        resourceIdArg: 'id',
        execute: (a, user) => this.tasks.assign(a.id, { assigneeId: a.assigneeId }, user),
      },
      {
        name: 'task_status_change',
        description:
          'Change a task status (TODO, IN_PROGRESS, IN_REVIEW, COMPLETED, CANCELLED, BLOCKED). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          id: z.string().uuid(),
          status: z.enum(TASK_STATUSES),
        },
        auditResourceType: 'Task',
        resourceIdArg: 'id',
        execute: (a, user) => this.tasks.changeStatus(a.id, { status: a.status } as any, user),
      },
    ];
  }
}
