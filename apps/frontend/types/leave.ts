import type { EmployeeRef, NamedRef, RequestStatus, UserRef } from './common';

/**
 * A leave type as the library defines it.
 *
 * `label` is the KEY, not just a caption: `LeaveRequest.leaveType` and
 * `LeaveTypeBalance.leaveTypeKey` both store this exact string, which is why a
 * form must submit the label rather than the id.
 */
export interface LeaveType {
  id: string;
  libraryType: 'LEAVE_TYPE';
  label: string;
  isActive: boolean;
  sortOrder: number;
  /** Days a fresh year allocates. Null means no standing entitlement. */
  defaultDays: number | null;
  isPaid: boolean;
  /** Minimum days between filing and the first day off. 0 means file it today. */
  requiresNoticeDays: number;
  /** False for unpaid leave: recorded, writes attendance, costs no balance. */
  affectsBalance: boolean;
  genderRestriction: 'MALE' | 'FEMALE' | null;
}

export interface LeaveAttachment {
  id: string;
  leaveRequestId: string;
  fileName: string;
  fileUrl: string;
  /** Bytes. The API sends a number; the column behind it is a BigInt. */
  fileSize: number | null;
  mimeType: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  uploader?: UserRef | null;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  /** A library LABEL — see {@link LeaveType}. */
  leaveType: string;
  /** Date-only. Render through `formatDateOnly`, never an instant parse. */
  startDate: string;
  endDate: string;
  /**
   * WORKING days, priced at filing from the branch calendar: the branch weekly
   * rest days and the holidays in force there are already removed. Stored, so a
   * branch that changes its working week does not re-price leave already taken.
   */
  totalDays: number;
  reason: string;
  status: RequestStatus;
  approverId: string | null;
  approvedAt: string | null;
  /** The approver's note on an approval, the reason on a rejection. */
  rejectedReason: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: EmployeeRef & {
    gender?: string | null;
    departmentId?: string | null;
    supervisorId?: string | null;
    department?: { id: string; name: string } | null;
    branch?: NamedRef | null;
    supervisor?: { id: string; firstName: string; lastName: string } | null;
  };
  approver?: { id: string; email: string } | null;
  attachments?: LeaveAttachment[];
}

export interface LeaveListQuery {
  page?: number;
  limit?: number;
  employeeId?: string;
  status?: RequestStatus;
  leaveType?: string;
  /** Requests OVERLAPPING the window, not only those starting inside it. */
  startDate?: string;
  endDate?: string;
  search?: string;
}

export interface CreateLeavePayload {
  /** Omit to file your own. Naming somebody else is an HR privilege. */
  employeeId?: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  reason: string;
}

export interface LeaveStats {
  pending: number;
  approved: number;
  rejected: number;
  cancelled: number;
  total: number;
  approvedDays: number;
  /** Null when nothing has been decided — zero would read as "instantly". */
  avgDecisionHours: number | null;
}

/**
 * What an approval reports back.
 *
 * `attendanceSkipped` is the count of days that already had an attendance row
 * and were left alone. It is surfaced rather than swallowed: silently skipping
 * meant a day of approved leave had no ON_LEAVE record behind it and nobody knew.
 */
export interface LeaveDecisionResult {
  success: boolean;
  message: string;
  data: LeaveRequest;
  meta?: { attendanceCreated: number; attendanceSkipped: number };
}

export interface LeaveTypeBalance {
  id: string;
  employeeId: string;
  year: number;
  leaveTypeKey: string;
  allocated: number;
  used: number;
  carriedOver: number;
  /** Derived server-side from the three above; never a stored fourth number. */
  remaining: number;
}

export interface LeaveBalance {
  id: string;
  employeeId: string;
  year: number;
  annualLeave: number;
  sickLeave: number;
  usedAnnual: number;
  usedSick: number;
  carriedOver: number;
  remainingAnnual: number;
  remainingSick: number;
  leaveTypeBalances: LeaveTypeBalance[];
  totals: {
    allocated: number;
    used: number;
    carriedOver: number;
    remaining: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeLeaveBalanceRow {
  employee: EmployeeRef & { department?: { id: string; name: string } | null };
  year: number;
  /**
   * Null when the year was never initialised. "Not set up yet" and "entitled to
   * nothing" are different facts, and a row printing 0 for both is wrong about
   * one of them.
   */
  headline: {
    annualLeave: number;
    usedAnnual: number;
    sickLeave: number;
    usedSick: number;
    carriedOver: number;
    remainingAnnual: number;
    remainingSick: number;
  } | null;
  leaveTypeBalances: LeaveTypeBalance[];
  totals: {
    allocated: number;
    used: number;
    carriedOver: number;
    remaining: number;
  };
}

export interface CompanyLeaveOverview {
  year: number;
  activeHeadcount: number;
  leaveTypes: Array<{
    leaveTypeKey: string;
    totalAllocated: number;
    totalUsed: number;
    totalCarriedOver: number;
    totalRemaining: number;
    /** Null when there was nothing to divide by. */
    utilisation: number | null;
    employeeCount: number;
  }>;
}

export interface TeamBalanceRow {
  employeeId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  position: string | null;
  avatarUrl: string | null;
  department: { id: string; name: string } | null;
  pendingRequests: number;
  balances:
    | Array<{
        leaveTypeKey: string;
        allocated: number;
        used: number;
        carriedOver: number;
        remaining: number;
      }>
    | null;
  remaining: number | null;
}

export interface LeaveAccrualRecord {
  id: string;
  employeeId: string;
  year: number;
  month: number;
  daysAdded: number;
  balanceBefore: number;
  balanceAfter: number;
  accrualType: 'AUTO' | 'MANUAL';
  triggeredBy: string | null;
  notes: string | null;
  createdAt: string;
  employee?: EmployeeRef & { department?: { id: string; name: string } | null };
}
