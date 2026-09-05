export type SessionStatus = 'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';

export type NominationStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'ATTENDED'
  | 'NO_SHOW';

export type NominationSource = 'MANUAL' | 'APPRAISAL';

export interface Course {
  id: string;
  code: string;
  title: string;
  category: string | null;
  provider: string | null;
  description: string | null;
  durationHours: string | number | null;
  defaultCost: string | number | null;
  /** Months a certificate stays valid; null = never expires. */
  certValidMonths: number | null;
  isActive: boolean;
}

export interface TrainingSession {
  id: string;
  courseId: string;
  branchId: string | null;
  startDate: string;
  endDate: string;
  location: string | null;
  trainer: string | null;
  seats: number | null;
  costPerSeat: string | number | null;
  status: SessionStatus;
  course?: Course;
  branch?: { id: string; name: string } | null;
  /** Seats actually committed (APPROVED + ATTENDED). */
  _count?: { nominations: number };
}

export interface TrainingNomination {
  id: string;
  sessionId: string;
  employeeId: string;
  source: NominationSource;
  /** Provenance when derived from the AI appraisal engine. */
  appraisalResultId: string | null;
  justification: string | null;
  cost: string | number | null;
  status: NominationStatus;
  approvedAt: string | null;
  rejectedReason: string | null;
  attendedAt: string | null;
  score: string | number | null;
  passed: boolean | null;
  certificateUrl: string | null;
  certificateExpiry: string | null;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    department?: { name: string } | null;
  };
  session?: TrainingSession;
}

/** One employee's derived development need, with the evidence behind it. */
export interface TrainingNeed {
  appraisalResultId: string;
  employeeId: string | null;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  recommendation: string | null;
  improvements: string[];
  suggestedCourses: Array<{
    courseId: string;
    code: string;
    title: string;
    reason: string;
  }>;
  matchedBy: 'llm' | 'keyword' | 'none';
}

export interface CreateCourseData {
  code: string;
  title: string;
  category?: string;
  provider?: string;
  description?: string;
  durationHours?: number;
  defaultCost?: number;
  certValidMonths?: number;
}

export interface CreateSessionData {
  courseId: string;
  branchId?: string;
  startDate: string;
  endDate: string;
  location?: string;
  trainer?: string;
  seats?: number;
  costPerSeat?: number;
}

export interface RecordAttendanceData {
  attended: boolean;
  attendedAt?: string;
  score?: number;
  passed?: boolean;
  certificateUrl?: string;
}
