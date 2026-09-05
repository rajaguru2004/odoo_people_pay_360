/**
 * R15, closed: `AssetItem.status` is a Postgres enum now, not free text.
 *
 * These five and no others — the union mirrors `enum AssetStatus` in
 * `schema.prisma` and `ASSET_STATUSES` in `assets.service.ts`, and the column
 * itself refuses anything else. Widening this back to `string` would not make
 * the app accept more values; it would only move the refusal from the keystroke
 * to a 400, which is the state the finding was raised about.
 */
export type AssetStatus =
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'IN_REPAIR'
  | 'LOST'
  | 'RETIRED';

/**
 * Status an asset may take when it comes back — a deliberate SUBSET, mirroring
 * `RETURN_STATUSES` in `return-asset.dto.ts`.
 *
 * `ASSIGNED` is absent because it is derived from custody and never chosen: it
 * is what an OPEN assignment means, so it cannot be the outcome of closing one.
 * Keep the return picker keyed off this type rather than off `AssetStatus`.
 */
export type AssetReturnStatus = 'AVAILABLE' | 'IN_REPAIR' | 'LOST' | 'RETIRED';

export interface AssetEmployeeRef {
  id: string;
  employeeCode: string;
  fullName: string;
  status?: string;
  department?: { name: string } | null;
}

export interface AssetHolder {
  assignmentId: string;
  assignedAt: string;
  acknowledgedAt: string | null;
  employee: AssetEmployeeRef;
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
  createdAt: string;
  updatedAt: string;
  branch?: { id: string; code: string; name: string } | null;
  /** Derived from the single OPEN assignment; null when nobody holds it. */
  currentHolder: AssetHolder | null;
  /** Only on the detail endpoint: full custody trail, newest first. */
  history?: AssetAssignment[];
}

export interface AssetAssignment {
  id: string;
  assetId: string;
  employeeId: string;
  assignedAt: string;
  assignedById: string;
  conditionOut: string | null;
  acknowledgedAt: string | null;
  acknowledgedNote: string | null;
  returnedAt: string | null;
  conditionIn: string | null;
  returnReceivedById: string | null;
  notes: string | null;
  asset?: Pick<
    AssetItem,
    'id' | 'assetTag' | 'name' | 'category' | 'serialNumber' | 'warrantyExpiry'
  >;
  employee?: AssetEmployeeRef;
}

export interface AssetSummary {
  byStatus: Partial<Record<AssetStatus, number>>;
  total: number;
  /** Assets currently in someone's custody. */
  held: number;
  /** Hand-overs the employee has not yet acknowledged. */
  unacknowledged: number;
}

export interface OpenAssetSummary {
  assignmentId: string;
  assetId: string;
  assetTag: string;
  name: string;
  category: string;
  assignedAt: string;
}

/**
 * `cleared: false` blocks every offboarding path.
 *
 * Keyed on OPEN assignments (`returnedAt IS NULL`), never on `Employee.status`:
 * somebody still holding a laptop is not cleared whatever their status says.
 * Mirrors `ClearanceService.getClearanceStatus`.
 */
export interface ClearanceStatus {
  /** Everything is clear: no held assets. */
  cleared: boolean;
  assetCleared: boolean;
  openAssets: OpenAssetSummary[];
}

export interface CreateAssetData {
  assetTag: string;
  category: string;
  name: string;
  branchId: string;
  serialNumber?: string;
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
