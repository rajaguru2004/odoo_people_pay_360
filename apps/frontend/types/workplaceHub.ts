import type { HubDelta, HubTrendBucket, HubWindow } from './moduleHub';

/** `GET /workplace/hub-summary`. */
export interface WorkplaceHubSummary {
  window: HubWindow;
  assets: WorkplaceAssets;
  clearances: WorkplaceClearances;
  letters: WorkplaceLetters;
  projects: WorkplaceProjects;
  trendKind: 'month';
  /** Twelve months of the letter desk; segments are `issued|outstanding`. */
  trend: HubTrendBucket[];
}

export interface WorkplaceAssets {
  total: number;
  /** All five `AssetStatus` values, zero-filled. `DAMAGED` does not exist. */
  byStatus: Record<'AVAILABLE' | 'ASSIGNED' | 'IN_REPAIR' | 'LOST' | 'RETIRED', number>;
  held: number;
  /** Exact: `AssetAssignment` is append-only, so custody at a date is a query. */
  heldAsOfPrev: number;
  heldDelta: HubDelta | null;
  unacknowledged: number;
  warrantyExpired: number;
  warrantyExpiring60: number;
  /** `purchaseCost` of everything IN_REPAIR or LOST. */
  valueAtRisk: number;
  /**
   * `IN_REPAIR + LOST + warrantyExpired`. A composite, and honest only because
   * the card's footnote itemises all three. Deliberately NOT "overdue for
   * return" — `AssetAssignment` has no `returnDueDate`.
   */
  needingAttention: number;
  assignedInWindow: number;
  prevAssignedInWindow: number;
  assignedDelta: HubDelta | null;
  returnedInWindow: number;
}

export interface WorkplaceClearances {
  outstandingCount: number;
  top: Array<{
    assignmentId: string;
    assetTag: string | null;
    assetName: string | null;
    employeeName: string | null;
    employeeStatus: string | null;
    assignedAt: string;
  }>;
}

export interface WorkplaceLetters {
  pending: number;
  byStatus: Record<string, number>;
  byTemplate: Array<{ key: string; count: number }>;
  oldestPendingAt: string | null;
  requestedInWindow: number;
  /** Computed on `issuedAt`, not `updatedAt`. */
  issuedInWindow: number;
  prevIssuedInWindow: number;
  issuedDelta: HubDelta | null;
  /** `null` when nothing has ever been issued — 0 would read as instant service. */
  avgIssueTurnaroundDays: number | null;
  /** Always false: `LetterRequest` has no `rejectedAt` column. */
  rejectTurnaroundMeasurable: boolean;
}

export interface WorkplaceProjects {
  total: number;
  /** All five `ProjectStatus` values — `/projects/stats` returns only four. */
  byStatus: Record<'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED', number>;
  overdue: number;
  dueIn30Days: number;
  /**
   * How many live projects carry no end date at all. Ships beside `overdue`
   * because without it a zero reads as full coverage rather than no coverage.
   */
  withoutEndDate: number;
  /**
   * Always false. `Project` is absent from `branch-scope.map.ts` by design,
   * while assets and letters are scoped — so these figures do not narrow with
   * the branch selector and the panel has to say so.
   */
  projectsAreBranchScoped: boolean;
}
