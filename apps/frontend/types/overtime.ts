import type { EmployeeRef, NamedRef, RequestStatus } from './common';

/** WEEKDAY, a rest day (SUNDAY) or a public holiday. Stored, not derived. */
export type OvertimeDayType = 'WEEKDAY' | 'SUNDAY' | 'HOLIDAY';

/**
 * The headline tier — a label above the four hour buckets, not a replacement for
 * them. A window that straddles the late threshold is `LATE` and still carries
 * regular hours.
 */
export type OvertimeType = 'REGULAR' | 'LATE' | 'DOUBLE' | 'DOUBLE_LATE';

/**
 * The server's live breakdown for a request.
 *
 * Computed on the server rather than in the browser: the figure depends on the
 * employee's overtime policy and on the branch-aware day classification, and a
 * page that recomputed from the global settings would show REGULAR where the
 * server said LATE — on the very screen that decides the money.
 */
export interface OvertimePreview {
  hours: number;
  regularHours: number;
  lateHours: number;
  doubleHours: number;
  doubleLateHours: number;
  dayType: OvertimeDayType;
  otType: OvertimeType;
  foodAllowance: number;
  /** Null means nobody overrode it; 0 is an approver's decision to pay none. */
  foodAllowanceOverride: number | null;
  siteAllowance: number;
  isDoubleOtDay: boolean;
  regularRate: number;
  lateRate: number;
  doubleRate: number;
  doubleLateRate: number;
  policyId: string | null;
  policyName: string | null;
  /** Present on an edit preview only: the corrected window. */
  startTime?: string;
  endTime?: string;
}

export interface OvertimeRequest {
  id: string;
  employeeId: string;
  /** Date-only. Render through `formatDateOnly`. */
  date: string;
  /**
   * Wall clock tagged UTC — an entered 17:30 is stored as "…T17:30:00Z". Render
   * with UTC getters, never in the browser's zone, or the hour drifts.
   */
  startTime: string;
  endTime: string;
  /** The payable total AFTER clamping to the attendance day boundary. */
  hours: string | number;
  regularHours: string | number;
  lateHours: string | number;
  doubleHours: string | number;
  doubleLateHours: string | number;
  dayType: OvertimeDayType;
  otType: OvertimeType;
  foodAllowance: string | number;
  siteAllowance: string | number;
  siteAllowanceNote: string | null;
  foodAllowanceOverride: string | number | null;
  approverNote: string | null;
  editedById: string | null;
  editedAt: string | null;
  /** What the employee filed, snapshotted on the first approver edit only. */
  originalStartTime: string | null;
  originalEndTime: string | null;
  overtimePolicyId: string | null;
  reason: string;
  status: RequestStatus;
  approverId: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: EmployeeRef & {
    departmentId?: string | null;
    supervisorId?: string | null;
    employmentType?: string | null;
    overtimePolicyId?: string | null;
    department?: { id: string; name: string } | null;
    branch?: NamedRef | null;
  };
  overtimePolicy?: { id: string; name: string } | null;
  approver?: { id: string; email: string } | null;
  editedBy?: { id: string; email: string } | null;
  /** Only on the by-id read. Null when the breakdown could not be resolved. */
  preview?: OvertimePreview | null;
}

export interface OvertimeListQuery {
  page?: number;
  limit?: number;
  employeeId?: string;
  status?: RequestStatus;
  otType?: OvertimeType;
  startDate?: string;
  endDate?: string;
  month?: number;
  year?: number;
  search?: string;
}

export interface CreateOvertimePayload {
  date: string;
  startTime: string;
  endTime: string;
  /**
   * What the employee believes they worked. Checked against the window and
   * refused when the two disagree by more than 0.1h — the server never silently
   * takes the typed figure over the times it was given.
   */
  hours: number;
  reason?: string;
}

export interface ApproveOvertimePayload {
  startTime?: string;
  endTime?: string;
  /** Absent leaves the policy in charge; 0 suppresses an allowance it would grant. */
  foodAllowance?: number;
  siteAllowance?: number;
  siteAllowanceNote?: string;
  approverNote?: string;
  /** Sent back so a concurrent second approver is refused with a 409. */
  expectedUpdatedAt?: string;
}

export interface OvertimeStats {
  pending: number;
  approved: number;
  rejected: number;
  cancelled: number;
  total: number;
  approvedHours: number;
  /** Null when nothing has been decided. */
  avgDecisionHours: number | null;
}

export interface OvertimeMonthlyReport {
  month: number;
  year: number;
  summary: {
    totalRequests: number;
    pending: number;
    approved: number;
    rejected: number;
    cancelled: number;
    totalHours: number;
    regularHours: number;
    lateHours: number;
    doubleHours: number;
    doubleLateHours: number;
    foodAllowance: number;
    siteAllowance: number;
  };
  byEmployee: Array<{
    employee:
      | (EmployeeRef & { department?: { id: string; name: string } | null })
      | null;
    requests: number;
    hours: number;
  }>;
}

export interface ApprovedOvertimeHours {
  employeeId: string;
  month: number;
  year: number;
  hours: number;
  regularHours: number;
  lateHours: number;
  doubleHours: number;
  doubleLateHours: number;
  foodAllowance: number;
  siteAllowance: number;
}

// ── Policies ────────────────────────────────────────────────────────────────

export interface OvertimeRateTier {
  regularRate: number;
  lateRate: number;
  lateThreshold: string;
}

export interface OvertimePolicyRules {
  eligible: boolean;
  holidayBehavior: 'STANDARD' | 'IGNORE';
  lateThreshold: string;
  regularRate: number;
  lateRate: number;
  doubleOtEnabled: boolean;
  doubleRate: number;
  doubleOtAllowAnytime: boolean;
  sunday: OvertimeRateTier;
  holiday: OvertimeRateTier;
  shiftEndTime: string;
  /** Null inherits the company day boundary. */
  dayEndBoundary: string | null;
  foodAllowanceEnabled: boolean;
  foodAllowanceAmount: number;
  foodAllowanceThreshold: string;
  doubleFoodAllowanceAnyTime: boolean;
  maxHoursPerDay: number;
  maxHoursPerDoubleDay: number;
  maxHoursPerMonth: number;
  maxHoursPerYear: number;
}

export interface OvertimePolicy {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  /** An EMPLOYMENT_TYPE library label, or null for an unscoped policy. */
  employmentType: string | null;
  schemaVersion: number;
  rules: OvertimePolicyRules;
  createdAt: string;
  updatedAt: string;
  _count?: { employees: number };
}

export type PolicyResolutionSource =
  | 'EMPLOYEE_OVERRIDE'
  | 'EMPLOYMENT_TYPE'
  | 'COMPANY_DEFAULT'
  | 'LEGACY_GLOBAL';

export interface ResolvedPolicy {
  employeeId: string;
  employeeName: string;
  employmentType: string | null;
  overtimePolicyId: string | null;
  source: PolicyResolutionSource;
  effectivePolicyId: string | null;
  effectivePolicyName: string | null;
  eligible: boolean;
  holidayBehavior: 'STANDARD' | 'IGNORE';
  rates: {
    regularRate: number;
    lateRate: number;
    lateThreshold: string;
    sunday: OvertimeRateTier;
    holiday: OvertimeRateTier;
  };
}

// ── Employee self-service aliases ───────────────────────────────────────────
// The self-service screens spell these two differently. Aliased rather than
// re-declared so there is still ONE definition of each union.

/** Where a request sits in its lifecycle. Mirrors the server enum. */
export type OvertimeStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** The self-service spelling of `OvertimeType`. */
export type OtType = OvertimeType;
