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
  /** Internal notes are never returned to the complainant. */
  isInternal: boolean;
  createdAt: string;
  actor?: { id: string; email: string } | null;
}

export interface Grievance {
  id: string;
  employeeId: string;
  category: string;
  subject: string;
  description: string;
  isConfidential: boolean;
  /** Whoever this is can never see the grievance, whatever their role. */
  againstEmployeeId: string | null;
  status: GrievanceStatus;
  assignedToId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    department?: { name: string } | null;
  };
  againstEmployee?: { id: string; employeeCode: string; fullName: string } | null;
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
