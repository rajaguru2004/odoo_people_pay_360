/** Every request that can be reviewed shares this lifecycle. */
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** What a reviewer decided. The server refuses a second review of either kind. */
export type ReviewAction = 'APPROVE' | 'REJECT';

export interface ReviewPayload {
  action: ReviewAction;
  reviewNote?: string;
}

/** The trimmed employee shape every list endpoint embeds. */
export interface EmployeeRef {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  position?: string | null;
  avatarUrl?: string | null;
}

/** The trimmed user shape a review trail embeds. */
export interface UserRef {
  id: string;
  email: string;
  employee?: { id: string; firstName: string; lastName: string } | null;
}

export interface NamedRef {
  id: string;
  code: string;
  name: string;
}
