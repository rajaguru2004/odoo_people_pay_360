/**
 * Which registered actions decide which kind of request.
 *
 * The bridge between a notification saying "somebody must decide LEAVE #123"
 * and the two token-gated actions that can act on it. Kept as an explicit map
 * rather than derived from the action keys, because getting it wrong would mint
 * a capability for the wrong tool — and a map is reviewable in a way a naming
 * convention is not.
 *
 * Only request types with a REGISTERED, token-gated pair belong here. Adding a
 * row without adding the actions is a startup crash (boot invariant 12), not a
 * runtime surprise for the first approver who taps a button.
 */
export interface DecisionAction {
  actionKey: string;
  toolName: string;
}

export interface DecisionActionPair {
  approve: DecisionAction;
  reject: DecisionAction;
  /** Matches the audit vocabulary, and goes on the token row. */
  resourceType: string;
}

export const DECISION_ACTIONS: Readonly<Record<string, DecisionActionPair>> = {
  LEAVE: {
    approve: { actionKey: 'approval.leave.approve', toolName: 'leave_request_approve' },
    reject: { actionKey: 'approval.leave.reject', toolName: 'leave_request_reject' },
    resourceType: 'LeaveRequest',
  },
  OVERTIME: {
    approve: { actionKey: 'approval.overtime.approve', toolName: 'overtime_approve' },
    reject: { actionKey: 'approval.overtime.reject', toolName: 'overtime_reject' },
    resourceType: 'OvertimeRequest',
  },
};

export function decisionActionsFor(requestType: string | undefined): DecisionActionPair | undefined {
  return requestType ? DECISION_ACTIONS[requestType] : undefined;
}
