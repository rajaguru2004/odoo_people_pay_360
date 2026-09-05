export type NominationStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'ATTENDED'
  | 'NO_SHOW';

export interface Course {
  id: string;
  code: string;
  title: string;
  category: string | null;
  provider: string | null;
  description: string | null;
  durationHours: string | number | null;
  defaultCost: string | number | null;
  /** Months a certificate stays valid; null means it never expires. */
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
  status: string;
  course?: Course;
  branch?: { id: string; name: string } | null;
  _count?: { nominations: number };
}

export interface TrainingNomination {
  id: string;
  sessionId: string;
  employeeId: string;
  justification: string | null;
  cost: string | number | null;
  status: NominationStatus;
  rejectedReason: string | null;
  attendedAt: string | null;
  score: string | number | null;
  passed: boolean | null;
  certificateUrl: string | null;
  certificateExpiry: string | null;
  createdAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string;
    fullName: string;
    department?: { id: string; name: string } | null;
  };
  session?: TrainingSession;
}

export interface TrainingStats {
  activeCourses: number;
  upcomingSessions30Days: number;
  sessionsByStatus: Record<string, number>;
  nominationsByStatus: Record<string, number>;
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
  isActive?: boolean;
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
