export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'LEAVE' | 'HOLIDAY' | 'MISSED_CHECKOUT' | 'NOT_CHECKED_IN';

export interface AttendanceSession {
  checkIn: string;
  checkOut?: string | null;
  // 'LUNCH' marks a break session; undefined = a work session.
  type?: 'LUNCH' | string;
  reminderSent?: boolean;
}

export interface Attendance {
  id: string;
  employeeId: string;
  date: string;
  checkIn?: string;
  checkOut?: string;
  workHours?: number;
  isLate: boolean;
  isEarlyLeave: boolean;
  isEarlyCheckIn?: boolean;
  isLateCheckout?: boolean;
  status: AttendanceStatus;
  note?: string;
  // Multiple check-in/out intervals in a single day (work + LUNCH sessions).
  sessions?: AttendanceSession[];
  // Present on the today-attendance response.
  allowMultiple?: boolean;
  attendanceFaceOnly?: boolean;
  // Flexible-shift fields: when isFlexible, the employee works `requiredHours`
  // across any sessions; targetMet reflects whether logged hours met the target.
  isFlexible?: boolean;
  requiredHours?: number | null;
  targetMet?: boolean;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    email?: string;
    department: {
      name: string;
    };
  };
  corrections?: AttendanceCorrection[];
}

export interface AttendanceSummary {
  totalDays: number;
  presentDays: number;
  lateDays: number;
  earlyLeaveDays: number;
  totalWorkHours: number;
}

export interface AttendanceStatistics {
  totalRecords: number;
  lateCount: number;
  earlyLeaveCount: number;
  lateRate: number;
  earlyLeaveRate: number;
  avgWorkHours: number;
}

export interface CheckInData {
  employeeId: string;
  checkIn?: string;
  checkOut?: string;
  note?: string;
}

export interface AttendanceReport {
  month: number;
  year: number;
  totalDays: number;
  presentDays: number;
  absentDays: number;
  lateDays: number;
  earlyLeaveDays: number;
  totalWorkHours: number;
  avgWorkHours: number;
  byEmployee?: Array<{
    employee: any;
    presentDays: number;
    lateDays: number;
    earlyLeaveDays: number;
    totalWorkHours: number;
  }>;
}

export interface AttendanceCorrection {
  id: string;
  employeeId: string;
  attendanceId?: string;
  date: string;
  originalCheckIn?: string;
  originalCheckOut?: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  approverId?: string;
  approvedAt?: string;
  approverNotes?: string;
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    email: string;
    department: {
      id: string;
      name: string;
    };
  };
  reviewer?: {
    id: string;
    fullName: string;
    employeeCode: string;
  } | null;
  attendance?: Attendance;
}

export interface CreateCorrectionData {
  date: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  reason: string;
}
