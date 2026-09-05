import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { BudgetsService } from '../../budgets/budgets.service';
import { BUDGET_STATUSES } from '../../budgets/dto/create-budget.dto';
import { DomainToolProvider, McpToolDef } from '../tool.types';

@Injectable()
export class BudgetsTools implements DomainToolProvider {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly prisma: PrismaService,
  ) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'budget_list',
        description: 'List HR budgets by fiscal year and status.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          fiscalYear: z.number().int().min(2000).optional(),
          status: z.enum(BUDGET_STATUSES).optional(),
        },
        auditResourceType: 'Budget',
        execute: (a) => this.budgets.findAll(a as any),
      },

      {
        name: 'budget_get',
        description: 'Get one budget with its lines.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Budget',
        resourceIdArg: 'id',
        execute: (a) => this.budgets.findOne(a.id as string),
      },

      {
        name: 'budget_variance_report',
        description:
          'Planned vs Committed vs Actual vs Remaining for a budget. Committed is money from approved-but-unspent travel/training; once the spend is paid it moves to Actual so it is never counted twice. Also reports real spend that has no budget line to attach to.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Budget',
        resourceIdArg: 'id',
        execute: (a) => this.budgets.varianceReport(a.id as string),
      },

      {
        name: 'budget_create',
        description:
          'Create a budget for a fiscal period. Fiscal, not calendar — the period need not start in January. Created DRAFT; only an ACTIVE budget attracts commitments. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          name: z.string().max(200),
          fiscalYear: z.number().int().min(2000),
          startDate: z.string().describe('YYYY-MM-DD'),
          endDate: z.string().describe('YYYY-MM-DD'),
          branchId: z.string().uuid(),
          currency: z.string().length(3).optional().describe('Default OMR'),
          status: z.enum(BUDGET_STATUSES).optional(),
        },
        auditResourceType: 'Budget',
        preview: async (a) => ({
          action: 'Create budget',
          name: a.name,
          period: `${a.startDate} → ${a.endDate}`,
          currency: a.currency ?? 'OMR',
        }),
        execute: (a, user) => this.budgets.create(a as any, user.id),
      },

      {
        name: 'budget_line_upsert',
        description:
          'Create or update a budget line for a (department, category). Omit departmentId for the company-wide fallback line — what spend attaches to when no department line matches. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          budgetId: z.string().uuid(),
          departmentId: z.string().uuid().optional(),
          category: z
            .string()
            .max(100)
            .describe('BUDGET_CATEGORY label: Payroll | Overtime | Travel | Training | …'),
          plannedAmount: z.number().min(0),
          notes: z.string().optional(),
        },
        auditResourceType: 'BudgetLine',
        resourceIdArg: 'budgetId',
        preview: async (a) => {
          const existing = await this.prisma.budgetLine.findFirst({
            where: {
              budgetId: a.budgetId as string,
              category: a.category as string,
              departmentId: (a.departmentId as string) ?? null,
            },
            select: { plannedAmount: true },
          });
          return {
            action: existing ? 'Update budget line' : 'Add budget line',
            category: a.category,
            scope: a.departmentId ? 'department' : 'company-wide',
            from: existing ? Number(existing.plannedAmount) : undefined,
            to: a.plannedAmount,
          };
        },
        execute: (a, user) =>
          this.budgets.upsertLine(a.budgetId as string, a as any, user.id),
      },

      {
        name: 'budget_set_status',
        description:
          'Set a budget DRAFT | ACTIVE | CLOSED. Only an ACTIVE budget attracts commitments from approved travel and training. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          status: z.enum(BUDGET_STATUSES),
        },
        auditResourceType: 'Budget',
        resourceIdArg: 'id',
        preview: async (a) => {
          const budget = await this.prisma.budget.findUnique({
            where: { id: a.id as string },
            select: { name: true, status: true },
          });
          return {
            action: 'Change budget status',
            budget: budget?.name ?? 'not found',
            from: budget?.status,
            to: a.status,
          };
        },
        execute: (a, user) =>
          this.budgets.setStatus(a.id as string, a.status as string, user.id),
      },
    ];
  }
}
