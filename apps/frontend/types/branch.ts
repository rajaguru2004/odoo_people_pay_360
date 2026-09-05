export interface Branch {
  id: string;
  code: string;
  name: string;
  description?: string;
  isActive: boolean;

  // Address
  addressLine?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;

  // Per-branch config (null = inherit global)
  timezone?: string | null;
  officeStartTime?: string | null;
  officeEndTime?: string | null;
  weeklyOffDays?: string | null; // CSV of day numbers "5,6"; null = inherit company default
  geofencingEnabled?: boolean | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  geofenceRadiusM?: number | null;

  managerId?: string | null;
  createdAt: string;
  updatedAt: string;

  manager?: {
    id: string;
    employeeCode: string;
    fullName: string;
  } | null;
  _count?: {
    employees: number;
  };
}

export interface CreateBranchData {
  code: string;
  name: string;
  description?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  timezone?: string;
  officeStartTime?: string;
  officeEndTime?: string;
  weeklyOffDays?: string;
  geofencingEnabled?: boolean;
  latitude?: number;
  longitude?: number;
  geofenceRadiusM?: number;
  managerId?: string;
}

export interface UpdateBranchData extends Partial<CreateBranchData> {
  isActive?: boolean;
}
