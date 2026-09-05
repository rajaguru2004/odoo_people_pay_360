import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ReimbursementsService } from '../../reimbursements/reimbursements.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

/**
 * Expense claims.
 *
 * Reimbursements were HTTP-only, which meant an employee could check a leave
 * balance from a chat but not claim a taxi fare — the single most common
 * "I'll do it later and forget" errand in the whole product.
 *
 * Deliberately only two tools. Approving somebody else's expense is a money
 * decision that belongs in the portal, and `reimbursement_approve` /
 * `reimbursement_reject` are on the WhatsApp denylist so a future author cannot
 * add them by accident.
 */
@Injectable()
export class ReimbursementTools implements DomainToolProvider {
  constructor(private readonly reimbursements: ReimbursementsService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'reimbursement_my_requests',
        description: "The caller's own expense claims, newest first.",
        kind: 'read',
        // ADMIN is absent on purpose, mirroring the controller: admins
        // administer reimbursements, they do not submit them, and an admin
        // without an employee record has nothing to return.
        roles: ['HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
        },
        auditResourceType: 'Reimbursement',
        resourceIdArg: 'employeeId',
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.reimbursements.findAll(undefined, employeeId);
        },
      },
      {
        name: 'reimbursement_create',
        description:
          'Submit an expense claim for the caller. Dates are YYYY-MM-DD. Requires confirm:true.',
        kind: 'write',
        roles: ['HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          type: z.string().min(1).max(60),
          amount: z.number().positive(),
          expenseDate: z.string().describe('YYYY-MM-DD'),
          description: z.string().max(500).optional(),
        },
        auditResourceType: 'Reimbursement',
        resourceIdArg: 'employeeId',
        preview: async (a, user) => ({
          action: 'Submit expense claim',
          employeeId: a.employeeId ?? user.employeeId,
          type: a.type,
          amount: a.amount,
          expenseDate: a.expenseDate,
          description: a.description,
          // Receipts stay in the portal: an image attached to a claim needs to
          // be reviewable, and a chat is the wrong place to manage that.
          note: 'Attach a receipt in the HR portal if your policy requires one.',
        }),
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.reimbursements.create(employeeId, {
            type: a.type,
            amount: a.amount,
            expenseDate: a.expenseDate,
            description: a.description,
          } as any);
        },
      },
    ];
  }
}
