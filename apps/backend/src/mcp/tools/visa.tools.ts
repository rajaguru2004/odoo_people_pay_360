import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { LegalDocumentsService } from '../../legal-documents/legal-documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

const VISA_STATUSES = ['ACTIVE', 'EXPIRED', 'RENEWED', 'CANCELLED'] as const;

@Injectable()
export class VisaTools implements DomainToolProvider {
  constructor(
    private readonly legalDocs: LegalDocumentsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Human-readable preview of a visa write for the confirm gate. */
  private async visaPreview(action: string, id: string, extra?: Record<string, unknown>) {
    const doc = await this.prisma.employeeLegalDocument.findUnique({
      where: { id },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
    });
    if (!doc) return { action, id, warning: 'Record not found' };
    return {
      action,
      visa: {
        id: doc.id,
        employee: `${doc.employee.fullName} (${doc.employee.employeeCode})`,
        documentNumber: doc.documentNumber,
        documentType: doc.documentType,
        country: doc.country,
        status: doc.status,
        issueDate: doc.issueDate,
        expiryDate: doc.expiryDate,
      },
      ...extra,
    };
  }

  getTools(): McpToolDef[] {
    return [
      {
        name: 'visa_list',
        description:
          'List employee visa records with filters (employee, status, country, type, expiring window). Employees see only their own. Paginated.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE'] },
        inputSchema: {
          employeeId: z.string().uuid().optional(),
          status: z.enum(VISA_STATUSES).optional(),
          country: z.string().optional(),
          documentType: z.string().optional().describe('Visa type label, e.g. "Employment Visa"'),
          expiringInDays: z.number().int().min(1).max(365).optional()
            .describe('Only ACTIVE visas expiring within N days'),
          isCurrent: z.boolean().optional().describe('true = only current records (excludes history)'),
          search: z.string().optional().describe('Visa number / country / employee name or code'),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        auditResourceType: 'EmployeeLegalDocument',
        execute: (a) =>
          this.legalDocs.findAll({
            employeeId: a.employeeId,
            status: a.status,
            country: a.country,
            documentType: a.documentType,
            expiringInDays: a.expiringInDays?.toString(),
            isCurrent: a.isCurrent === undefined ? undefined : String(a.isCurrent),
            search: a.search,
            page: a.page?.toString(),
            limit: a.limit?.toString(),
          }),
      },
      {
        name: 'visa_get',
        description:
          'Get one visa record by id, including its renewal chain (history) and attachments.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
        },
        auditResourceType: 'EmployeeLegalDocument',
        resourceIdArg: 'id',
        execute: (a) => this.legalDocs.findOne(a.id),
      },
      {
        name: 'visa_expiring_summary',
        description:
          'Visa lifecycle overview: counts by status (active / expiring soon / expired / cancelled / renewed this year) plus the list of visas expiring within N days (default = configured alert window).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          days: z.number().int().min(1).max(365).optional()
            .describe('Expiry window in days; omit to use the configured alert setting'),
        },
        auditResourceType: 'EmployeeLegalDocument',
        execute: async (a) => {
          const days = a.days ?? (await this.legalDocs.getAlertDays());
          const [summary, expiring] = await Promise.all([
            this.legalDocs.getSummary(),
            this.legalDocs.getExpiring(days),
          ]);
          return { summary: summary.data, expiringWithinDays: days, expiring: expiring.data };
        },
      },
      {
        name: 'visa_create',
        description:
          'Create a visa record for an employee (dates YYYY-MM-DD). One current visa per employee+country. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          employeeId: z.string().uuid(),
          documentNumber: z.string().min(1).max(100),
          documentType: z.string().min(1).max(100).describe('VISA_TYPE library label, e.g. "Employment Visa"'),
          country: z.string().min(1).max(100),
          issueDate: z.string().describe('YYYY-MM-DD'),
          expiryDate: z.string().describe('YYYY-MM-DD'),
          issuingAuthority: z.string().max(200).optional(),
          placeOfIssue: z.string().max(200).optional(),
          sponsor: z.string().max(200).optional(),
          remarks: z.string().optional(),
        },
        auditResourceType: 'EmployeeLegalDocument',
        execute: (a, user) => this.legalDocs.create(a as any, user.id),
      },
      {
        name: 'visa_renew',
        description:
          'Renew a visa: creates a NEW record linked to the old one; the old record is kept as history (status RENEWED). Requires confirm:true after reviewing the preview.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid().describe('Current visa record id to renew'),
          documentNumber: z.string().min(1).max(100).describe('New visa number'),
          issueDate: z.string().describe('New issue date YYYY-MM-DD'),
          expiryDate: z.string().describe('New expiry date YYYY-MM-DD'),
          documentType: z.string().max(100).optional().describe('Override visa type'),
          issuingAuthority: z.string().max(200).optional(),
          placeOfIssue: z.string().max(200).optional(),
          sponsor: z.string().max(200).optional(),
          remarks: z.string().optional(),
        },
        auditResourceType: 'EmployeeLegalDocument',
        resourceIdArg: 'id',
        preview: (a) =>
          this.visaPreview('Renew visa (old record becomes history)', a.id, {
            newDocumentNumber: a.documentNumber,
            newIssueDate: a.issueDate,
            newExpiryDate: a.expiryDate,
          }),
        execute: (a, user) => {
          const { id, ...dto } = a;
          return this.legalDocs.renew(id, dto as any, user.id);
        },
      },
      {
        name: 'visa_cancel',
        description:
          'Cancel a visa record (revoked / employee left). Requires confirm:true after reviewing the preview.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          reason: z.string().max(500).optional(),
        },
        auditResourceType: 'EmployeeLegalDocument',
        resourceIdArg: 'id',
        preview: (a) => this.visaPreview('Cancel visa', a.id, { reason: a.reason }),
        execute: (a) => this.legalDocs.cancel(a.id, { reason: a.reason }),
      },
    ];
  }
}
