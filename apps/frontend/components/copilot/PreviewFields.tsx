'use client';

import { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

const TOOL_TITLES: Record<string, string> = {
  employee_create: 'Create Employee',
  employee_update: 'Update Employee',
  employee_delete: 'Delete Employee',
  leave_request_create: 'Submit Leave Request',
  leave_request_approve: 'Approve Leave Request',
  leave_request_reject: 'Reject Leave Request',
  leave_request_cancel: 'Cancel Leave Request',
  payroll_run: 'Run Payroll',
  payroll_item_update: 'Update Payroll Item',
  payroll_submit_for_approval: 'Submit Payroll for Approval',
  payroll_approve: 'Approve Payroll',
  payroll_reject: 'Reject Payroll',
  payroll_finalize: 'Finalize Payroll',
  payroll_lock: 'Lock Payroll',
  shift_create: 'Assign Shift',
  shift_delete: 'Delete Shift',
  department_create: 'Create Department',
  department_update: 'Update Department',
  department_delete: 'Delete Department',
  department_assign_manager: 'Assign Department Manager',
  project_create: 'Create Project',
  project_member_add: 'Add Project Member',
  task_create: 'Create Task',
  task_update: 'Update Task',
  task_assign: 'Assign Task',
  task_status_change: 'Change Task Status',
  attendance_manual_create: 'Add Manual Attendance',
  attendance_correction_approve: 'Approve Attendance Correction',
  attendance_correction_reject: 'Reject Attendance Correction',
  holiday_create: 'Create Holiday',
};

/** Human title for a tool, e.g. holiday_create -> "Create Holiday". */
export function friendlyToolTitle(tool: string): string {
  if (TOOL_TITLES[tool]) return TOOL_TITLES[tool];
  return tool
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const SPECIAL: Record<string, string> = {
  id: 'ID',
  employeeId: 'Employee',
  departmentId: 'Department',
  branchId: 'Branch',
  managerId: 'Manager',
  projectId: 'Project',
  leaveType: 'Leave Type',
  totalDays: 'Total Days',
  currentStatus: 'Current Status',
  startDate: 'Start Date',
  endDate: 'End Date',
  baseSalary: 'Base Salary',
  employeeCode: 'Employee Code',
  fullName: 'Full Name',
  requestedCheckIn: 'Requested Check-in',
  requestedCheckOut: 'Requested Check-out',
};

function humanize(key: string): string {
  if (SPECIAL[key]) return SPECIAL[key];
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .replace(/\bid\b/gi, 'ID')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

const isDateStr = (v: string) => /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(v);
const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Drop rows that are meaningless to people: bare UUID ids, and fooId UUIDs
 *  when a fooName sibling is present (the name row carries the meaning). */
function isNoiseRow(key: string, value: unknown, obj: Record<string, unknown>): boolean {
  if (!isUuid(value)) return false;
  if (key === 'id') return true;
  if (key.endsWith('Id')) {
    const base = key.slice(0, -2);
    return obj[`${base}Name`] !== undefined || obj[`${base}Code`] !== undefined;
  }
  return false;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return v.toLocaleString();
  if (typeof v === 'string') {
    if (isDateStr(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      }
    }
    return v;
  }
  return String(v);
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-right text-sm font-medium text-slate-800 break-words">{value}</span>
    </div>
  );
}

/** Turns a tool preview object into a clean, human-readable field list. */
export default function PreviewFields({ preview }: { preview: unknown }) {
  // Default preview wraps args as { arguments: {...} } — unwrap it.
  let data: any = preview;
  if (data && typeof data === 'object' && !Array.isArray(data) && 'arguments' in data && Object.keys(data).length === 1) {
    data = data.arguments;
  }

  if (data === null || data === undefined) {
    return <p className="text-sm text-slate-500">No details.</p>;
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return <p className="text-sm text-slate-700">{formatValue(data)}</p>;
  }

  const entries = Object.entries(data).filter(
    ([k, v]) => k !== 'action' && !isNoiseRow(k, v, data),
  );
  if (!entries.length) return <p className="text-sm text-slate-500">No details.</p>;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="divide-y divide-slate-100">
        {entries.map(([key, value]) => {
          if (key === 'warning') {
            return (
              <div key={key} className="flex items-start gap-2 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{String(value)}</span>
              </div>
            );
          }
          // Nested object → a small labeled group.
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const sub = Object.entries(value).filter(
              ([sk, vv]) =>
                vv !== null && vv !== undefined && vv !== '' && !isNoiseRow(sk, vv, value as Record<string, unknown>),
            );
            if (!sub.length) return null;
            return (
              <div key={key} className="px-3 py-2">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {humanize(key)}
                </p>
                <div className="divide-y divide-slate-50 rounded-md bg-slate-50/60">
                  {sub.map(([ck, cv]) => (
                    <Row key={ck} label={humanize(ck)} value={formatValue(cv)} />
                  ))}
                </div>
              </div>
            );
          }
          if (Array.isArray(value)) {
            return <Row key={key} label={humanize(key)} value={value.length ? value.map(formatValue).join(', ') : '—'} />;
          }
          return <Row key={key} label={humanize(key)} value={formatValue(value)} />;
        })}
      </div>
    </div>
  );
}
