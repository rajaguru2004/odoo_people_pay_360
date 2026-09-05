import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { bootMcpHarness, McpHarness } from './utils/mcp-harness';

/**
 * Catalog, RBAC visibility, and read-tool coverage. No mutations here — every
 * write/destructive tool is exercised end-to-end in mcp-flows.e2e-spec.ts.
 */

const ALL_TOOLS = [
  // ── Advance & Loan ────────────────────────────────────────────────────
  'loan_list', 'loan_get', 'loan_my_requests', 'loan_schedule', 'loan_payoff_quote',
  'loan_eligibility_check', 'loan_statement', 'loan_report_outstanding',
  'loan_report_emi_due', 'loan_report_overdue', 'loan_pending_approvals',
  'loan_approve', 'loan_reject', 'loan_prepay', 'loan_hold', 'loan_resume',
  'loan_close', 'loan_write_off',
  'attendance_correction_approve', 'attendance_correction_pending_list', 'attendance_correction_reject',
  'attendance_employee_history', 'attendance_manual_create', 'attendance_monthly_report',
  'calendar_overview_get', 'department_assign_manager', 'department_create', 'department_delete',
  'department_get', 'department_list', 'department_update', 'employee_calendar_get', 'employee_create',
  'employee_delete', 'employee_directory', 'employee_field_schema', 'employee_get', 'employee_list',
  'employee_update',
  'holiday_create', 'holiday_list', 'leave_balance_get', 'leave_pending_approvals', 'leave_request_approve',
  'leave_request_cancel', 'leave_request_create', 'leave_request_list', 'leave_request_reject',
  'payroll_approve', 'payroll_finalize', 'payroll_get', 'payroll_item_update', 'payroll_list',
  'payroll_lock', 'payroll_reject', 'payroll_run', 'payroll_submit_for_approval', 'payslip_get',
  'project_create', 'project_get', 'project_list', 'project_member_add', 'report_headcount',
  'report_leave_overview', 'report_org_tree', 'report_payroll_summary', 'report_today_snapshot',
  'shift_create', 'shift_delete', 'task_assign', 'task_create', 'task_get', 'task_list',
  'task_status_change', 'task_update',
  // Appraisal analytics (date-range summaries)
  'attendance_employee_summary', 'conduct_records_get', 'leave_employee_summary',
  'overtime_employee_summary', 'project_contribution_get', 'reimbursement_employee_summary',
  'task_employee_stats', 'team_membership_get', 'timesheet_employee_summary',
  'worklog_employee_summary',
  // Visa lifecycle
  'visa_cancel', 'visa_create', 'visa_expiring_summary', 'visa_get', 'visa_list', 'visa_renew',
  // Supervisor assignment + configurable approval hierarchy
  'supervisor_assign', 'supervisor_unassign', 'supervisor_list_reports', 'supervisor_of',
  'approval_workflow_get', 'approval_workflow_set', 'approval_pending_for_me',
  // Overtime Policy engine
  'overtime_policy_list', 'overtime_policy_get', 'overtime_policy_resolve',
  'overtime_policy_create', 'overtime_policy_update', 'overtime_policy_set_default',
  'overtime_policy_assign', 'overtime_policy_delete',
  // Bank Master + versioned employee bank details (approval-engine backed)
  'bank_master_list', 'bank_master_create', 'bank_master_update', 'bank_master_deactivate',
  'employee_bank_detail_get', 'banking_config_fields', 'banking_config_upsert',
  'banking_config_seed_defaults', 'bank_change_request_create', 'bank_change_request_list',
  'bank_change_request_decide',
  // Asset register + offboarding clearance
  'asset_list', 'asset_get', 'asset_summary', 'asset_my_assets', 'asset_create',
  'asset_assign', 'asset_return', 'asset_clearance_check', 'asset_outstanding_report',
  // Travel — an extension of reimbursements (claims land on `reimbursements`)
  'travel_list', 'travel_get', 'travel_my_requests', 'travel_on_trip',
  'travel_create', 'travel_approve', 'travel_reject', 'travel_cancel',
  // Training — also a reimbursement extension; needs derived from the AI appraisal engine
  'course_list', 'course_create', 'training_session_list', 'training_session_create',
  'training_nomination_list', 'training_my_trainings', 'training_needs_from_appraisal',
  'training_nominate', 'training_nomination_decide', 'training_record_attendance',
  // HR budgeting — Planned / Committed / Actual / Remaining
  'budget_list', 'budget_get', 'budget_variance_report', 'budget_create',
  'budget_line_upsert', 'budget_set_status',
  // ESS self-service, reachable from a chat channel as well as the web.
  // Punching in and out used to be HTTP-only, so the copilot and every non-web
  // channel could READ attendance but not record it.
  'attendance_check_in', 'attendance_check_out', 'attendance_today_status',
  'attendance_lunch_start', 'attendance_lunch_end', 'attendance_lunch_status',
  'attendance_correction_create',
  'leave_my_requests',
  'overtime_my_requests', 'overtime_request_create', 'overtime_request_cancel',
  'overtime_pending_approvals', 'overtime_approve', 'overtime_reject',
  'payslip_list', 'payslip_ytd',
  'asset_acknowledge',
  // Expense claims. reimbursement_approve / _reject deliberately do NOT exist:
  // deciding somebody else's money belongs in the portal, and both names are
  // already on the WhatsApp denylist so adding them later cannot quietly make
  // them chat-reachable.
  'reimbursement_my_requests', 'reimbursement_create',
];

/**
 * Tools an ADMIN does NOT get.
 *
 * The mirror image of ADMIN_ONLY, and it exists for exactly one reason:
 * ReimbursementTools excludes ADMIN on purpose, following the controller —
 * admins administer expenses, they do not submit them, and an admin with no
 * employee record has nothing to return.
 */
const NOT_FOR_ADMIN = ['reimbursement_my_requests', 'reimbursement_create'];

const EMPLOYEE_TOOLS = [
  // Self-service loan reads. Every one is either self-scoped or ACL-checked
  // inside the service.
  'loan_get', 'loan_my_requests', 'loan_schedule', 'loan_payoff_quote',
  'loan_eligibility_check', 'loan_statement',
  'attendance_employee_history', 'department_list', 'employee_calendar_get', 'employee_directory',
  'holiday_list', 'leave_balance_get', 'leave_request_cancel', 'leave_request_create', 'payslip_get',
  'project_get', 'project_list', 'task_get', 'task_list', 'task_status_change', 'visa_list',
  'approval_pending_for_me',
  // Bank self-service: an employee reads their own bank detail and raises a change
  // request; bank_master_list + banking_config_fields are the reference data that
  // request form needs (company-wide, read-only).
  'employee_bank_detail_get', 'bank_change_request_create', 'bank_change_request_list',
  'bank_master_list', 'banking_config_fields',
  // ESS: an employee sees the company assets they hold and acknowledges receipt.
  'asset_my_assets',
  // ESS: an employee raises and tracks their own trips, and can be a chain step.
  'travel_get', 'travel_my_requests', 'travel_create', 'travel_approve',
  'travel_reject', 'travel_cancel',
  // ESS: browse the catalogue, see own training record, act as a chain step.
  'course_list', 'training_session_list', 'training_my_trainings',
  'training_nomination_decide',
  // ESS self-service. Every one is self-scoped: an EMPLOYEE reaching these
  // gets their own record and nobody else's, enforced by the executor rather
  // than by the tool.
  'attendance_check_in', 'attendance_check_out', 'attendance_today_status',
  'attendance_lunch_start', 'attendance_lunch_end', 'attendance_lunch_status',
  'attendance_correction_create',
  'leave_my_requests',
  'overtime_my_requests', 'overtime_request_create', 'overtime_request_cancel',
  'payslip_list', 'payslip_ytd',
  'asset_acknowledge',
  'reimbursement_my_requests', 'reimbursement_create',
];

const ADMIN_ONLY = [
  // Writing off a loan permanently forgives company money.
  'loan_write_off',
  'department_delete', 'employee_delete', 'payroll_approve', 'payroll_reject', 'approval_workflow_set',
  'overtime_policy_create', 'overtime_policy_update', 'overtime_policy_set_default', 'overtime_policy_delete',
  // Bank/banking master data is ADMIN-only to write; HR can only decide change requests.
  'bank_master_create', 'bank_master_update', 'bank_master_deactivate',
  'banking_config_upsert', 'banking_config_seed_defaults',
];

describe('MCP catalog & reads (e2e)', () => {
  let h: McpHarness;
  let admin: Client;
  let hr: Client;
  let manager: Client;
  let employee: Client;

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  beforeAll(async () => {
    h = await bootMcpHarness();
    admin = await h.client(h.fx.globalAdmin.token);
    hr = await h.client(h.fx.scopedHr.token);
    manager = await h.client(h.manager.token);
    employee = await h.client(h.fx.plainEmployee.token);
  }, 120000);

  afterAll(async () => {
    await h?.teardown();
  }, 120000);

  const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

  describe('tools/list visibility per role', () => {
    it('ADMIN sees every registered tool except the ones admins do not submit', async () => {
      expect(await names(admin)).toEqual(
        ALL_TOOLS.filter((t) => !NOT_FOR_ADMIN.includes(t)).sort(),
      );
    });

    it('HR_MANAGER sees all but the ADMIN-only tools', async () => {
      const hrNames = await names(hr);
      expect(hrNames).toHaveLength(ALL_TOOLS.length - ADMIN_ONLY.length);
      for (const t of ADMIN_ONLY) expect(hrNames).not.toContain(t);
      expect(hrNames).toEqual(expect.arrayContaining(['payroll_run', 'payroll_finalize', 'employee_create']));
    });

    it('MANAGER sees a mid-tier subset', async () => {
      const mgr = await names(manager);
      expect(mgr).toEqual(expect.arrayContaining(['employee_list', 'leave_pending_approvals', 'task_create']));
      expect(mgr).not.toContain('payroll_run');
      expect(mgr).not.toContain('shift_create');
      expect(mgr).not.toContain('employee_delete');
    });

    it('EMPLOYEE sees exactly the self-service tools', async () => {
      expect(await names(employee)).toEqual([...EMPLOYEE_TOOLS].sort());
    });

    it('advertises confirm-first + destructive hints in tool annotations', async () => {
      const tools = (await admin.listTools()).tools;
      const del = tools.find((t) => t.name === 'employee_delete');
      const list = tools.find((t) => t.name === 'employee_list');
      expect((del?.annotations as any)?.destructiveHint).toBe(true);
      expect((del?.inputSchema as any)?.properties?.confirm).toBeDefined();
      expect((list?.annotations as any)?.readOnlyHint).toBe(true);
      expect((list?.inputSchema as any)?.properties?.confirm).toBeUndefined();
    });
  });

  describe('read tools return valid payloads', () => {
    it('employee_list is branch-scoped and paginated', async () => {
      const body = await h.callOk(admin, 'employee_list', { search: h.fx.runId, limit: 50 });
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('employee_get returns one employee', async () => {
      const body = await h.callOk(admin, 'employee_get', { id: h.fx.empAId });
      expect(body.data?.id ?? body.id).toBe(h.fx.empAId);
    });

    it('employee_field_schema describes the fields and how to submit them', async () => {
      // The assistant needs this before it can fill a form it did not design;
      // template CONFIGURATION stays off MCP deliberately.
      const body = await h.callOk(admin, 'employee_field_schema', {});
      expect(Array.isArray(body.sections)).toBe(true);
      const fields = body.sections.flatMap((sec: any) => sec.fields);
      const fullName = fields.find((f: any) => f.key === 'fullName');
      expect(fullName).toBeDefined();
      expect(fullName.required).toBe(true);
      // Bound fields go at the top level; custom ones inside the envelope.
      expect(fullName.submitAs).toBe('fullName');
      expect(fullName.custom).toBe(false);
    });

    it('employee_directory works for employees', async () => {
      const body = await h.callOk(employee, 'employee_directory', {});
      expect(body).toBeDefined();
    });

    it('leave_request_list / leave_pending_approvals', async () => {
      await h.callOk(admin, 'leave_request_list', {});
      await h.callOk(admin, 'leave_pending_approvals', {});
    });

    it('leave_balance_get auto-inits and returns the caller balance', async () => {
      const body = await h.callOk(employee, 'leave_balance_get', {});
      const bal = body.data ?? body;
      expect(bal.employeeId).toBe(h.fx.plainEmployee.employeeId);
    });

    it('payroll_list', async () => {
      const body = await h.callOk(admin, 'payroll_list', {});
      expect(body).toBeDefined();
    });

    it('employee_calendar_get / calendar_overview_get (results are human-enriched)', async () => {
      const start = iso(new Date(year, month - 1, 1));
      const end = iso(new Date(year, month, 0));
      await h.callOk(employee, 'employee_calendar_get', { startDate: start, endDate: end });

      // Seed one schedule so the overview has an employeeId-bearing row, then
      // assert the enricher attached the human identity next to the raw id.
      const schedule = await h.prisma.workSchedule.create({
        data: {
          employeeId: h.fx.empAId,
          date: new Date(`${iso(new Date(year, month - 1, 15))}T00:00:00.000Z`),
          shiftType: 'FULL_DAY',
          isWorkDay: true,
        },
      });
      try {
        // Narrow window (single day) so the payload stays under the size cap.
        const day = iso(new Date(year, month - 1, 15));
        const body = await h.callOk(admin, 'calendar_overview_get', { startDate: day, endDate: day });
        const rows = (body.data?.schedules ?? body.schedules ?? []) as any[];
        const mine = rows.find((s) => s.employeeId === h.fx.empAId);
        expect(mine).toBeDefined();
        expect(mine.employeeName).toBe('Alice BranchA');
        expect(mine.employeeCode).toContain(h.fx.runId);
        expect(mine.departmentName).toBeDefined();
      } finally {
        await h.prisma.workSchedule.delete({ where: { id: schedule.id } }).catch(() => 0);
      }
    });

    it('department_list / department_get', async () => {
      await h.callOk(admin, 'department_list', {});
      const body = await h.callOk(admin, 'department_get', { id: h.fx.deptId });
      expect(body.data?.id ?? body.id).toBe(h.fx.deptId);
    });

    it('project_list / task_list', async () => {
      await h.callOk(admin, 'project_list', {});
      await h.callOk(admin, 'task_list', {});
    });

    it('attendance reads', async () => {
      await h.callOk(admin, 'attendance_employee_history', { employeeId: h.fx.empAId, month, year });
      await h.callOk(admin, 'attendance_monthly_report', { month, year });
      await h.callOk(admin, 'attendance_correction_pending_list', {});
    });

    it('holiday_list', async () => {
      await h.callOk(admin, 'holiday_list', { year });
    });

    it('all report tools', async () => {
      await h.callOk(admin, 'report_headcount', {});
      await h.callOk(admin, 'report_org_tree', {});
      await h.callOk(admin, 'report_payroll_summary', { year });
      await h.callOk(admin, 'report_today_snapshot', {});
      await h.callOk(admin, 'report_leave_overview', { year });
    });
  });
});
