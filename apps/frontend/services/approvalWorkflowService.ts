import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  ApprovalInboxItem,
  ApprovalKindMeta,
  ApprovalRequestType,
  ApprovalTrail,
  ApprovalWorkflow,
  ApproverStanding,
  UpsertWorkflowPayload,
} from '@/types/approval';

class ApprovalWorkflowService {
  /**
   * The request types the server can govern with a chain.
   *
   * Served from the server's own registry rather than hardcoded, so a type
   * added there shows up in the chain builder and on the inbox card without a
   * frontend release.
   */
  kinds(): Promise<ApiResponse<ApprovalKindMeta[]>> {
    return axiosInstance.get('/approval-workflows/kinds');
  }

  list(): Promise<ApiResponse<ApprovalWorkflow[]>> {
    return axiosInstance.get('/approval-workflows');
  }

  /** Creates or replaces the active chain for one request type. */
  upsert(payload: UpsertWorkflowPayload): Promise<ApiResponse<ApprovalWorkflow>> {
    return axiosInstance.put('/approval-workflows', payload);
  }

  setActive(id: string, isActive: boolean): Promise<ApiResponse<ApprovalWorkflow>> {
    return axiosInstance.patch(`/approval-workflows/${id}/active`, { isActive });
  }

  /** The live steps waiting on the current user. */
  pendingForMe(): Promise<ApiResponse<ApprovalInboxItem[]>> {
    return axiosInstance.get('/approval-workflows/pending/me');
  }

  /**
   * Whether this user is an approver under any active chain.
   *
   * Separate from the inbox because it stays true while the queue is
   * momentarily empty — an approver whose nav entry vanished the moment they
   * cleared their queue would have no way back to the history.
   */
  canApprove(): Promise<ApiResponse<ApproverStanding>> {
    return axiosInstance.get('/approval-workflows/can-approve');
  }

  /** The queue: everything the current user can act on right now. */
  inbox(): Promise<ApiResponse<ApprovalInboxItem[]>> {
    return axiosInstance.get('/approval-workflows/inbox');
  }

  /**
   * What this user has already decided, newest first.
   *
   * The inbox is a queue — a row leaves it the instant it is acted on — so
   * without this an approver has no way to look back at what they decided.
   */
  history(limit = 50): Promise<ApiResponse<ApprovalInboxItem[]>> {
    return axiosInstance.get('/approval-workflows/history', { params: { limit } });
  }

  /**
   * The trail for one request, plus whether the CURRENT user may act on the
   * live step.
   *
   * Screens gate their Approve/Reject on `canAct` rather than on the caller's
   * role: a configured chain routes to a supervisor or a department manager,
   * and neither of those carries an approver role.
   */
  trail(
    type: ApprovalRequestType,
    requestId: string,
  ): Promise<ApiResponse<ApprovalTrail>> {
    return axiosInstance.get(`/approval-workflows/trail/${type}/${requestId}`);
  }
}

export default new ApprovalWorkflowService();
