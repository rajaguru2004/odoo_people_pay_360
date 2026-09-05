import type { RequestStatus } from './common';

/**
 * A LEAVE_TYPE library LABEL, not an enum.
 *
 * The organisation invents its own leave types, and a request stores the label
 * it was filed under rather than a reference to the library row — renaming an
 * entry must not rewrite the history of what was taken. Screens therefore match
 * labels case-insensitively and never switch on a fixed set.
 */
export type LeaveType = string;

export type LeaveStatus = RequestStatus;

export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveType: LeaveType;
  /** Date-only — through `formatDateOnly`, never an instant parse. */
  startDate: string;
  /** Date-only — through `formatDateOnly`, never an instant parse. */
  endDate: string;
  totalDays: number;
  reason: string;
  status: LeaveStatus;
  approverId?: string;
  approvedAt?: string;
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    /**
     * Joined by the API from the stored first/last names. Leave rows arrive
     * ready to print, so these screens use the field rather than re-joining
     * parts they were not sent.
     */
    fullName: string;
    department?: {
      id: string;
      name: string;
      managerId?: string;
    };
  };
  approver?: {
    id: string;
    email: string;
  };
  attachments?: LeaveAttachment[];
}

export interface LeaveAttachment {
  id: string;
  leaveRequestId: string;
  fileName: string;
  fileUrl: string;
  fileSize?: number;
  mimeType?: string;
  uploadedBy?: string;
  uploadedAt: string;
  uploader?: {
    id: string;
    email: string;
    employee?: {
      fullName: string;
      avatarUrl?: string;
    };
  };
}

export interface CreateLeaveRequestData {
  /** Omitted by an employee filing their own; the server narrows from the principal. */
  employeeId?: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason: string;
}

/** Per-leave-type entitlement for one employee and year. */
export interface LeaveTypeBalance {
  id: string;
  employeeId: string;
  year: number;
  leaveTypeKey: string;
  allocated: number;
  used: number;
  carriedOver: number;
  remaining: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface LeaveBalance {
  id: string;
  employeeId: string;
  year: number;
  annualLeave: number;
  usedAnnual: number;
  sickLeave: number;
  usedSick: number;
  carriedOver: number;
  remainingAnnual?: number;
  remainingSick?: number;
  /**
   * The employee's recorded gender, so a request form can decide which
   * gender-restricted types to offer by asking rather than by inferring it from
   * which buckets happen to exist. Null when the record does not say.
   */
  gender?: string | null;
  /**
   * The per-type rows, when the organisation has configured any. Empty for an
   * employee still on the two statutory buckets above, which is why every
   * screen that reads this also carries an annual/sick fallback.
   */
  leaveTypeBalances?: LeaveTypeBalance[];
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    gender?: string | null;
    department?: {
      name: string;
    };
  };
}

/** One configured leave type, as the library serves it. */
export interface LeaveTypeOption {
  id: string;
  label: string;
  isActive?: boolean;
  sortOrder?: number;
  defaultDays?: number | null;
  isPaid?: boolean;
  requiresNoticeDays?: number;
  /** false = the type is taken without drawing down an entitlement. */
  affectsBalance?: boolean;
  /** MALE | FEMALE, or null when the type is open to everyone. */
  genderRestriction?: string | null;
}

export interface LeaveRequestListQuery {
  employeeId?: string;
  status?: string;
  leaveType?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/** `/my-requests` is already narrowed to the caller, so it takes no paging. */
export interface MyLeaveRequestQuery {
  status?: string;
  leaveType?: string;
  startDate?: string;
  endDate?: string;
}

export interface CompanyLeaveTypeUsage {
  leaveTypeKey: string;
  totalAllocated: number;
  totalUsed: number;
  totalCarriedOver: number;
  totalRemaining: number;
  employeeCount: number;
}

export interface CompanyLeaveOverview {
  year: number;
  totalEmployees: number;
  leaveTypes: CompanyLeaveTypeUsage[];
  requestStats: {
    pending: number;
    approved: number;
    rejected: number;
    total: number;
  };
}

/** A manager's view of one team member's remaining days. */
export interface TeamLeaveBalance {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  position?: string | null;
  balances: {
    annual: { total: number; used: number; remaining: number };
    sick: { total: number; used: number; remaining: number };
  } | null;
}

export type ApproverType = 'SUPERVISOR' | 'MANAGER' | 'HR_MANAGER' | 'ADMIN';

export interface ApprovalTrailStep {
  id: string;
  stepOrder: number;
  approverType: ApproverType;
  /** PENDING | ACTIVE | APPROVED | REJECTED | SKIPPED */
  status: string;
  comment: string | null;
  decidedById: string | null;
  decidedAt: string | null;
}

/**
 * Who has acted on a request so far, and whether the CALLER may act now.
 *
 * `engaged: false` means no configured chain governs this request, and the
 * screen falls back to its own role rule. When a chain IS engaged, `canAct` is
 * the only usable gate: a step can route to a supervisor or a department
 * manager, neither of whom carries an approver role a client could check for.
 */
export interface ApprovalTrail {
  engaged: boolean;
  steps: ApprovalTrailStep[];
  activeStep: number | null;
  canAct: boolean;
}
