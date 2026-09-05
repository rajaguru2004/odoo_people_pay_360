import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApprovalWorkflowService } from '../../approvals/approval-workflow.service';
import { ApprovalEngineService } from '../../approvals/approval-engine.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

const APPROVER_TYPES = ['SUPERVISOR', 'MANAGER', 'HR_MANAGER', 'ADMIN'] as const;

/**
 * MCP tools for the configurable approval hierarchy: read/configure workflows
 * and inspect the current user's pending approval queue.
 */
@Injectable()
export class ApprovalsTools implements DomainToolProvider {
  constructor(
    private readonly workflows: ApprovalWorkflowService,
    private readonly engine: ApprovalEngineService,
  ) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'approval_workflow_get',
        description:
          'List configured approval workflows (ordered steps per request type: LEAVE, OVERTIME).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {},
        auditResourceType: 'ApprovalWorkflow',
        execute: () => this.workflows.list(),
      },
      {
        name: 'approval_workflow_set',
        description:
          'Create/replace the active approval chain for a request type. steps is an ordered list of approver types (SUPERVISOR, MANAGER, HR_MANAGER, ADMIN). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: {
          requestType: z.enum(['LEAVE', 'OVERTIME']),
          name: z.string().max(150).optional(),
          mode: z
            .enum(['SEQUENTIAL', 'PARALLEL'])
            .optional()
            .describe(
              'SEQUENTIAL (default): a step becomes actionable only after the previous approver accepts. PARALLEL: all steps are actionable at once and all must approve.',
            ),
          steps: z
            .array(z.enum(APPROVER_TYPES))
            .min(1)
            .describe('Ordered approver types, e.g. ["SUPERVISOR","HR_MANAGER","ADMIN"]'),
        },
        auditResourceType: 'ApprovalWorkflow',
        preview: async (a) => ({
          action: 'Configure approval chain',
          requestType: a.requestType,
          mode: a.mode ?? 'SEQUENTIAL',
          chain: (a.steps as string[]).join(
            a.mode === 'PARALLEL' ? ' + ' : ' → ',
          ),
        }),
        execute: (a, user) =>
          this.workflows.upsert(
            {
              requestType: a.requestType,
              name: a.name,
              mode: a.mode,
              steps: (a.steps as string[]).map((s) => ({ approverType: s as any })),
            },
            user.id,
          ),
      },
      {
        name: 'approval_pending_for_me',
        description:
          'Active approval steps awaiting the current user (includes supervisor queues).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {},
        auditResourceType: 'RequestApproval',
        execute: (_a, user) => this.engine.pendingForUser(user),
      },
    ];
  }
}
