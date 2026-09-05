import type { EmployeeRef, RequestStatus, UserRef } from './common';
import type { EmployeeStatus } from './employee';

export type ContractType =
  | 'PERMANENT'
  | 'FIXED_TERM'
  | 'PROBATION'
  | 'PART_TIME'
  | 'INTERNSHIP'
  | 'CONSULTANT';

export type ContractStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'TERMINATED'
  | 'RENEWED';

export type WorkType = 'FULL_TIME' | 'PART_TIME' | 'REMOTE' | 'HYBRID';

export interface Contract {
  id: string;
  employeeId: string;
  contractNumber: string;
  contractType: ContractType;
  workType: WorkType;
  status: ContractStatus;
  startDate: string;
  /** null for a permanent contract. Anything else is a date to count down to. */
  endDate?: string | null;
  probationEndDate?: string | null;
  workHoursPerWeek: number;
  /** Decimal string from the API — format with formatCurrency, never parseFloat + toFixed. */
  salary: string;
  currency: string;
  noticePeriodDays: number;
  annualLeaveDays: number;
  terms?: string | null;
  notes?: string | null;
  documentUrl?: string | null;
  employee?: EmployeeRef & {
    /** The two can disagree: a terminated employee keeps their contract row. */
    status?: EmployeeStatus;
    department?: { id: string; name: string } | null;
  };
  terminations?: TerminationRequest[];
  /** Derived by the expiry endpoints; negative once the term has lapsed. */
  daysUntilExpiry?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContractPayload {
  employeeId: string;
  contractType: ContractType;
  workType?: WorkType;
  status?: ContractStatus;
  contractNumber?: string;
  startDate: string;
  endDate?: string;
  probationEndDate?: string;
  workHoursPerWeek?: number;
  salary: number;
  currency?: string;
  noticePeriodDays?: number;
  annualLeaveDays?: number;
  terms?: string;
  notes?: string;
}

export type UpdateContractPayload = Partial<
  Omit<CreateContractPayload, 'employeeId'>
>;

export interface ContractListQuery {
  page?: number;
  limit?: number;
  employeeId?: string;
  status?: ContractStatus;
  contractType?: ContractType;
  search?: string;
  expiringWithinDays?: number;
}

// ── Terminations ────────────────────────────────────────────────────────────

export type TerminationCategory =
  | 'RESIGNATION'
  | 'DISMISSAL'
  | 'END_OF_CONTRACT'
  | 'RETIREMENT'
  | 'REDUNDANCY'
  | 'MUTUAL_AGREEMENT'
  | 'DEATH';

export interface TerminationRequest {
  id: string;
  contractId: string;
  category: TerminationCategory;
  status: RequestStatus;
  noticeDate: string;
  terminationDate: string;
  reason: string;
  /** Whether the notice is being served or paid out — it reaches the settlement. */
  noticeServed: boolean;
  requestedById: string;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  contract?: Contract;
  requestedBy?: UserRef | null;
  reviewedBy?: UserRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTerminationPayload {
  contractId: string;
  category: TerminationCategory;
  noticeDate: string;
  terminationDate: string;
  reason: string;
  noticeServed?: boolean;
}
