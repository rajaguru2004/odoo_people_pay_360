import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { SupervisorsService } from '../../supervisors/supervisors.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

/**
 * MCP tools for the dynamic Supervisor assignment. Writes are confirm-first via
 * the central executor gate. Supervisor is an approval-responsibility link, not
 * an RBAC role, so these do not grant any permissions.
 */
@Injectable()
export class SupervisorTools implements DomainToolProvider {
  constructor(private readonly supervisors: SupervisorsService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'supervisor_assign',
        description:
          'Assign (or reassign) an employee to a supervisor. Both are employee ids. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          employeeId: z.string().uuid().describe('Employee who gets a supervisor'),
          supervisorId: z.string().uuid().describe('Supervisor (an employee id)'),
        },
        auditResourceType: 'SupervisorAssignment',
        resourceIdArg: 'employeeId',
        preview: async (a) => ({
          action: 'Assign supervisor',
          employeeId: a.employeeId,
          supervisorId: a.supervisorId,
        }),
        execute: (a, user) =>
          this.supervisors.assign(a.employeeId, a.supervisorId, user),
      },
      {
        name: 'supervisor_unassign',
        description: 'Detach an employee from its supervisor. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          employeeId: z.string().uuid(),
        },
        auditResourceType: 'SupervisorAssignment',
        resourceIdArg: 'employeeId',
        preview: async (a) => ({ action: 'Remove supervisor', employeeId: a.employeeId }),
        execute: (a, user) => this.supervisors.unassign(a.employeeId, user),
      },
      {
        name: 'supervisor_list_reports',
        description: 'List the employees supervised by a given supervisor.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: { supervisorId: z.string().uuid() },
        auditResourceType: 'SupervisorAssignment',
        execute: (a) => this.supervisors.reports(a.supervisorId),
      },
      {
        name: 'supervisor_of',
        description: 'Get the assigned supervisor of a given employee.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: { employeeId: z.string().uuid() },
        auditResourceType: 'SupervisorAssignment',
        execute: (a) => this.supervisors.supervisorOf(a.employeeId),
      },
    ];
  }
}
