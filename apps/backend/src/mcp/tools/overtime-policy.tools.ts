import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { OvertimePolicyService } from '../../overtime-policy/overtime-policy.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

const HOLIDAY_BEHAVIORS = ['STANDARD', 'IGNORE'] as const;
// Employment type is a Contract Type library label (free string), not an enum.
const employmentTypeSchema = z
  .string()
  .max(100)
  .describe('Contract Type library label this policy targets, e.g. "Daily Wage"');

// The subset of policy `rules` exposed to MCP callers. Omitted fields inherit
// the current global overtime settings when the policy is composed.
const rulesShape = z
  .object({
    eligible: z.boolean().optional(),
    holidayBehavior: z.enum(HOLIDAY_BEHAVIORS).optional(),
    regularRate: z.number().positive().optional(),
    lateRate: z.number().positive().optional(),
    doubleRate: z.number().positive().optional(),
    lateThreshold: z.string().optional(),
    shiftEndTime: z.string().optional(),
    foodAllowanceEnabled: z.boolean().optional(),
    foodAllowanceAmount: z.number().min(0).optional(),
    maxHoursPerDay: z.number().min(0).optional(),
    maxHoursPerDoubleDay: z.number().min(0).optional(),
    maxHoursPerMonth: z.number().min(0).optional(),
    maxHoursPerYear: z.number().min(0).optional(),
  })
  .partial();

/**
 * MCP tools for the Overtime Policy engine: read/resolve policies and (ADMIN)
 * create/update/assign/delete them. Writes are confirm-first — the executor
 * injects `confirm` and returns a preview envelope until confirm:true.
 */
@Injectable()
export class OvertimePolicyTools implements DomainToolProvider {
  constructor(private readonly policies: OvertimePolicyService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'overtime_policy_list',
        description:
          'List all overtime policies (rules, targeting, default flag, assignee counts) and whether the policy engine is enabled.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {},
        auditResourceType: 'OvertimePolicy',
        execute: () => this.policies.list(),
      },
      {
        name: 'overtime_policy_get',
        description: 'Get one overtime policy by id.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'OvertimePolicy',
        resourceIdArg: 'id',
        execute: (a) => this.policies.get(a.id),
      },
      {
        name: 'overtime_policy_resolve',
        description:
          'Resolve which overtime policy governs an employee and via which tier (Employee Override → Employment Type → Company Default → legacy globals). Use to explain how an employee’s overtime will be calculated.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: { employeeId: z.string().uuid() },
        auditResourceType: 'OvertimePolicy',
        execute: (a) => this.policies.resolveForEmployee(a.employeeId),
      },
      {
        name: 'overtime_policy_create',
        description:
          'Create an overtime policy. Set holidayBehavior:"IGNORE" so National Holidays are treated as ordinary weekdays (e.g. daily-wage staff). Target it with employmentType, or set isDefault. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: {
          name: z.string().max(150),
          description: z.string().optional(),
          isActive: z.boolean().optional(),
          isDefault: z.boolean().optional(),
          employmentType: employmentTypeSchema.optional(),
          rules: rulesShape.optional(),
        },
        auditResourceType: 'OvertimePolicy',
        preview: async (a) => ({
          action: 'Create overtime policy',
          name: a.name,
          target: a.employmentType ?? (a.isDefault ? 'Company default' : 'Unassigned'),
          holidayBehavior: a.rules?.holidayBehavior ?? 'STANDARD (inherited)',
        }),
        execute: (a, user) => this.policies.create(a, user.id),
      },
      {
        name: 'overtime_policy_update',
        description:
          'Update an overtime policy (partial). Only provided rule fields change; the rest are preserved. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: {
          id: z.string().uuid(),
          name: z.string().max(150).optional(),
          description: z.string().optional(),
          isActive: z.boolean().optional(),
          isDefault: z.boolean().optional(),
          employmentType: employmentTypeSchema.optional(),
          rules: rulesShape.optional(),
        },
        auditResourceType: 'OvertimePolicy',
        resourceIdArg: 'id',
        preview: async (a) => ({ action: 'Update overtime policy', id: a.id }),
        execute: (a, user) => {
          const { id, ...dto } = a;
          return this.policies.update(id, dto, user.id);
        },
      },
      {
        name: 'overtime_policy_set_default',
        description:
          'Make an overtime policy the single active company default (unsets the previous default). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'OvertimePolicy',
        resourceIdArg: 'id',
        preview: async (a) => ({ action: 'Set company default overtime policy', id: a.id }),
        execute: (a, user) => this.policies.setDefault(a.id, user.id),
      },
      {
        name: 'overtime_policy_assign',
        description:
          'Assign an employment type and/or a direct policy override to an employee. overtimePolicyId:null clears the override. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          employeeId: z.string().uuid(),
          employmentType: employmentTypeSchema.optional(),
          overtimePolicyId: z.string().uuid().nullable().optional(),
        },
        auditResourceType: 'OvertimePolicy',
        preview: async (a) => ({
          action: 'Assign overtime policy',
          employeeId: a.employeeId,
          employmentType: a.employmentType,
          overtimePolicyId: a.overtimePolicyId ?? '(unchanged)',
        }),
        execute: (a, user) => this.policies.assign(a, user.id),
      },
      {
        name: 'overtime_policy_delete',
        description:
          'Delete an overtime policy. Assignees fall back to their employment-type / default policy. The active default cannot be deleted. Requires confirm:true.',
        kind: 'destructive',
        roles: ['ADMIN'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'OvertimePolicy',
        resourceIdArg: 'id',
        preview: async (a) => ({ action: 'Delete overtime policy', id: a.id }),
        execute: (a, user) => this.policies.remove(a.id, user.id),
      },
    ];
  }
}
