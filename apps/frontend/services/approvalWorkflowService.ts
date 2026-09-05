import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export type ApproverType = 'SUPERVISOR' | 'MANAGER' | 'HR_MANAGER' | 'ADMIN';

/**
 * Must mirror `ApprovalRequestType` in the backend's
 * `src/approvals/approval-kind.registry.ts`.
 *
 * Every kind the backend is willing to govern belongs here. A kind this union
 * omits is still returned by `GET /approval-workflows/kinds`, an admin can
 * configure a chain over it, and the shared inbox then draws a row whose
 * Approve button answers "Unsupported request type" — because `APPROVAL_KIND_UI`
 * is a total `Record` over this type, and a type that does not know about a kind
 * cannot be missing an entry for it. Kept in step, the compiler refuses
 * `approvalKinds.tsx` unless every governable kind has an inbox entry.
 */
export type ApprovalRequestType = 'LEAVE' | 'OVERTIME' | 'TRAINING';
/**
 * SEQUENTIAL — a step is actionable only after the previous approver accepts.
 * PARALLEL   — every step is actionable at once; all must approve.
 */
export type ApprovalMode = 'SEQUENTIAL' | 'PARALLEL';

/** One entry of the backend's approval-kind registry. */
export interface ApprovalKindMeta {
  type: ApprovalRequestType;
  label: string;
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

export interface UpsertWorkflowDto {
  requestType: ApprovalRequestType;
  name?: string;
  mode?: ApprovalMode;
  isActive?: boolean;
  steps: { approverType: ApproverType }[];
}

class ApprovalWorkflowService {
  /**
   * Request types the server can govern with a chain. Served from the backend
   * registry so the chain builder lists new types without a frontend release.
   */
  async kinds(): Promise<ApiResponse<ApprovalKindMeta[]>> {
    return axiosInstance.get('/approval-workflows/kinds');
  }

  /** List all configured approval workflows (ADMIN/HR). */
  async list(): Promise<ApiResponse<ApprovalWorkflow[]>> {
    return axiosInstance.get('/approval-workflows');
  }

  /** Create/replace the active workflow for a request type (ADMIN). */
  async upsert(dto: UpsertWorkflowDto): Promise<ApiResponse<ApprovalWorkflow>> {
    return axiosInstance.put('/approval-workflows', dto);
  }

  /** Enable/disable a workflow (ADMIN). */
  async setActive(
    id: string,
    isActive: boolean,
  ): Promise<ApiResponse<ApprovalWorkflow>> {
    return axiosInstance.patch(`/approval-workflows/${id}/active`, { isActive });
  }

  /** Active approval steps awaiting the current user. */
  async pendingForMe(): Promise<ApiResponse<any[]>> {
    return axiosInstance.get('/approval-workflows/pending/me');
  }

  /**
   * Whether the current user is an approver under the active chains (stable even
   * when the inbox is momentarily empty) — drives "Approvals" nav visibility.
   */
  async canApprove(): Promise<
    ApiResponse<{ isApprover: boolean; pending: number }>
  > {
    return axiosInstance.get('/approval-workflows/can-approve');
  }

  /** Approval inbox: pending leave/overtime the current user can act on. */
  async inbox(): Promise<ApiResponse<ApprovalInboxItem[]>> {
    return axiosInstance.get('/approval-workflows/inbox');
  }

  /**
   * Requests this user has already decided, newest first.
   *
   * The inbox is a queue — a row leaves it the moment it is acted on — so an
   * approver had no way to look back at what they decided, or at the correction
   * they made on the way through. This is that record.
   */
  async history(limit = 50): Promise<ApiResponse<ApprovalInboxItem[]>> {
    return axiosInstance.get(`/approval-workflows/history?limit=${limit}`);
  }

  /**
   * The approval trail for one request plus whether the CURRENT user may act on
   * the live step. Screens must gate their Approve/Reject buttons on `canAct`
   * rather than on the caller role — a configured chain routes to a supervisor
   * or a department manager, neither of whom carries an "approver" role.
   */
  async trail(
    type: ApprovalRequestType,
    requestId: string,
  ): Promise<ApiResponse<ApprovalTrail>> {
    return axiosInstance.get(`/approval-workflows/trail/${type}/${requestId}`);
  }
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
  /** false => no chain governs this request; use the legacy single-approver rule. */
  engaged: boolean;
  steps: ApprovalTrailStep[];
  activeStep: number | null;
  canAct: boolean;
}

export interface ApprovalInboxItem {
  requestType: ApprovalRequestType;
  requestId: string;
  stepOrder: number;
  approverType: ApproverType;
  request: any;
  /**
   * History rows only: what THIS user did. Not the request's own status — a
   * step-1 approval leaves the request PENDING behind it.
   */
  decision?: 'APPROVED' | 'REJECTED';
  decidedAt?: string;
  comment?: string | null;
}

export default new ApprovalWorkflowService();
