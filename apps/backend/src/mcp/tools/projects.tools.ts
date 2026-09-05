import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ProjectsService } from '../../projects/projects.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

@Injectable()
export class ProjectTools implements DomainToolProvider {
  constructor(private readonly projects: ProjectsService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'project_list',
        description:
          'List projects visible to the caller (membership/visibility rules apply server-side). Paginated.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional(),
          search: z.string().optional(),
          departmentId: z.string().uuid().optional(),
          isArchived: z.boolean().optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        auditResourceType: 'Project',
        execute: (a, user) => this.projects.findAll(a, user),
      },
      {
        name: 'project_get',
        description: 'Get one project by id (members, workflow, stats).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Project',
        resourceIdArg: 'id',
        execute: (a, user) => this.projects.findOne(a.id, user),
      },
      {
        name: 'project_create',
        description: 'Create a project. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          name: z.string().min(1),
          description: z.string().optional(),
          priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
          visibility: z.enum(['PUBLIC', 'PRIVATE', 'TEAM']).optional(),
          startDate: z.string().optional().describe('YYYY-MM-DD'),
          endDate: z.string().optional().describe('YYYY-MM-DD'),
          departmentId: z.string().uuid().optional(),
          ownerId: z.string().uuid().optional().describe('Employee id of the project owner'),
          memberIds: z.array(z.string().uuid()).optional(),
        },
        auditResourceType: 'Project',
        execute: (a, user) => this.projects.create(a, user),
      },
      {
        name: 'project_member_add',
        description: 'Add one or more employees to a project. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          projectId: z.string().uuid(),
          employeeId: z.string().uuid().optional(),
          employeeIds: z.array(z.string().uuid()).optional(),
          role: z.string().optional().describe('Member role slug, e.g. member, lead'),
        },
        auditResourceType: 'Project',
        resourceIdArg: 'projectId',
        execute: (a) => {
          const { projectId, ...dto } = a;
          return this.projects.addMember(projectId, dto);
        },
      },
    ];
  }
}
