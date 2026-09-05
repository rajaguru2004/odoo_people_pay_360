import type { EmployeeRef } from './common';

export interface Branch {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  isActive: boolean;

  addressLine?: string | null;
  city?: string | null;
  state?: string | null;
  /** ISO-3166 alpha-2. */
  country?: string | null;
  postalCode?: string | null;

  phone?: string | null;
  email?: string | null;
  crNumber?: string | null;
  vatNumber?: string | null;

  /**
   * Every field below is nullable and means "inherit the company value" when
   * unset — an explicit null rather than a copied default, so changing the
   * company setting moves every branch that never overrode it.
   */
  timezone?: string | null;
  /** Wall clock, "HH:MM" — not an instant. */
  officeStartTime?: string | null;
  officeEndTime?: string | null;
  graceMinutes?: number | null;
  /** ISO weekday numbers, 1 = Monday. Empty inherits the company calendar. */
  weeklyOffDays: number[];

  geofencingEnabled?: boolean | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  geofenceRadiusM?: number | null;

  managerId?: string | null;
  manager?: EmployeeRef | null;
  departments?: Array<{ id: string; code: string; name: string }>;
  _count?: { employees: number; departments: number };

  createdAt: string;
  updatedAt: string;
}

export interface CreateBranchPayload {
  code: string;
  name: string;
  description?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  crNumber?: string;
  vatNumber?: string;
  timezone?: string;
  officeStartTime?: string;
  officeEndTime?: string;
  graceMinutes?: number;
  weeklyOffDays?: number[];
  geofencingEnabled?: boolean;
  latitude?: number;
  longitude?: number;
  geofenceRadiusM?: number;
  managerId?: string;
  isActive?: boolean;
}

export type UpdateBranchPayload = Partial<CreateBranchPayload>;
