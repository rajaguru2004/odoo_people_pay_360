import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BankService } from '../../bank-details/bank.service';
import { BankChangeService } from '../../bank-details/bank-change.service';
import { BankingConfigService } from '../../bank-details/banking-config.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

/**
 * MCP surface for Bank Master + country banking config + employee bank change
 * requests. Field schema is country-driven (no hardcoded IBAN/IFSC). Bank detail
 * values are PII, so reads are self-scoped for EMPLOYEE/MANAGER and getters mask
 * sensitive fields. All writes inherit the confirm gate.
 */
@Injectable()
export class BankDetailsTools implements DomainToolProvider {
  constructor(
    private readonly banks: BankService,
    private readonly bankChange: BankChangeService,
    private readonly bankingConfig: BankingConfigService,
  ) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'bank_master_list',
        description: 'List banks in the Bank Master, optionally filtered by ISO-2 country.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          country: z.string().length(2).optional().describe('ISO-2 code e.g. "OM"'),
          activeOnly: z.boolean().optional(),
        },
        auditResourceType: 'Bank',
        execute: (a) => this.banks.list(a.country, a.activeOnly ?? false),
      },
      {
        name: 'bank_master_create',
        description:
          'Add a bank to the Bank Master for a country. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: {
          country: z.string().length(2),
          name: z.string().min(1).max(255),
          bankCode: z.string().max(20).optional(),
          swift: z.string().min(8).max(11).optional(),
        },
        auditResourceType: 'Bank',
        preview: async (a) => ({
          action: 'Create bank',
          country: a.country.toUpperCase(),
          name: a.name,
          bankCode: a.bankCode,
        }),
        execute: (a, user) => this.banks.create(a, user.id),
      },
      {
        name: 'bank_master_update',
        description:
          'Update a bank (name, bankCode, swift, isActive). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: {
          id: z.string().uuid(),
          name: z.string().min(1).max(255).optional(),
          bankCode: z.string().max(20).optional(),
          swift: z.string().min(8).max(11).optional(),
          isActive: z.boolean().optional(),
        },
        auditResourceType: 'Bank',
        resourceIdArg: 'id',
        execute: (a, user) => {
          const { id, ...dto } = a;
          return this.banks.update(id, dto, user.id);
        },
      },
      {
        name: 'bank_master_deactivate',
        description:
          'Deactivate a bank so it can no longer be selected. Destructive: always requires confirm:true.',
        kind: 'destructive',
        roles: ['ADMIN'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'Bank',
        resourceIdArg: 'id',
        preview: async (a) => ({ action: 'Deactivate bank', id: a.id }),
        execute: (a, user) => this.banks.deactivate(a.id, user.id),
      },
      {
        name: 'employee_bank_detail_get',
        description:
          "Get an employee's active (approved) bank detail. Employees always get their own.",
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
        },
        auditResourceType: 'EmployeeBankDetail',
        resourceIdArg: 'employeeId',
        execute: async (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          // Config-driven, masked view of the active detail.
          return this.bankChange.currentForEmployee(employeeId);
        },
      },
      {
        name: 'banking_config_fields',
        description:
          'Get the active banking field schema for an ISO-2 country (drives dynamic forms + validation).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { country: z.string().length(2) },
        auditResourceType: 'CountryBankingField',
        execute: (a) =>
          this.bankingConfig
            .getFieldsForCountry(a.country)
            .then((data) => ({ success: true, data })),
      },
      {
        name: 'banking_config_upsert',
        description:
          'Create/update a country banking field (label, key, type, validation, order, required). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: {
          country: z.string().length(2),
          fieldKey: z.string().min(1).max(50),
          label: z.string().min(1).max(100),
          fieldType: z.enum(['TEXT', 'NUMBER', 'SELECT']).optional(),
          validationType: z.enum([
            'NONE', 'IBAN', 'IFSC', 'SWIFT', 'SORT_CODE', 'ROUTING', 'NUMBER', 'REGEX',
          ]),
          regex: z.string().max(500).optional(),
          required: z.boolean().optional(),
          displayOrder: z.number().int().min(0).optional(),
          placeholder: z.string().max(255).optional(),
          helpText: z.string().max(255).optional(),
          isSensitive: z.boolean().optional(),
          isActive: z.boolean().optional(),
        },
        auditResourceType: 'CountryBankingField',
        preview: async (a) => ({
          action: 'Upsert banking field',
          country: a.country.toUpperCase(),
          fieldKey: a.fieldKey,
          validationType: a.validationType,
        }),
        execute: (a, user) => this.bankingConfig.upsert(a, user.id),
      },
      {
        name: 'banking_config_seed_defaults',
        description:
          'Seed default banking field configs for shipped countries (OM, AE, IN, GB, US). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN'],
        inputSchema: {},
        auditResourceType: 'CountryBankingField',
        preview: async () => ({ action: 'Seed default banking field configs' }),
        execute: (_a, user) => this.bankingConfig.seedDefaults(user.id),
      },
      {
        name: 'bank_change_request_create',
        description:
          'Submit a bank detail change request. Provide bankId + a `data` map keyed by the country config fieldKeys (e.g. { iban } or { accountNumber, ifsc, accountHolderName }). Validated against the country schema + routed through the approval engine. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          bankId: z.string().uuid(),
          data: z
            .record(z.string(), z.string())
            .describe('fieldKey -> value, per the country config'),
        },
        auditResourceType: 'BankChangeRequest',
        preview: async (a) => ({
          action: 'Submit bank change request',
          bankId: a.bankId,
          fields: Object.keys(a.data ?? {}),
        }),
        execute: (a, user) => this.bankChange.create(a, user),
      },
      {
        name: 'bank_change_request_list',
        description:
          'List bank change requests, optionally by status. Non-privileged callers see only their own.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
        },
        auditResourceType: 'BankChangeRequest',
        execute: (a, user) => this.bankChange.listRequests(a.status, user),
      },
      {
        name: 'bank_change_request_decide',
        description:
          'Approve or reject the active step of a bank change request. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          decision: z.enum(['APPROVE', 'REJECT']),
          comment: z.string().max(1000).optional(),
        },
        auditResourceType: 'BankChangeRequest',
        resourceIdArg: 'id',
        preview: async (a) => ({
          action: `${a.decision === 'APPROVE' ? 'Approve' : 'Reject'} bank change request`,
          id: a.id,
        }),
        execute: (a, user) =>
          this.bankChange.decide(a.id, user, a.decision, a.comment),
      },
    ];
  }
}
