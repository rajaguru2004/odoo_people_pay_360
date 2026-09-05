import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DepartmentsService } from '../../departments/departments.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

@Injectable()
export class DepartmentTools implements DomainToolProvider {
  constructor(private readonly departments: DepartmentsService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'department_list',
        description: 'List all departments with manager and headcount.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {},
        auditResourceType: 'Department',
        execute: () => this.departments.findAll(),
      },
      {
        name: 'department_get',
        description: 'Get one department by id with details.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Department',
        resourceIdArg: 'id',
        execute: (a) => this.departments.findOne(a.id),
      },
      {
        name: 'department_create',
        description: 'Create a department (unique code + name). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          code: z.string().min(1).max(50).describe('Unique department code, e.g. IT'),
          name: z.string().min(1),
          description: z.string().optional(),
          parentId: z.string().uuid().optional().describe('Parent department for hierarchy'),
        },
        auditResourceType: 'Department',
        execute: (a) => this.departments.create(a),
      },
      {
        name: 'department_update',
        description: 'Update department fields (only provided fields change). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          code: z.string().min(1).max(50).optional(),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          parentId: z.string().uuid().nullable().optional(),
        },
        auditResourceType: 'Department',
        resourceIdArg: 'id',
        preview: async (a) => {
          const cur: any = await this.departments.findOne(a.id);
          const d = cur?.data ?? cur;
          const { id: _id, ...changes } = a;
          return {
            action: 'Update department',
            department: { id: a.id, code: d?.code, name: d?.name },
            changes,
          };
        },
        execute: (a) => {
          const { id, ...dto } = a;
          return this.departments.update(id, dto);
        },
      },
      {
        name: 'department_delete',
        description: 'Delete a department. Destructive — always requires confirm:true.',
        kind: 'destructive',
        roles: ['ADMIN'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Department',
        resourceIdArg: 'id',
        preview: async (a) => {
          const cur: any = await this.departments.findOne(a.id);
          const d = cur?.data ?? cur;
          return {
            action: 'Delete department',
            department: {
              id: a.id,
              code: d?.code,
              name: d?.name,
              employees: d?._count?.employees ?? d?.employeeCount,
            },
            warning: 'Deletion fails server-side if employees are still assigned.',
          };
        },
        execute: (a) => this.departments.delete(a.id),
      },
      {
        name: 'department_assign_manager',
        description: 'Assign an employee as manager of a department. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          departmentId: z.string().uuid(),
          managerId: z.string().uuid().describe('Employee id of the new manager'),
        },
        auditResourceType: 'Department',
        resourceIdArg: 'departmentId',
        execute: (a) => this.departments.assignManager(a.departmentId, a.managerId),
      },
    ];
  }
}
