'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import approvalWorkflowService from '@/services/approvalWorkflowService';
import leaveService from '@/services/leaveService';
import overtimeService from '@/services/overtimeService';
import type {
  ApprovalInboxItem,
  ApprovalRequestType,
  UpsertWorkflowPayload,
} from '@/types/approval';
import { leaveKeys } from './useLeaveRequests';
import { overtimeKeys } from './useOvertime';

export const approvalKeys = {
  all: ['approvals'] as const,
  kinds: () => [...approvalKeys.all, 'kinds'] as const,
  inbox: () => [...approvalKeys.all, 'inbox'] as const,
  history: (limit: number) => [...approvalKeys.all, 'history', limit] as const,
  standing: () => [...approvalKeys.all, 'standing'] as const,
  workflows: () => [...approvalKeys.all, 'workflows'] as const,
  trail: (type: ApprovalRequestType, requestId: string) =>
    [...approvalKeys.all, 'trail', type, requestId] as const,
};

/** The request types the server governs, with the labels it names them by. */
export function useApprovalKinds() {
  return useQuery({
    queryKey: approvalKeys.kinds(),
    queryFn: () => approvalWorkflowService.kinds(),
    // The registry changes with a deployment, not with a user's session.
    staleTime: 30 * 60 * 1000,
  });
}

export function useApprovalInbox(enabled = true) {
  return useQuery({
    queryKey: approvalKeys.inbox(),
    queryFn: () => approvalWorkflowService.inbox(),
    enabled,
  });
}

export function useApprovalHistory(limit = 50, enabled = true) {
  return useQuery({
    queryKey: approvalKeys.history(limit),
    queryFn: () => approvalWorkflowService.history(limit),
    enabled,
  });
}

export function useApproverStanding() {
  return useQuery({
    queryKey: approvalKeys.standing(),
    queryFn: () => approvalWorkflowService.canApprove(),
  });
}

/**
 * The trail for one request, and whether this user may act on the live step.
 *
 * Gate the decision controls on `canAct`. A configured chain routes to a
 * supervisor or a department manager, and neither of those carries a role that
 * a client-side permission check would recognise as an approver.
 */
export function useApprovalTrail(
  type: ApprovalRequestType,
  requestId: string | undefined,
) {
  return useQuery({
    queryKey: approvalKeys.trail(type, requestId!),
    queryFn: () => approvalWorkflowService.trail(type, requestId!),
    enabled: !!requestId,
    // No chain configured is a legitimate answer, not a fault to retry.
    retry: false,
  });
}

export type ApprovalDecision = 'APPROVE' | 'REJECT';

export interface DecideApprovalVariables {
  item: ApprovalInboxItem;
  decision: ApprovalDecision;
  /** Required on a rejection — the person who filed it is owed a reason. */
  reason?: string;
}

/**
 * Decide one request from the inbox.
 *
 * The call goes to the request's OWN module rather than to a workflow route:
 * approving overtime prices the claim and approving leave moves a balance, and
 * a generic "record the step" endpoint would leave both unrun. The switch is
 * total over the governable types, so a type added to the registry cannot
 * quietly fall through to the wrong module.
 */
export function useDecideApproval() {
  const queryClient = useQueryClient();

  return useMutation({
    // The return type is widened deliberately: each kind answers with its own
    // row, and the queue only ever needs to know the decision landed.
    mutationFn: ({
      item,
      decision,
      reason,
    }: DecideApprovalVariables): Promise<unknown> => {
      const text = reason?.trim() ?? '';

      switch (item.requestType) {
        case 'LEAVE':
          return decision === 'APPROVE'
            ? leaveService.approve(item.requestId)
            : leaveService.reject(item.requestId, text);

        case 'OVERTIME':
          return decision === 'APPROVE'
            ? overtimeService.approve(item.requestId)
            : overtimeService.reject(item.requestId, text);

        case 'TRAINING':
          // Nominations are settled inside the training module, which has no
          // screen here yet. The card is drawn without controls rather than
          // pointed at a route that does not answer.
          return Promise.reject(
            new Error('Training nominations are decided in the training module'),
          );
      }
    },
    // Every subtree the decision touched: the row leaves the queue and lands
    // in the history, and the request's own list has a new standing to show.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: approvalKeys.all });
      void queryClient.invalidateQueries({ queryKey: overtimeKeys.all });
      void queryClient.invalidateQueries({ queryKey: leaveKeys.all });
    },
  });
}

/**
 * Every configured chain. ADMIN and HR may read them; only ADMIN may write one.
 *
 * `enabled` rather than an unconditional fetch so the settings screen can mount
 * the chain builder for a role that is allowed to look at it and skip the call
 * entirely for one that is not.
 */
export function useApprovalWorkflows(enabled = true) {
  return useQuery({
    queryKey: approvalKeys.workflows(),
    queryFn: () => approvalWorkflowService.list(),
    enabled,
  });
}

/** Creates or replaces the active chain for one request type. */
export function useUpsertApprovalWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpsertWorkflowPayload) => approvalWorkflowService.upsert(payload),
    // The whole subtree: a chain change decides who the open requests in the
    // inbox are now waiting on, not just what the builder draws.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: approvalKeys.all }),
  });
}
