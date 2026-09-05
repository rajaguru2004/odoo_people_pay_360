import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { OvertimeService } from '../../overtime/overtime.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

/**
 * Overtime had no MCP surface at all: the copilot could summarise overtime but
 * could not raise, cancel or decide a request. These wrap the same service
 * methods the HTTP controller uses, so the approval engine, policy resolution
 * and monthly caps all behave identically.
 */
@Injectable()
export class OvertimeTools implements DomainToolProvider {
  constructor(private readonly overtime: OvertimeService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'overtime_request_create',
        description:
          'Raise an overtime request for the caller. Times are ISO timestamps; hours is the claimed duration.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          date: z.string().describe('YYYY-MM-DD'),
          startTime: z.string().describe('ISO timestamp'),
          endTime: z.string().describe('ISO timestamp'),
          hours: z.number().min(0.5).max(24),
          reason: z.string().max(1000).optional(),
        },
        auditResourceType: 'OvertimeRequest',
        resourceIdArg: 'employeeId',
        preview: async (a, user) => ({
          action: 'Request overtime',
          employeeId: a.employeeId ?? user.employeeId,
          date: a.date,
          hours: a.hours,
          reason: a.reason,
        }),
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          const { employeeId: _drop, ...dto } = a;
          return this.overtime.create(employeeId, dto as any, user.role);
        },
      },
      {
        name: 'overtime_my_requests',
        description: "The caller's own overtime requests.",
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {},
        auditResourceType: 'OvertimeRequest',
        execute: (_a, user) => {
          if (!user.employeeId) throw new Error('No employee record is linked to this account');
          return this.overtime.findByEmployee(user.employeeId, user);
        },
      },
      {
        name: 'overtime_request_cancel',
        description: 'Cancel one of the caller\'s own pending overtime requests.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'OvertimeRequest',
        resourceIdArg: 'id',
        preview: (a) => this.requestPreview('Cancel overtime request', a.id),
        execute: (a, user) => {
          if (!user.employeeId) throw new Error('No employee record is linked to this account');
          return this.overtime.cancel(a.id, user.employeeId);
        },
      },
      {
        name: 'overtime_pending_approvals',
        description: 'Overtime requests awaiting a decision.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          limit: z.number().int().min(1).max(100).optional(),
        },
        auditResourceType: 'OvertimeRequest',
        execute: (a, user) =>
          this.overtime.findAll('PENDING', undefined, undefined, undefined, 1, a.limit ?? 20, user),
      },
      {
        name: 'overtime_approve',
        description: 'Approve an overtime request. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'OvertimeRequest',
        resourceIdArg: 'id',
        preview: (a) => this.requestPreview('Approve overtime request', a.id),
        execute: (a, user) => this.overtime.approve(a.id, user.id, user),
      },
      {
        name: 'overtime_reject',
        description: 'Reject an overtime request with a reason. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          rejectedReason: z.string().min(1).max(1000),
        },
        auditResourceType: 'OvertimeRequest',
        resourceIdArg: 'id',
        preview: (a) => this.requestPreview('Reject overtime request', a.id),
        execute: (a, user) =>
          this.overtime.reject(a.id, user.id, { rejectedReason: a.rejectedReason } as any, user),
      },
    ];
  }

  /** Domain-accurate confirm card: what the approver is actually deciding on. */
  private async requestPreview(action: string, id: string) {
    const r: any = await this.overtime.findOne(id);
    const d = r?.data ?? r;
    return {
      action,
      request: {
        id,
        employee: d?.employee?.fullName,
        date: d?.date,
        hours: d?.hours,
        reason: d?.reason,
        currentStatus: d?.status,
      },
    };
  }
}
