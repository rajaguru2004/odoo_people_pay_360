export type GrievanceStatus =
  | 'OPEN'
  | 'ACKNOWLEDGED'
  | 'INVESTIGATING'
  | 'RESOLVED'
  | 'CLOSED'
  | 'WITHDRAWN';

export interface GrievanceEvent {
  id: string;
  type: 'STATUS_CHANGE' | 'NOTE' | 'ASSIGNED';
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  /** An internal note is never returned to the complainant. */
  isInternal: boolean;
  createdAt: string;
  actor?: { id: string; email: string } | null;
}

export interface GrievancePerson {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  fullName: string;
  department?: { id: string; name: string } | null;
}

export interface Grievance {
  id: string;
  employeeId: string;
  category: string;
  subject: string;
  description: string;
  isConfidential: boolean;
  againstEmployeeId: string | null;
  status: GrievanceStatus;
  assignedToId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  employee: GrievancePerson;
  againstEmployee: GrievancePerson | null;
  assignedTo?: { id: string; email: string } | null;
  events?: GrievanceEvent[];
}

export interface CreateGrievanceData {
  category: string;
  subject: string;
  description: string;
  isConfidential?: boolean;
  againstEmployeeId?: string;
}

export interface GrievanceStats {
  open: number;
  byStatus: Record<string, number>;
  olderThan14Days: number;
  oldestOpenAt: string | null;
}
