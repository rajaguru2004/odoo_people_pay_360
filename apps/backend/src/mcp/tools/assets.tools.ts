import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AssetsService, ASSET_STATUSES } from '../../assets/assets.service';
import { AssetAssignmentsService } from '../../assets/asset-assignments.service';
import { ClearanceService } from '../../assets/clearance.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

@Injectable()
export class AssetsTools implements DomainToolProvider {
  constructor(
    private readonly assets: AssetsService,
    private readonly assignments: AssetAssignmentsService,
    private readonly clearance: ClearanceService,
    private readonly prisma: PrismaService,
  ) {}

  private async assetPreview(action: string, assetId: string, extra?: Record<string, unknown>) {
    const asset = await this.prisma.assetItem.findUnique({
      where: { id: assetId },
      select: { id: true, assetTag: true, name: true, category: true, status: true },
    });
    if (!asset) return { action, assetId, warning: 'Asset not found' };
    return { action, asset, ...extra };
  }

  getTools(): McpToolDef[] {
    return [
      {
        name: 'asset_list',
        description:
          'List company assets in the register, with filters for status, category, branch and free text. Shows who currently holds each item.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          status: z.enum(ASSET_STATUSES).optional(),
          category: z.string().optional().describe('Asset category label, e.g. "Laptop"'),
          branchId: z.string().uuid().optional(),
          search: z.string().optional().describe('Asset tag, name or serial number'),
          unassignedOnly: z
            .boolean()
            .optional()
            .describe('Only assets nobody currently holds'),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        auditResourceType: 'AssetItem',
        execute: (a) => this.assets.findAll(a as any),
      },

      {
        name: 'asset_get',
        description:
          'Get one asset with its full custody history (who held it, when, in what condition).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'AssetItem',
        resourceIdArg: 'id',
        execute: (a) => this.assets.findOne(a.id as string),
      },

      {
        name: 'asset_summary',
        description:
          'Asset register totals: counts by status, how many are currently held, and how many hand-overs are still unacknowledged.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {},
        auditResourceType: 'AssetItem',
        execute: () => this.assets.getSummary(),
      },

      {
        name: 'asset_my_assets',
        description:
          'Company assets assigned to an employee. Employees and managers see only their own.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid(),
          openOnly: z
            .boolean()
            .optional()
            .describe('true = only items still held (default: full history)'),
        },
        auditResourceType: 'AssetAssignment',
        execute: (a) =>
          this.assignments.findByEmployee(
            a.employeeId as string,
            a.openOnly === true,
          ),
      },

      {
        name: 'asset_create',
        description:
          'Add an asset to the register. Category should be an ASSET_CATEGORY library label. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          assetTag: z.string().max(50).describe('Unique tag, e.g. "LT-0042"'),
          category: z.string().max(100),
          name: z.string().max(200),
          branchId: z.string().uuid(),
          serialNumber: z.string().max(150).optional(),
          purchaseDate: z.string().optional().describe('YYYY-MM-DD'),
          purchaseCost: z.number().min(0).optional(),
          warrantyExpiry: z
            .string()
            .optional()
            .describe('YYYY-MM-DD; drives warranty expiry reminders'),
          notes: z.string().optional(),
        },
        auditResourceType: 'AssetItem',
        preview: async (a) => ({
          action: 'Add asset to register',
          assetTag: a.assetTag,
          name: a.name,
          category: a.category,
        }),
        execute: (a, user) => this.assets.create(a as any, user.id),
      },

      {
        name: 'asset_assign',
        description:
          'Assign an asset to an employee. The asset must be AVAILABLE and the employee ACTIVE. Creates the open custody record that offboarding clearance checks. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          assetId: z.string().uuid(),
          employeeId: z.string().uuid(),
          assignedAt: z.string().optional().describe('YYYY-MM-DD; defaults to today'),
          conditionOut: z.string().max(50).optional(),
          notes: z.string().optional(),
        },
        auditResourceType: 'AssetAssignment',
        resourceIdArg: 'assetId',
        preview: async (a) => {
          const employee = await this.prisma.employee.findUnique({
            where: { id: a.employeeId as string },
            select: { fullName: true, employeeCode: true, status: true },
          });
          return this.assetPreview('Assign asset', a.assetId as string, {
            to: employee
              ? `${employee.fullName} (${employee.employeeCode})`
              : 'Employee not found',
            employeeStatus: employee?.status,
          });
        },
        execute: (a, user) => this.assignments.assign(a as any, user.id),
      },

      {
        name: 'asset_return',
        description:
          'Record the return of an assigned asset, closing its custody record. Set assetStatus to IN_REPAIR/LOST so a damaged item does not re-enter the assignable pool. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          assignmentId: z.string().uuid(),
          returnedAt: z.string().optional().describe('YYYY-MM-DD; defaults to today'),
          conditionIn: z.string().max(50).optional(),
          assetStatus: z
            .enum(['AVAILABLE', 'IN_REPAIR', 'LOST', 'RETIRED'])
            .optional()
            .describe('Status the asset takes on return; defaults to AVAILABLE'),
          notes: z.string().optional(),
        },
        auditResourceType: 'AssetAssignment',
        resourceIdArg: 'assignmentId',
        preview: async (a) => {
          const assignment = await this.prisma.assetAssignment.findUnique({
            where: { id: a.assignmentId as string },
            include: {
              asset: { select: { assetTag: true, name: true } },
              employee: { select: { fullName: true } },
            },
          });
          if (!assignment) {
            return { action: 'Return asset', warning: 'Assignment not found' };
          }
          return {
            action: 'Return asset',
            asset: `${assignment.asset.name} (${assignment.asset.assetTag})`,
            from: assignment.employee.fullName,
            alreadyReturned: assignment.returnedAt !== null,
            newAssetStatus: a.assetStatus ?? 'AVAILABLE',
          };
        },
        execute: (a, user) =>
          this.assignments.return(a.assignmentId as string, a as any, user.id),
      },

      {
        name: 'asset_clearance_check',
        description:
          'Whether an employee can be offboarded, and exactly which company assets they still hold. Offboarding is blocked while this returns cleared:false.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: { employeeId: z.string().uuid() },
        auditResourceType: 'AssetAssignment',
        resourceIdArg: 'employeeId',
        // The principal is passed through deliberately: `getClearanceStatus`
        // asserts branch and department scope on it, and a call without one
        // reads across every branch. An LLM tool is exactly the caller that
        // must not be the unscoped door the HTTP route no longer is.
        execute: async (a, user) => ({
          success: true,
          data: await this.clearance.getClearanceStatus(
            a.employeeId as string,
            user,
          ),
        }),
      },

      {
        name: 'asset_outstanding_report',
        description:
          'Assets still held by employees who are no longer active — an HR recovery worklist. These predate the clearance check or were let through by an override.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {},
        auditResourceType: 'AssetAssignment',
        execute: () => this.clearance.getOutstandingForInactive(),
      },
      {
        name: 'asset_acknowledge',
        description:
          'Acknowledge receipt of an asset assigned to the caller. The service enforces that only the holder can acknowledge.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          assignmentId: z.string().uuid(),
          note: z.string().max(500).optional(),
        },
        auditResourceType: 'AssetAssignment',
        resourceIdArg: 'assignmentId',
        preview: async (a) => ({ action: 'Acknowledge asset receipt', assignmentId: a.assignmentId }),
        execute: (a, user) =>
          this.assignments.acknowledge(a.assignmentId, { note: a.note } as any, user),
      },
    ];
  }
}
