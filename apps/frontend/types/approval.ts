/** Who a chain step routes to. Resolved per request, not per role name. */
export type ApproverType = 'SUPERVISOR' | 'MANAGER' | 'HR_MANAGER' | 'ADMIN';

/**
 * The request types the engine can govern.
 *
 * The server owns this list — `GET /approval-workflows/kinds` serves it, and
 * the chain builder reads it from there so a new type needs no frontend
 * release. This union exists only so the inbox's per-type behaviour map is a
 * total `Record`: a type added here without an entry in that map is a compile
 * error rather than a card whose Approve button answers "unsupported".
 */
export type ApprovalRequestType = 'LEAVE' | 'OVERTIME' | 'TRAINING';

/**
 * SEQUENTIAL — a step becomes actionable only once the previous one accepts.
 * PARALLEL   — every step is actionable at once, and all must approve.
 */
export type ApprovalMode = 'SEQUENTIAL' | 'PARALLEL';

/** One entry of the server's approval-kind registry. */
export interface ApprovalKindMeta {
  type: ApprovalRequestType;
  label: string;
  /** The list route for this kind, as the server names it. */
  link: string;
}

export interface ApprovalStep {
  id: string;
  stepOrder: number;
  approverType: ApproverType;
}

export interface ApprovalWorkflow {
  id: string;
  requestType: ApprovalRequestType;
  name: string | null;
  mode?: ApprovalMode;
  isActive: boolean;
  steps: ApprovalStep[];
}

export interface UpsertWorkflowPayload {
  requestType: ApprovalRequestType;
  name?: string;
  mode?: ApprovalMode;
  isActive?: boolean;
  steps: { approverType: ApproverType }[];
}

export interface ApprovalTrailStep {
  id: string;
  stepOrder: number;
  approverType: ApproverType;
  /** PENDING | ACTIVE | APPROVED | REJECTED | SKIPPED */
  status: string;
  comment: string | null;
  decidedById: string | null;
  decidedAt: string | null;
}

export interface ApprovalTrail {
  /** false — no chain governs this request, so the plain role rule applies. */
  engaged: boolean;
  steps: ApprovalTrailStep[];
  activeStep: number | null;
  /** Whether the CURRENT user may act on the live step. Gate buttons on this. */
  canAct: boolean;
}

/** Whether this user is an approver at all, and how much is waiting. */
export interface ApproverStanding {
  isApprover: boolean;
  pending: number;
}

/** The employee block every inbox card carries, with the name already joined. */
export interface ApprovalRequesterRef {
  id: string;
  employeeCode?: string;
  fullName?: string;
  department?: { id?: string; name?: string } | null;
}

/**
 * The domain row behind an inbox card.
 *
 * One shape covering every kind rather than a discriminated union: the card
 * reads a handful of fields per kind and the engine hydrates each type from its
 * own table, so narrowing buys nothing that optionality does not already give.
 */
export interface ApprovalRequestPayload {
  id: string;
  reason?: string | null;
  employee?: ApprovalRequesterRef | null;

  /** LEAVE */
  leaveType?: string;
  startDate?: string;
  endDate?: string;
  totalDays?: number | string;

  /** OVERTIME */
  date?: string;
  startTime?: string;
  endTime?: string;
  hours?: number | string;
  foodAllowance?: number | string;
  siteAllowance?: number | string;

  /** TRAINING */
  session?: {
    startDate?: string;
    course?: { title?: string } | null;
  } | null;
  cost?: number | string;
}

export interface ApprovalInboxItem {
  requestType: ApprovalRequestType;
  requestId: string;
  stepOrder: number;
  approverType: ApproverType;
  request: ApprovalRequestPayload;
  /**
   * History rows only: what THIS user did. Not the request's own standing — a
   * step-1 approval leaves the request PENDING behind it.
   */
  decision?: 'APPROVED' | 'REJECTED';
  decidedAt?: string;
  comment?: string | null;
}
