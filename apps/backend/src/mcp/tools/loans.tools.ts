import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AdvanceLoansService } from '../../advance-loans/advance-loans.service';
import { LoanLifecycleService } from '../../advance-loans/loan-lifecycle.service';
import { LoanReportsService } from '../../advance-loans/loan-reports.service';
import { LoanScheduleService } from '../../advance-loans/loan-schedule.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

/**
 * MCP tools for Advance & Loan.
 *
 * ACL lives in the services, never re-implemented here — `loan_get` calls
 * `findOne(id, user)` so the same predicate that guards the REST route guards
 * the tool.
 *
 * DELIBERATELY NOT EXPOSED: loan-type configuration, bulk import and exit
 * settlement. Configuration changes and bulk money movement should not be
 * reachable from a chat prompt. That is a decision, not an oversight.
 */
@Injectable()
export class LoanTools implements DomainToolProvider {
  constructor(
    private readonly loans: AdvanceLoansService,
    private readonly lifecycle: LoanLifecycleService,
    private readonly reports: LoanReportsService,
    private readonly schedules: LoanScheduleService,
  ) {}

  /** Compact summary used by every write tool's confirm-first preview. */
  private async loanPreview(id: string) {
    const quote: any = await this.lifecycle.payoffQuote(id);
    return {
      loanId: id,
      status: quote?.data?.status,
      outstandingPrincipal: quote?.data?.outstandingPrincipal,
      outstandingInterest: quote?.data?.outstandingInterest,
      payoffAmount: quote?.data?.payoffAmount,
    };
  }

  getTools(): McpToolDef[] {
    return [
      // ── read ────────────────────────────────────────────────────────────
      {
        name: 'loan_list',
        description:
          'List advance/loan requests, optionally filtered by status, type or employee. Paginated.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          status: z.string().optional().describe('CSV, e.g. "APPROVED,ACTIVE"'),
          type: z.enum(['ADVANCE', 'LOAN']).optional(),
          employeeId: z.string().uuid().optional(),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        auditResourceType: 'AdvanceLoan',
        execute: (a) =>
          this.loans.findAll(a.status, a.employeeId, a.type, a.page ?? 1, a.limit ?? 25),
      },
      {
        name: 'loan_get',
        description:
          'Get one advance/loan request with its employee, approver and repayment ledger.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        // The service performs the branch guard and the owner/HR/dept check.
        execute: (a, user) => this.loans.findOne(a.id, user),
      },
      {
        name: 'loan_my_requests',
        description: 'The current user\'s own advance/loan requests.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {},
        auditResourceType: 'AdvanceLoan',
        execute: (_a, user) => {
          if (!user?.employeeId) {
            throw new Error(
              'This account is not linked to an employee record, so it has no requests of its own.',
            );
          }
          return this.loans.findByEmployee(user.employeeId);
        },
      },
      {
        name: 'loan_schedule',
        description:
          'The live amortization schedule for a loan: instalment number, due date, principal/interest split and payment status.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        // The service performs the branch guard and the owner/HR/dept check.
        execute: (a, user) => this.schedules.listLive(a.id, user),
      },
      {
        name: 'loan_payoff_quote',
        description:
          'What it would cost to settle a loan today: outstanding principal, outstanding interest and the payoff total.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        execute: (a, user) => this.lifecycle.payoffQuote(a.id, user),
      },
      {
        name: 'loan_eligibility_check',
        description:
          'Whether an employee could borrow a given amount, with one pass/fail/warn row per rule (active-loan cap, service period, affordability, ceilings). Persists nothing.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          employeeId: z.string().uuid(),
          amount: z.number().positive(),
          installments: z.number().int().min(1).max(600).optional(),
          type: z.enum(['ADVANCE', 'LOAN']).optional(),
        },
        auditResourceType: 'AdvanceLoan',
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        execute: (a) =>
          this.loans.checkEligibility({
            employeeId: a.employeeId,
            amount: a.amount,
            installments: a.installments,
            type: a.type,
          }),
      },
      {
        name: 'loan_statement',
        description:
          'Full statement for one employee: every loan with its schedule and money events.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { employeeId: z.string().uuid() },
        auditResourceType: 'AdvanceLoan',
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        execute: (a) => this.reports.statement(a.employeeId),
      },
      {
        name: 'loan_report_outstanding',
        description:
          'Outstanding loan balance per employee. Amounts sitting in an unlocked payroll are reported separately as inFlight.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          asOf: z.string().optional(),
          departmentId: z.string().uuid().optional(),
          // Capped so a model is never handed a whole-book dump.
          limit: z.number().int().min(1).max(200).optional(),
        },
        auditResourceType: 'AdvanceLoan',
        execute: (a) =>
          this.reports.outstanding({
            asOf: a.asOf,
            departmentId: a.departmentId,
            limit: a.limit ?? 50,
          }),
      },
      {
        name: 'loan_report_emi_due',
        description: 'Instalments scheduled for a payroll cycle.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          month: z.number().int().min(1).max(12).optional(),
          year: z.number().int().min(2020).optional(),
        },
        auditResourceType: 'AdvanceLoan',
        execute: (a) => this.reports.emiDue({ month: a.month, year: a.year }),
      },
      {
        name: 'loan_report_overdue',
        description:
          'Overdue instalments aged into 1-30 / 31-60 / 61-90 / 90+ day buckets.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { asOf: z.string().optional() },
        auditResourceType: 'AdvanceLoan',
        execute: (a) => this.reports.overdue({ asOf: a.asOf }),
      },
      {
        name: 'loan_pending_approvals',
        description: 'Advance/loan requests awaiting the current user\'s decision.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {},
        auditResourceType: 'AdvanceLoan',
        execute: (_a, user) => this.loans.findPending(user),
      },

      // ── write (confirm-first) ───────────────────────────────────────────
      {
        name: 'loan_approve',
        description:
          'Approve a pending advance/loan request and generate its repayment schedule. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          installments: z.number().int().min(1).max(600).optional(),
          remarks: z.string().max(500).optional(),
        },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        preview: async (a, user) => ({
          action: 'Approve advance/loan request',
          request: await this.loans.findOne(a.id, user),
          installments: a.installments,
        }),
        execute: (a, user) =>
          this.loans.approve(a.id, user, {
            installments: a.installments,
            remarks: a.remarks,
          } as any),
      },
      {
        name: 'loan_reject',
        description: 'Reject a pending advance/loan request. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          remarks: z.string().max(500),
        },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        preview: async (a, user) => ({
          action: 'Reject advance/loan request',
          request: await this.loans.findOne(a.id, user),
          remarks: a.remarks,
        }),
        execute: (a, user) => this.loans.reject(a.id, user, { remarks: a.remarks } as any),
      },
      {
        name: 'loan_prepay',
        description:
          'Record a payment made outside payroll. Applied interest-first; a payment that clears the balance closes the loan. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          amount: z.number().positive(),
          mode: z.enum(['CASH', 'BANK', 'CHEQUE', 'ADJUSTMENT']).optional(),
          reference: z.string().max(120).optional(),
        },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        preview: async (a) => {
          const before = await this.loanPreview(a.id);
          return {
            action: 'Record a prepayment',
            before,
            amount: a.amount,
            outstandingAfter:
              Math.round((before.payoffAmount - a.amount) * 100) / 100,
          };
        },
        execute: (a, user) =>
          this.lifecycle.prepay(a.id, user, {
            amount: a.amount,
            mode: a.mode,
            reference: a.reference,
          }),
      },
      {
        name: 'loan_hold',
        description:
          'Pause payroll recovery for a loan (unpaid leave, sabbatical, dispute). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          reason: z.string().min(5).max(500),
          until: z.string().optional(),
        },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        preview: async (a) => ({
          action: 'Pause loan recovery',
          loan: await this.loanPreview(a.id),
          reason: a.reason,
          until: a.until ?? 'until explicitly resumed',
        }),
        execute: (a, user) =>
          this.lifecycle.hold(a.id, user, { reason: a.reason, until: a.until }),
      },
      {
        name: 'loan_resume',
        description: 'Resume payroll recovery for a held loan. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          reason: z.string().max(500).optional(),
        },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        preview: async (a) => ({
          action: 'Resume loan recovery',
          loan: await this.loanPreview(a.id),
        }),
        execute: (a, user) => this.lifecycle.resume(a.id, user, { reason: a.reason }),
      },
      {
        name: 'loan_close',
        description:
          'Close a loan whose residual is within the rounding tolerance — the small leftover after a final instalment. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          reason: z.string().min(5).max(500),
        },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        preview: async (a) => ({
          action: 'Close loan',
          loan: await this.loanPreview(a.id),
          note: 'Any residual within the rounding tolerance is written off as an adjustment.',
        }),
        execute: (a, user) => this.lifecycle.close(a.id, user, { reason: a.reason }),
      },

      // ── destructive ─────────────────────────────────────────────────────
      {
        name: 'loan_write_off',
        description:
          'Write off a loan balance. THIS PERMANENTLY FORGIVES COMPANY MONEY. Restricted to the roles in advance_loan_writeoff_roles. Requires confirm:true.',
        kind: 'destructive',
        roles: ['ADMIN'],
        inputSchema: {
          id: z.string().uuid(),
          amount: z.number().positive().optional(),
          reason: z.string().min(10).max(500),
        },
        auditResourceType: 'AdvanceLoan',
        resourceIdArg: 'id',
        preview: async (a) => {
          const loan = await this.loanPreview(a.id);
          return {
            action: 'WRITE OFF loan balance',
            loan,
            amount: a.amount ?? loan.outstandingPrincipal,
            warning:
              'This permanently forgives company money. It is reversible only via loan reinstate, and is always audited.',
          };
        },
        execute: (a, user) =>
          this.lifecycle.writeOff(a.id, user, { amount: a.amount, reason: a.reason }),
      },
    ];
  }
}
