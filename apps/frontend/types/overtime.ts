/** Where a request sits in its lifecycle. Mirrors the server enum. */
export type OvertimeStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/**
 * Which pay tier the request landed in once the day was classified.
 *
 * `LATE` is ordinary overtime that ran past the late threshold; `DOUBLE` is a
 * rest day or public holiday; `DOUBLE_LATE` is both at once. The server decides
 * this — it resolves the employee's overtime policy and the branch's holiday
 * calendar, neither of which the browser can see.
 */
export type OtType = 'REGULAR' | 'LATE' | 'DOUBLE' | 'DOUBLE_LATE';

/**
 * The employee block every overtime row embeds.
 *
 * `fullName` is joined by the API from the two name columns. Employee records
 * store `firstName`/`lastName`, but overtime rows are read far more often than
 * they are written and every screen wants the one string, so the join happens
 * once on the server rather than in five places here.
 */
export interface OvertimeEmployeeRef {
  id: string;
  employeeCode: string;
  fullName: string;
  email?: string | null;
  /** Decimal(18,3) — arrives as a string on anything but a whole number. */
  baseSalary?: number | string | null;
  branchId?: string | null;
  department?: { id: string; name: string } | null;
}

export interface Overtime {
  id: string;
  employeeId: string;
  /** DATE-ONLY. Never put it through an instant parse — see `formatDateOnly`. */
  date: string;
  /**
   * The worked window. Stored tz-naive and tagged `Z`, so these read back as
   * the wall clock that was entered only when rendered in UTC.
   */
  startTime: string;
  endTime: string;
  hours: number | string;
  regularHours?: number | string;
  lateHours?: number | string;
  doubleHours?: number | string;
  /** Money — Decimal(18,3) server-side, so a string on the wire. */
  foodAllowance?: number | string;
  siteAllowance?: number | string;
  siteAllowanceNote?: string | null;
  /**
   * `null` leaves the food allowance to the policy. A value — `0` included — is
   * an approver's explicit override and wins at approval.
   */
  foodAllowanceOverride?: number | string | null;
  approverNote?: string | null;
  editedById?: string | null;
  editedAt?: string | null;
  /** The window as it was first filed, kept from the FIRST correction only. */
  originalStartTime?: string | null;
  originalEndTime?: string | null;
  otType?: OtType;
  /**
   * The live breakdown, on the detail endpoint only. Authoritative: it comes
   * from the employee's resolved overtime policy and the branch-aware rest-day
   * classification, so it is what approval will persist.
   */
  preview?: OvertimeServerPreview | null;
  reason: string;
  status: OvertimeStatus;
  approverId?: string | null;
  approvedAt?: string | null;
  rejectedReason?: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: OvertimeEmployeeRef;
}

/** The payable breakdown returned by `GET /overtime/:id` — see `Overtime.preview`. */
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
  /** The multipliers already picked for this row's day type. */
  regularRate: number;
  lateRate: number;
  doubleRate: number;
  doubleLateRate: number;
  policyId: string | null;
  policyName: string | null;
  /** Carried through from the row, never recomputed. */
  siteAllowance?: number | string;
  foodAllowanceOverride?: number | string | null;
}

/**
 * An approver's corrections, sent on approve.
 *
 * Every field is optional and an empty body means "approve as filed", which is
 * what the inbox and the detail screen send today.
 */
export interface ApproveOvertimeData {
  startTime?: string;
  endTime?: string;
  /** Absent leaves it to the policy. `0` is a real value, not "unset". */
  foodAllowance?: number;
  siteAllowance?: number;
  siteAllowanceNote?: string;
  approverNote?: string;
  /** Echoed back so a concurrent approver is refused with a 409, not overwritten. */
  expectedUpdatedAt?: string;
}

export interface CreateOvertimeData {
  date: string;
  startTime: string;
  endTime: string;
  /**
   * The window's duration, as the form measured it.
   *
   * Sent rather than left to the server because the two have to agree on what
   * an overnight window means before the policy engine ever sees it — the
   * screen that shows "4h" and the row that stores it must be the same number.
   */
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
    employee: OvertimeEmployeeRef;
    totalHours: number;
    requestCount: number;
  }>;
}

export interface OvertimeQuery {
  status?: string;
  employeeId?: string;
  month?: number;
  year?: number;
  page?: number;
  limit?: number;
  search?: string;
  startDate?: string;
  endDate?: string;
  otType?: string;
}

// ── Overtime policy ──────────────────────────────────────────────────────────

/** A contract-type label from the library, so a free string rather than an enum. */
export type EmploymentType = string;

/** STANDARD pays a holiday at the holiday tier; IGNORE treats it as an ordinary day. */
export type HolidayBehavior = 'STANDARD' | 'IGNORE';

export interface OvertimeRateTier {
  regularRate: number;
  lateRate: number;
  /** `HH:mm` — when this tier's late rate takes over. */
  lateThreshold: string;
}

export interface OvertimePolicyRules {
  eligible: boolean;
  holidayBehavior: HolidayBehavior;
  lateThreshold: string;
  regularRate: number;
  lateRate: number;
  doubleOtEnabled: boolean;
  doubleRate: number;
  doubleOtAllowAnytime: boolean;
  sunday: OvertimeRateTier;
  holiday: OvertimeRateTier;
  shiftEndTime: string;
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
  employmentType: EmploymentType | null;
  schemaVersion: number;
  rules: OvertimePolicyRules;
  createdAt: string;
  updatedAt: string;
  _count?: { employees: number };
}

export interface CreateOvertimePolicyPayload {
  name: string;
  description?: string;
  isActive?: boolean;
  isDefault?: boolean;
  employmentType?: EmploymentType | null;
  rules?: Partial<OvertimePolicyRules>;
}

export type UpdateOvertimePolicyPayload = Partial<CreateOvertimePolicyPayload>;

export interface AssignOvertimePolicyPayload {
  employeeId: string;
  employmentType?: EmploymentType;
  overtimePolicyId?: string | null;
}

/**
 * Which policy governs one employee, and through which tier it was reached.
 *
 * The chain is employee override → employment type → company default, so the
 * `source` is the only way to tell an explicit assignment from a fallback.
 */
export interface OvertimePolicyResolution {
  employeeId: string;
  employeeName: string;
  employmentType: EmploymentType | null;
  overtimePolicyId: string | null;
  source:
    | 'EMPLOYEE_OVERRIDE'
    | 'EMPLOYMENT_TYPE'
    | 'COMPANY_DEFAULT'
    | 'LEGACY_GLOBAL'
    | 'LEGACY_GLOBAL_DISABLED';
  effectivePolicyId: string | null;
  effectivePolicyName: string | null;
  description?: string | null;
  eligible: boolean;
  holidayBehavior: HolidayBehavior;
  rules?: Partial<OvertimePolicyRules>;
}
