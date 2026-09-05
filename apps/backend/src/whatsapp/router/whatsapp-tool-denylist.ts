/**
 * Tools that must never be reachable over WhatsApp, whatever anyone adds later.
 *
 * The primary control is allowlist-by-construction: only a tool named by a
 * registered action is callable. This list is the second lock, checked at boot,
 * so someone who adds an action for one of these gets a startup failure instead
 * of a silent capability grant.
 */
export const WHATSAPP_TOOL_DENYLIST: readonly string[] = [
  // Bank details. A payroll-destination change initiated from a channel that a
  // SIM swap can capture is the highest-value fraud target in an HRMS, and the
  // web already has a proper approval workflow for it.
  'bank_change_request_create',
  'bank_change_request_list',
  'bank_change_request_decide',
  'employee_bank_detail_get',
  'bank_master_list',
  'bank_master_create',
  'bank_master_update',
  'bank_master_deactivate',
  'banking_config_fields',
  'banking_config_upsert',
  'banking_config_seed_defaults',

  // Running, editing or releasing money.
  'payroll_run',
  'payroll_item_update',
  'payroll_submit_for_approval',
  'payroll_approve',
  'payroll_reject',
  'payroll_finalize',
  'payroll_lock',

  // Loan money movement (reading a statement is fine; moving it is not).
  'loan_prepay',
  'loan_hold',
  'loan_resume',
  'loan_close',
  'loan_write_off',
  'loan_request_create',

  // Changing the rules, or recording attendance for somebody else.
  'approval_workflow_set',
  'attendance_manual_create',
  'asset_assign',
  'asset_return',
  'asset_create',

  // Employee and org administration.
  'employee_create',
  'employee_update',
  'employee_delete',
  'department_create',
  'department_update',
  'department_delete',
  'department_assign_manager',
  'supervisor_assign',
  'supervisor_unassign',

  // Money decisions about somebody else. Listed BEFORE the tools exist, so
  // adding them later cannot quietly make them reachable from a chat.
  'reimbursement_approve',
  'reimbursement_reject',
];

export function isDeniedTool(name: string): boolean {
  return WHATSAPP_TOOL_DENYLIST.includes(name);
}
