export type AssetStatus =
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'IN_REPAIR'
  | 'LOST'
  | 'RETIRED';

/** ASSIGNED is derived from custody, so it can never be the outcome of a return. */
export type AssetReturnStatus = Exclude<AssetStatus, 'ASSIGNED'>;

export interface AssetHolder {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  fullName: string;
  department?: { id: string; name: string } | null;
}

export interface CurrentHolder {
  assignmentId: string;
  assignedAt: string;
  acknowledgedAt: string | null;
  employee: AssetHolder;
}

export interface AssetItem {
  id: string;
  assetTag: string;
  category: string;
  name: string;
  serialNumber: string | null;
  branchId: string;
  status: AssetStatus;
  purchaseDate: string | null;
  purchaseCost: string | number | null;
  warrantyExpiry: string | null;
  notes: string | null;
  branch?: { id: string; code: string; name: string } | null;
  currentHolder: CurrentHolder | null;
  history?: AssetAssignment[];
}

export interface AssetAssignment {
  id: string;
  assetId: string;
  employeeId: string;
  assignedAt: string;
  conditionOut: string | null;
  acknowledgedAt: string | null;
  acknowledgedNote: string | null;
  returnedAt: string | null;
  conditionIn: string | null;
  notes: string | null;
  asset?: {
    id: string;
    assetTag: string;
    name: string;
    category: string;
    serialNumber?: string | null;
    warrantyExpiry?: string | null;
  };
  employee?: AssetHolder & { status?: string };
}

export interface AssetSummary {
  byStatus: Partial<Record<AssetStatus, number>>;
  total: number;
  held: number;
  unacknowledged: number;
}

export interface CreateAssetData {
  assetTag: string;
  category: string;
  name: string;
  serialNumber?: string;
  branchId: string;
  status?: AssetStatus;
  purchaseDate?: string;
  purchaseCost?: number;
  warrantyExpiry?: string;
  notes?: string;
}

export interface AssignAssetData {
  assetId: string;
  employeeId: string;
  assignedAt?: string;
  conditionOut?: string;
  notes?: string;
}

export interface ReturnAssetData {
  returnedAt?: string;
  conditionIn?: string;
  assetStatus?: AssetReturnStatus;
  notes?: string;
}

export interface QueryAssetsParams {
  status?: AssetStatus;
  category?: string;
  branchId?: string;
  search?: string;
  unassignedOnly?: boolean;
  page?: number;
  limit?: number;
}

export interface OpenAssetSummary {
  assignmentId: string;
  assetId: string;
  assetTag: string;
  name: string;
  category: string;
  assignedAt: string;
}

export interface ClearanceStatus {
  cleared: boolean;
  assetCleared: boolean;
  openAssets: OpenAssetSummary[];
}
