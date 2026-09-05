import type { EmployeeRef, RequestStatus, UserRef } from './common';

export type AttendanceStatus =
  | 'PRESENT'
  | 'LATE'
  | 'ABSENT'
  | 'HALF_DAY'
  | 'ON_LEAVE'
  | 'HOLIDAY'
  | 'WEEKEND';

export type AttendanceSource =
  | 'ESS'
  | 'MANUAL'
  | 'BIOMETRIC'
  | 'IMPORT'
  | 'SYSTEM';

export interface Attendance {
  id: string;
  employeeId: string;
  branchId?: string | null;
  /** The day the work is ATTRIBUTED to — for a night shift, not the check-out's date. */
  date: string;
  checkIn?: string | null;
  checkOut?: string | null;
  workHours?: string | null;
  expectedHours?: string | null;
  status: AttendanceStatus;
  source: AttendanceSource;
  isLate: boolean;
  isEarlyLeave: boolean;
  /** Measured from the shift start, not from the end of the grace window. */
  lateMinutes: number;
  notes?: string | null;
  checkInLatitude?: string | null;
  checkInLongitude?: string | null;
  checkOutLatitude?: string | null;
  checkOutLongitude?: string | null;
  employee?: EmployeeRef & {
    department?: { id: string; name: string } | null;
    branch?: { id: string; name: string } | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceListQuery {
  page?: number;
  limit?: number;
  employeeId?: string;
  departmentId?: string;
  branchId?: string;
  status?: AttendanceStatus;
  source?: AttendanceSource;
  startDate?: string;
  endDate?: string;
  search?: string;
}

export interface CheckInPayload {
  latitude?: number;
  longitude?: number;
  notes?: string;
}

export interface CreateAttendancePayload {
  employeeId: string;
  date: string;
  checkIn?: string;
  checkOut?: string;
  status?: AttendanceStatus;
  notes?: string;
}

export type UpdateAttendancePayload = Partial<
  Omit<CreateAttendancePayload, 'employeeId' | 'date'>
>;

/**
 * The verdicts a human is allowed to assert.
 *
 * PRESENT, LATE and HALF_DAY are DERIVED from the times on the row — asserting
 * one would overwrite the calculation a payroll run later reads. The four below
 * say something the clock does not know, so they are the only ones the endpoint
 * accepts.
 */
export type NonPunchStatus = Extract<
  AttendanceStatus,
  'ABSENT' | 'ON_LEAVE' | 'HOLIDAY' | 'WEEKEND'
>;

/** One verdict applied to a set of people for one day. */
/**
 * One call, one date, mixed verdicts.
 *
 * The verdict travels PER ENTRY rather than once for the whole batch, so
 * marking a morning's absences and one half-day is a single request. A
 * batch-level status would force one call per distinct verdict and turn a
 * partial failure into several partial failures to reconcile.
 */
export interface BulkAttendancePayload {
  date: string;
  entries: BulkAttendanceEntry[];
}

export interface BulkAttendanceEntry {
  employeeId: string;
  /** Defaults to ABSENT when the entry carries no times. */
  status?: AttendanceStatus;
  checkIn?: string;
  checkOut?: string;
  notes?: string;
}

/** Per-row outcomes, so one bad id does not read as a failed batch. */
export interface BulkAttendanceResult {
  date: string;
  applied: number;
  created: number;
  updated: number;
  failed: Array<{ employeeId: string; message: string }>;
  results: Array<{
    employeeId: string;
    outcome: 'created' | 'updated' | 'failed';
    message?: string;
    attendanceId?: string;
  }>;
}

/** `GET /attendances/today` — the board, with the header figures it needs. */
export interface TodayBoard {
  /** The company-zone day key the board is for. */
  date: string;
  generatedAt: string;
  totals: {
    headcount: number;
    expected: number;
    present: number;
    late: number;
    halfDay: number;
    absent: number;
    onLeave: number;
    checkedOut: number;
    notCheckedIn: number;
  };
  records: TodayRecord[];
}

/**
 * One person's day.
 *
 * Everyone active appears, whether or not they punched: an absence has to be
 * visible before anybody can explain it, and a board listing only arrivals
 * cannot show who is missing.
 */
export interface TodayRecord {
  employee: EmployeeRef & {
    status: string;
    department?: { id: string; name: string } | null;
    branch?: { id: string; code: string; name: string } | null;
  };
  attendanceId: string | null;
  date: string;
  checkIn: string | null;
  checkOut: string | null;
  workHours: string | null;
  expectedHours: number | string | null;
  status: AttendanceStatus;
  source: AttendanceSource | null;
  isLate: boolean;
  lateMinutes: number;
  isEarlyLeave: boolean;
  notes: string | null;
  /** False on a weekend, a holiday, or for somebody already on leave. */
  expectedToWork: boolean;
  holiday: { id: string; name: string } | null;
  /** False until the branch's office day has ended — before that an absence
   *  is a prediction rather than a fact. */
  settled: boolean;
  /** The zone the times above should be rendered in. */
  zone: string;
}

/** `GET /attendances/summary` — the report over an explicit date range. */
export interface AttendanceSummary {
  range: { startDate: string; endDate: string };
  totals: {
    records: number;
    present: number;
    late: number;
    halfDay: number;
    absent: number;
    onLeave: number;
    holiday: number;
    weekend: number;
    workHours: number;
    /** Averaged over the rows that recorded hours, not over every row. */
    avgWorkHours: number | null;
    lateMinutes: number;
    /** null when nothing was recorded — 0% would claim total absence. */
    attendanceRate: number | null;
  };
  daily: Array<{
    date: string;
    present: number;
    late: number;
    halfDay: number;
    absent: number;
    onLeave: number;
    holiday: number;
    weekend: number;
    workHours: number;
    attendanceRate: number | null;
  }>;
  departments: Array<{
    id: string;
    name: string;
    headcount: number;
    present: number;
    late: number;
    absent: number;
    onLeave: number;
    workHours: number;
    attendanceRate: number | null;
  }>;
}

// ── Corrections ─────────────────────────────────────────────────────────────

export interface AttendanceCorrection {
  id: string;
  employeeId: string;
  /** null when the day has no attendance row at all — approving CREATES one. */
  attendanceId?: string | null;
  date: string;
  originalCheckIn?: string | null;
  originalCheckOut?: string | null;
  requestedCheckIn?: string | null;
  requestedCheckOut?: string | null;
  reason: string;
  status: RequestStatus;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  employee?: EmployeeRef & { department?: { id: string; name: string } | null };
  attendance?: Attendance | null;
  reviewedBy?: UserRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCorrectionPayload {
  date: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  reason: string;
}

export interface CorrectionStats {
  pending: number;
  approved: number;
  rejected: number;
  cancelled: number;
  total: number;
  /** null while nothing has been resolved — 0 would claim instant turnaround. */
  avgResolutionHours: number | null;
}

export interface CorrectionListQuery {
  page?: number;
  limit?: number;
  status?: RequestStatus;
  employeeId?: string;
  startDate?: string;
  endDate?: string;
}

// ── Roster and calendar ─────────────────────────────────────────────────────

export type ShiftType =
  | 'MORNING'
  | 'AFTERNOON'
  | 'FULL_DAY'
  | 'NIGHT'
  | 'FLEXIBLE';

export interface WorkSchedule {
  id: string;
  employeeId: string;
  date: string;
  shiftType: ShiftType;
  /** Wall clock in the employee's effective zone — "08:00", not an instant. */
  startTime?: string | null;
  endTime?: string | null;
  requiredHours?: string | null;
  isWorkDay: boolean;
  notes?: string | null;
  employee?: EmployeeRef;
  createdAt: string;
  updatedAt: string;
}

export interface Holiday {
  id: string;
  branchId?: string | null;
  name: string;
  date: string;
  year: number;
  isRecurring: boolean;
  description?: string | null;
  branch?: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

// ── Biometric enrolment ─────────────────────────────────────────────────────

/**
 * The descriptor itself is never sent to the browser. It is biometric material
 * and the screen only needs to know an enrolment exists, how good it is, and
 * when it was taken.
 */
export interface FaceEnrollment {
  id: string;
  employeeId: string;
  quality: number;
  imageUrl?: string | null;
  isActive: boolean;
  employee?: EmployeeRef & { department?: { id: string; name: string } | null };
  createdAt: string;
  updatedAt: string;
}

export interface CreateFaceEnrollmentPayload {
  employeeId: string;
  /** Exactly 128 finite numbers — the server refuses anything else. */
  descriptor: number[];
  quality: number;
  imageUrl?: string;
}
