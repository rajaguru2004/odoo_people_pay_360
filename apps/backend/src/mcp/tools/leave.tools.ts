import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { LeaveBalancesService } from '../../leave-balances/leave-balances.service';
import { LeaveRequestsService } from '../../leave-requests/leave-requests.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

const LEAVE_TYPES = ['ANNUAL', 'SICK', 'UNPAID', 'MATERNITY', 'PATERNITY', 'BEREAVEMENT', 'OTHER'] as const;

@Injectable()
export class LeaveTools implements DomainToolProvider {
  constructor(
    private readonly leave: LeaveRequestsService,
    private readonly balances: LeaveBalancesService,
  ) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'leave_request_list',
        description: 'List leave requests with filters (status, type, employee, date range). Paginated.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          employeeId: z.string().uuid().optional(),
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
          leaveType: z.enum(LEAVE_TYPES).optional(),
          startDate: z.string().optional().describe('YYYY-MM-DD'),
          endDate: z.string().optional().describe('YYYY-MM-DD'),
          search: z.string().optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        auditResourceType: 'LeaveRequest',
        execute: (a, user) => this.leave.findAll(a, user),
      },
      {
        name: 'leave_pending_approvals',
        description: 'List leave requests waiting for approval (managers see their own scope).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {},
        auditResourceType: 'LeaveRequest',
        execute: (_a, user) => this.leave.findPending(user),
      },
      {
        name: 'leave_request_create',
        description:
          'Submit a leave request. Dates are YYYY-MM-DD. Admin/HR may set employeeId to file for someone else; employees always file for themselves. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Target employee (Admin/HR only)'),
          leaveType: z.enum(LEAVE_TYPES),
          startDate: z.string().describe('YYYY-MM-DD'),
          endDate: z.string().describe('YYYY-MM-DD'),
          reason: z.string().min(1).max(1000),
        },
        auditResourceType: 'LeaveRequest',
        execute: (a, user) => this.leave.create(a, user.id, user.employeeId ?? undefined),
      },
      {
        name: 'leave_request_approve',
        description: 'Approve a pending leave request. Requires confirm:true after reviewing the preview.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          id: z.string().uuid().describe('Leave request id (see leave_pending_approvals)'),
          comment: z.string().max(500).optional(),
        },
        auditResourceType: 'LeaveRequest',
        resourceIdArg: 'id',
        preview: (a) => this.requestPreview('Approve leave request', a.id, a.comment),
        execute: (a, user) => this.leave.approve(a.id, user.id, a.comment, user),
      },
      {
        name: 'leave_request_reject',
        description: 'Reject a pending leave request with a reason. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          reason: z.string().min(1).max(500),
        },
        auditResourceType: 'LeaveRequest',
        resourceIdArg: 'id',
        preview: (a) => this.requestPreview('Reject leave request', a.id, a.reason),
        execute: (a, user) => this.leave.reject(a.id, user.id, a.reason, user),
      },
      {
        name: 'leave_request_cancel',
        description: 'Cancel a leave request (own request, or any as Admin/HR). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'LeaveRequest',
        resourceIdArg: 'id',
        preview: (a) => this.requestPreview('Cancel leave request', a.id),
        execute: (a, user) => this.leave.cancel(a.id, user.id, user.employeeId ?? undefined),
      },
      {
        // leave_request_list is ADMIN/HR/MANAGER only, which left an employee
        // with no way to see their own history through a tool.
        name: 'leave_my_requests',
        description: "The caller's own leave requests, newest first.",
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          status: z.string().optional().describe('PENDING | APPROVED | REJECTED | CANCELLED'),
          leaveType: z.string().optional(),
          startDate: z.string().optional().describe('YYYY-MM-DD'),
          endDate: z.string().optional().describe('YYYY-MM-DD'),
        },
        auditResourceType: 'LeaveRequest',
        execute: (a, user) => {
          if (!user.employeeId) throw new Error('No employee record is linked to this account');
          return this.leave.findByEmployee(user.employeeId, a);
        },
      },
      {
        name: 'leave_balance_get',
        description:
          'Get leave balances (annual, sick, per-type) for an employee and year. Employees always get their own.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          year: z.number().int().min(2020).max(2100).optional().describe('Defaults to current year'),
        },
        auditResourceType: 'LeaveBalance',
        resourceIdArg: 'employeeId',
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.balances.getBalance(employeeId, a.year);
        },
      },
    ];
  }

  private async requestPreview(action: string, id: string, note?: string) {
    const r: any = await this.leave.findOne(id);
    const d = r?.data ?? r;
    return {
      action,
      request: {
        id,
        employee: d?.employee?.fullName ?? d?.employeeName,
        leaveType: d?.leaveType,
        startDate: d?.startDate,
        endDate: d?.endDate,
        totalDays: d?.totalDays,
        currentStatus: d?.status,
      },
      note: note ?? null,
    };
  }
}
