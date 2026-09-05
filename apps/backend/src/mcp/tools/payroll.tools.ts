import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PayrollsService } from '../../payrolls/payrolls.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

const month = z.number().int().min(1).max(12);
const year = z.number().int().min(2020).max(2100);

@Injectable()
export class PayrollTools implements DomainToolProvider {
  constructor(private readonly payrolls: PayrollsService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'payroll_list',
        description: 'List payroll runs, optionally filtered by year and status.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          year: year.optional(),
          status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'LOCKED']).optional(),
        },
        auditResourceType: 'Payroll',
        execute: (a) => this.payrolls.findAll(a),
      },
      {
        name: 'payroll_get',
        description: 'Get one payroll run with its per-employee items.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Payroll',
        resourceIdArg: 'id',
        execute: (a) => this.payrolls.findOne(a.id),
      },
      {
        name: 'payroll_run',
        description:
          'Create (run) payroll for a month/year, optionally for a batch or specific employees. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          month,
          year,
          batchId: z.string().uuid().optional(),
          employeeIds: z.array(z.string().uuid()).optional(),
        },
        auditResourceType: 'Payroll',
        preview: async (a) => ({
          action: 'Run payroll',
          period: `${a.month}/${a.year}`,
          scope: a.batchId ? `batch ${a.batchId}` : a.employeeIds?.length ? `${a.employeeIds.length} selected employees` : 'all active employees',
          warning: 'Calculates salaries for the period. Existing payroll for the same period/batch will be rejected by the server.',
        }),
        execute: (a) => this.payrolls.create(a),
      },
      {
        name: 'payroll_item_update',
        description:
          'Adjust one employee payroll item (allowances, bonus, deduction, overtimeHours, notes). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          payrollId: z.string().uuid(),
          itemId: z.string().uuid(),
          allowances: z.number().nonnegative().optional(),
          bonus: z.number().nonnegative().optional(),
          deduction: z.number().nonnegative().optional(),
          overtimeHours: z.number().nonnegative().optional(),
          foodAllowance: z.number().nonnegative().optional(),
          notes: z.string().max(500).optional(),
        },
        auditResourceType: 'Payroll',
        resourceIdArg: 'payrollId',
        execute: (a) => {
          const { payrollId, itemId, ...dto } = a;
          return this.payrolls.updateItem(payrollId, itemId, dto);
        },
      },
      {
        name: 'payroll_submit_for_approval',
        description: 'Submit a draft payroll for approval. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Payroll',
        resourceIdArg: 'id',
        preview: (a) => this.payrollPreview('Submit payroll for approval', a.id),
        execute: (a, user) => this.payrolls.submitForApproval(a.id, user.id),
      },
      {
        name: 'payroll_approve',
        description: 'Approve a payroll pending approval. Admin only. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: {
          id: z.string().uuid(),
          notes: z.string().max(500).optional(),
        },
        auditResourceType: 'Payroll',
        resourceIdArg: 'id',
        preview: (a) => this.payrollPreview('Approve payroll', a.id),
        execute: (a, user) => this.payrolls.approvePayroll(a.id, user.id, { notes: a.notes }),
      },
      {
        name: 'payroll_reject',
        description: 'Reject a payroll pending approval, with a reason. Admin only. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: {
          id: z.string().uuid(),
          reason: z.string().min(1).max(500),
        },
        auditResourceType: 'Payroll',
        resourceIdArg: 'id',
        preview: (a) => this.payrollPreview('Reject payroll', a.id),
        execute: (a, user) => this.payrolls.rejectPayroll(a.id, user.id, { reason: a.reason }),
      },
      {
        name: 'payroll_finalize',
        description:
          'Deprecated alias for payroll_lock — prefer that. Locks an APPROVED payroll run, marking salaries final for the period. Destructive: always requires confirm:true.',
        kind: 'destructive',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Payroll',
        resourceIdArg: 'id',
        preview: (a) => this.payrollPreview('Finalize payroll', a.id),
        execute: (a, user) => this.payrolls.finalize(a.id, user.id),
      },
      {
        name: 'payroll_lock',
        description:
          'Lock a payroll against any further edits. Destructive: always requires confirm:true.',
        kind: 'destructive',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Payroll',
        resourceIdArg: 'id',
        preview: (a) => this.payrollPreview('Lock payroll', a.id),
        execute: (a, user) => this.payrolls.lockPayroll(a.id, user.id),
      },
      {
        name: 'payslip_get',
        description: 'Get an employee payslip for a month/year. Employees always get their own.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          month,
          year,
        },
        auditResourceType: 'Payroll',
        resourceIdArg: 'employeeId',
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.payrolls.getPayslip(employeeId, a.month, a.year);
        },
      },
      {
        // payslip_get needs a month and year up front, which is useless to a
        // caller who just wants "my recent payslips".
        name: 'payslip_list',
        description:
          'List the payslips available to an employee (finalised runs only, most recent first).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
        },
        auditResourceType: 'Payroll',
        resourceIdArg: 'employeeId',
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.payrolls.getEmployeePayslips(employeeId);
        },
      },
      {
        name: 'payslip_ytd',
        description: 'Year-to-date earnings and deductions summary for an employee.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          year,
        },
        auditResourceType: 'Payroll',
        resourceIdArg: 'employeeId',
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.payrolls.getYTDSummary(employeeId, a.year);
        },
      },
    ];
  }

  private async payrollPreview(action: string, id: string) {
    const r: any = await this.payrolls.findOne(id);
    const d = r?.data ?? r;
    return {
      action,
      payroll: {
        id,
        period: d ? `${d.month}/${d.year}` : undefined,
        status: d?.status,
        employeeCount: d?.items?.length ?? d?._count?.items,
        totalNet: d?.totalNetSalary ?? d?.totalAmount,
      },
    };
  }
}
