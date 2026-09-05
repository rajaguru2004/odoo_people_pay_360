import type { EmployeeRef, NamedRef } from './common';
import type { EmployeeStatus } from './employee';

/** The contract terms a person's own profile shows them. */
export interface ProfileContract {
  id: string;
  contractNumber: string;
  contractType: string;
  workType: string;
  status: string;
  startDate: string;
  endDate?: string | null;
  probationEndDate?: string | null;
  workHoursPerWeek: number;
  noticePeriodDays: number;
  annualLeaveDays: number;
  /** `Decimal(18, 3)` — a string. See the note in `types/payroll.ts`. */
  salary: string;
  currency: string;
}

/**
 * `GET /employees/:id/profile` — the record as its owner sees it.
 *
 * Distinct from `Employee` in `types/employee.ts`, which is the directory
 * shape. This one carries the current contract and how much of the
 * self-maintained half has been filled in, because those are what somebody
 * opens their own profile to check.
 */
export interface EmployeeProfile {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  /** Joined server-side. The columns are still `firstName`/`lastName`. */
  fullName: string;
  workEmail?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  position?: string | null;
  status: EmployeeStatus;
  hireDate?: string | null;
  exitDate?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  nationality?: string | null;
  nationalId?: string | null;
  address?: string | null;
  timezone?: string | null;
  avatarUrl?: string | null;
  department?: NamedRef | null;
  branch?: (NamedRef & { timezone?: string | null; city?: string | null }) | null;
  manager?: (EmployeeRef & { fullName: string }) | null;
  supervisor?: (EmployeeRef & { fullName: string }) | null;
  contract?: ProfileContract | null;
  profileCompletionPercentage: number;
  /** Named, not counted, so the screen can point at what is still blank. */
  missingFields: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * What a person may change about themselves.
 *
 * Anything absent is a 400 rather than a silently dropped field — the API runs
 * `forbidNonWhitelisted`. Position, department, salary and status are asserted
 * by HR and are not here on purpose.
 */
export interface UpdateEmployeeProfilePayload {
  phone?: string;
  personalEmail?: string;
  address?: string;
  dateOfBirth?: string;
  gender?: string;
  /** ISO-3166 alpha-2, uppercase. */
  nationality?: string;
  timezone?: string;
}
