import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { EmployeesService } from '../../employees/employees.service';
import { ProfileTemplateResolverService } from '../../profile-templates/profile-template-resolver.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';
import { actorFor } from '../../common/utils/self-service.util';

@Injectable()
export class EmployeeTools implements DomainToolProvider {
  constructor(
    private readonly employees: EmployeesService,
    private readonly templates: ProfileTemplateResolverService,
  ) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'employee_list',
        description:
          'List employees with optional search (name/email/code) and filters. Paginated.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          search: z.string().optional().describe('Match against name, email or employee code'),
          departmentId: z.string().uuid().optional(),
          position: z.string().optional(),
          status: z.enum(['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED']).optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        auditResourceType: 'Employee',
        execute: (a) => this.employees.findAll(a),
      },
      {
        // READ-ONLY on purpose. Template CONFIGURATION is deliberately not
        // exposed to MCP: an admin changing which fields exist should not be
        // reachable from a chat prompt. This
        // tool only answers "what fields does an employee have here", which the
        // assistant needs before it can sensibly fill any of them in.
        name: 'employee_field_schema',
        description:
          'The active employee profile template: which fields exist, their types, whether they are required, and whether they are custom. Read-only; does not modify configuration.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          branchId: z
            .string()
            .uuid()
            .optional()
            .describe('Resolve the template for this branch; omit for the company default'),
        },
        auditResourceType: 'ProfileTemplate',
        execute: async (a) => {
          const tpl = await this.templates.resolve(a.branchId ?? null);
          return {
            source: tpl.source,
            country: tpl.country,
            enabled: tpl.enabled,
            sections: tpl.sections.map((s) => ({
              key: s.sectionKey,
              label: s.label,
              fields: s.fields.map((f) => ({
                key: f.fieldKey,
                label: f.label,
                type: f.fieldType,
                required: f.required,
                custom: f.storage === 'JSONB',
                // So a caller knows to send it under `customFields`.
                submitAs: f.storage === 'JSONB' ? `customFields.${f.fieldKey}` : f.fieldKey,
                options: Array.isArray(f.options) ? f.options : undefined,
                helpText: f.helpText ?? undefined,
              })),
            })),
          };
        },
      },
      {
        name: 'employee_get',
        description: 'Get one employee by id with full details (profile, department, contract).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Employee',
        resourceIdArg: 'id',
        execute: (a) => this.employees.findOne(a.id),
      },
      {
        name: 'employee_directory',
        description: 'Public employee directory (name, position, department). Safe for all roles.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { search: z.string().optional() },
        auditResourceType: 'Employee',
        execute: (a) => this.employees.directory(a.search),
      },
      {
        name: 'employee_create',
        description:
          'Create a new employee. Dates are YYYY-MM-DD. Requires confirm:true after preview.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          fullName: z.string().min(1),
          email: z.string().email(),
          dateOfBirth: z.string().describe('YYYY-MM-DD'),
          idCard: z.string().optional().describe('National ID number; omit to auto-generate'),
          autoGenerateIdCard: z.boolean().optional(),
          gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
          phone: z.string().optional(),
          address: z.string().optional(),
          departmentId: z.string().uuid(),
          branchId: z.string().uuid().optional().describe('Defaults to the caller active branch'),
          position: z.string().min(1),
          startDate: z.string().describe('YYYY-MM-DD'),
          baseSalary: z
            .number()
            .nonnegative()
            .describe(
              'Monthly amount when salaryType is MONTHLY; a PER-DAY rate when it is DAILY',
            ),
          salaryType: z
            .enum(['MONTHLY', 'DAILY'])
            .optional()
            .describe(
              'Pay basis. DAILY = daily wage, paid strictly for days actually worked. Defaults to MONTHLY. Ignored when employmentType fixes the basis.',
            ),
          employmentType: z
            .string()
            .optional()
            .describe(
              'EMPLOYMENT_TYPE library label (see library_items_list). Drives the overtime policy, and when that item carries a pay basis it DERIVES salaryType — so setting a daily-wage employment type is enough to make baseSalary a per-day rate.',
            ),
        },
        auditResourceType: 'Employee',
        execute: (a) => this.employees.create(a),
      },
      {
        name: 'employee_update',
        description:
          'Update fields of an existing employee (only provided fields change). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          fullName: z.string().optional(),
          email: z.string().email().optional(),
          phone: z.string().optional(),
          address: z.string().optional(),
          departmentId: z.string().uuid().optional(),
          position: z.string().optional(),
          baseSalary: z.number().nonnegative().optional(),
          salaryType: z
            .enum(['MONTHLY', 'DAILY'])
            .optional()
            .describe(
              'Pay basis — changing it re-interprets baseSalary. Rejected when employmentType fixes the basis; change the employment type instead.',
            ),
          employmentType: z
            .string()
            .optional()
            .describe(
              'EMPLOYMENT_TYPE library label. When that item carries a pay basis it DERIVES salaryType, re-interpreting baseSalary.',
            ),
          status: z.enum(['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED']).optional(),
        },
        auditResourceType: 'Employee',
        resourceIdArg: 'id',
        preview: async (a) => {
          const current: any = await this.employees.findOne(a.id);
          const cur = current?.data ?? current;
          const { id: _id, ...changes } = a;
          // Surface the DERIVED pay basis, not just the fields sent. Changing
          // only the employment type can silently flip baseSalary from a
          // monthly amount to a per-day rate — the operator confirming this
          // write needs to see that before it happens.
          const nextEmploymentType =
            a.employmentType !== undefined ? a.employmentType : cur?.employmentType;
          const derived =
            await this.employees.payBasisForEmploymentType(nextEmploymentType);
          const nextBasis =
            derived ?? a.salaryType ?? cur?.salaryType ?? 'MONTHLY';
          return {
            action: 'Update employee',
            employee: { id: a.id, fullName: cur?.fullName, email: cur?.email, position: cur?.position },
            changes,
            payBasis: {
              current: cur?.salaryType ?? 'MONTHLY',
              afterUpdate: nextBasis,
              ...(derived ? { fixedByEmploymentType: nextEmploymentType } : {}),
              note:
                nextBasis === 'DAILY'
                  ? 'baseSalary is a PER-DAY rate for this employee.'
                  : 'baseSalary is a monthly amount for this employee.',
            },
          };
        },
        execute: (a, user) => {
          const { id, ...dto } = a;
          // A chat session is still a person with a role. Omitting the actor
          // here would skip the template's per-field write rules and make MCP
          // a way around permissions the HTTP route enforces.
          return this.employees.update(
            id,
            dto,
            user.id,
            actorFor({ role: user.role, employeeId: user.employeeId ?? undefined }, id),
          );
        },
      },
      {
        name: 'employee_delete',
        description:
          'Soft-delete (deactivate) an employee. Destructive — always requires confirm:true.',
        kind: 'destructive',
        roles: ['ADMIN'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Employee',
        resourceIdArg: 'id',
        preview: async (a) => {
          const current: any = await this.employees.findOne(a.id);
          const cur = current?.data ?? current;
          return {
            action: 'Soft-delete employee',
            employee: { id: a.id, fullName: cur?.fullName, email: cur?.email, status: cur?.status },
            warning: 'The employee will be deactivated and hidden from active lists.',
          };
        },
        execute: (a) => this.employees.delete(a.id),
      },
    ];
  }
}
