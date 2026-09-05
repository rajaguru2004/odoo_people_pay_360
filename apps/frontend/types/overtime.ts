import { SalaryType } from './employee';
export type OvertimeStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type OtType = 'REGULAR' | 'LATE' | 'DOUBLE' | 'DOUBLE_LATE';

export interface Overtime {
  id: string;
  employeeId: string;
  date: string;
  startTime: string;
  endTime: string;
  hours: number;
  regularHours?: number | string;
  lateHours?: number | string;
  doubleHours?: number | string;
  foodAllowance?: number | string;
  /**
   * Approver-granted per request. Never derived, so nothing recomputes it —
   * see the note on `foodAllowanceOverride`.
   */
  siteAllowance?: number | string;
  siteAllowanceNote?: string | null;
  /**
   * `null` means the policy still decides the food allowance. A value, `0`
   * included, is an approver's explicit override and wins at approval.
   */
  foodAllowanceOverride?: number | string | null;
  approverNote?: string | null;
  editedById?: string | null;
  editedAt?: string | null;
  /** The window as the employee filed it, kept from the FIRST correction only. */
  originalStartTime?: string | null;
  originalEndTime?: string | null;
  otType?: OtType;
  /**
   * Server-computed live breakdown (detail endpoint only). Authoritative: it
   * resolves the employee's Overtime Policy and the branch-aware rest-day /
   * holiday classification, which a client-side recompute from the GLOBAL
   * branding settings cannot see.
   */
  preview?: OvertimeServerPreview | null;
  reason: string;
  status: OvertimeStatus;
  approverId?: string;
  approvedAt?: string;
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    email: string;
    baseSalary?: number;
    /**
     * Pay basis — the hourly-rate preview divides a monthly salary by the
     * month's work days but a daily rate by one day's hours. Absent = MONTHLY.
     */
    salaryType?: SalaryType;
    branchId?: string | null;
    department?: {
      id: string;
      name: string;
    };
  };
}

/** Live payable breakdown returned by GET /overtime/:id — see Overtime.preview. */
export interface OvertimeServerPreview {
  hours: number | string;
  regularHours: number | string;
  lateHours: number | string;
  /** Double-tier hours BEFORE the double-day late threshold. */
  doubleHours: number | string;
  /** Double-tier hours FROM the double-day late threshold onward. */
  doubleLateHours: number | string;
  dayType: 'WEEKDAY' | 'SUNDAY' | 'HOLIDAY';
  foodAllowance: number | string;
  otType: OtType;
  isDoubleOtDay: boolean;
  /** Multipliers already picked for this row's day type. */
  regularRate: number;
  lateRate: number;
  doubleRate: number;
  doubleLateRate: number;
  policyId: string | null;
  policyName: string | null;
  /** Carried through, never recomputed. */
  siteAllowance?: number | string;
  foodAllowanceOverride?: number | string | null;
  /** Present on an edit-preview response: the window the figures describe. */
  startTime?: string;
  endTime?: string;
}

/**
 * An approver's corrections, sent on approve or dry-run through
 * `POST /overtime/:id/edit-preview`.
 *
 * Every field is optional and an empty object means "approve as filed" — the
 * inbox's fast-path Approve sends no payload at all.
 */
export interface ApproveOvertimeData {
  startTime?: string;
  endTime?: string;
  /** Absent = the policy decides. `0` is a real value. */
  foodAllowance?: number;
  siteAllowance?: number;
  siteAllowanceNote?: string;
  approverNote?: string;
  /** Sent back so a concurrent approver is refused with a 409, not overwritten. */
  expectedUpdatedAt?: string;
}

export interface CreateOvertimeData {
  date: string;
  startTime: string;
  endTime: string;
  hours: number;
  reason: string;
}

export interface RejectOvertimeData {
  rejectedReason: string;
}

export interface OvertimeReport {
  month: number;
  year: number;
  totalRequests: number;
  totalHours: number;
  byStatus: Array<{ status: OvertimeStatus; count: number; hours: number }>;
  byEmployee: Array<{
    employee: any;
    totalHours: number;
    requestCount: number;
  }>;
}
