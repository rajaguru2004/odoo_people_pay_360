import type { PrismaService } from '../prisma/prisma.service';

/**
 * Every request type the approval engine can govern.
 *
 * Must stay in lockstep with the Prisma `ApprovalRequestType` enum. Add both in
 * the same change: the DB enum value (`ALTER TYPE ... ADD VALUE`, which cannot
 * run inside a transaction block, so it needs its own migration file) and the
 * `APPROVAL_KINDS` entry below.
 */
export type ApprovalRequestType =
  | 'LEAVE'
  | 'OVERTIME'
  | 'BANK_CHANGE'
  | 'TRAVEL'
  | 'TRAINING'
  | 'ADVANCE_LOAN';

/** One row in the approver's inbox, already hydrated from its domain table. */
export interface InboxRequest {
  id: string;
  [key: string]: unknown;
}

/**
 * Everything the engine needs to know about a request type that is NOT generic.
 *
 * `RequestApproval` is a polymorphic side-table keyed by (requestType, requestId)
 * with no FK to the domain row, so the engine cannot resolve a requester or
 * render an inbox without a per-type hook. Before this registry those hooks were
 * hardcoded ternaries inside the engine, and adding a type meant editing ~10
 * files; now it is one entry here plus the enum value.
 */
export interface ApprovalKind {
  type: ApprovalRequestType;
  /** Deep link used in approver + requester notifications. */
  link: string;
  /** Human label for the settings chain builder and inbox headers. */
  label: string;
  /**
   * The employee who raised this request. Returns null when the row is gone —
   * the engine treats that as "not resolvable" rather than throwing, so a
   * deleted request cannot wedge an approver's queue.
   */
  requesterOf(prisma: PrismaService, requestId: string): Promise<string | null>;
  /**
   * Hydrate rows for the approver's screens.
   *
   * By default it filters to requests still awaiting a decision, so anything
   * omitted is dropped from the INBOX by the caller. `opts.anyStatus` lifts
   * that filter for the DECIDED history, where the whole point is the rows an
   * approver has already settled — filtering them to PENDING would return an
   * empty list and the history would look permanently empty.
   */
  hydrate(
    prisma: PrismaService,
    ids: string[],
    opts?: HydrateOpts,
  ): Promise<InboxRequest[]>;
}

export interface HydrateOpts {
  /** Include decided rows. Default false — the inbox wants pending only. */
  anyStatus?: boolean;
}

/** `{ status: 'PENDING' }` unless the caller asked for decided rows too. */
const statusFilter = (opts?: HydrateOpts) =>
  opts?.anyStatus ? {} : { status: 'PENDING' as const };

/** Employee shape shown on every inbox card. */
const empSelect = {
  id: true,
  fullName: true,
  employeeCode: true,
  department: { select: { name: true } },
} as const;

/** Shared `requesterOf` for any model with a plain `employeeId` column. */
function employeeIdOf(
  delegate: (prisma: PrismaService) => {
    findUnique(args: any): Promise<{ employeeId: string } | null>;
  },
) {
  return async (prisma: PrismaService, requestId: string) => {
    const row = await delegate(prisma).findUnique({
      where: { id: requestId },
      select: { employeeId: true },
    });
    return row?.employeeId ?? null;
  };
}

export const APPROVAL_KINDS: Record<ApprovalRequestType, ApprovalKind> = {
  LEAVE: {
    type: 'LEAVE',
    link: '/dashboard/leaves',
    label: 'Leave',
    requesterOf: employeeIdOf((p) => p.leaveRequest as any),
    hydrate: (prisma, ids, opts) =>
      prisma.leaveRequest.findMany({
        where: { id: { in: ids }, ...statusFilter(opts) },
        include: { employee: { select: empSelect } },
      }) as unknown as Promise<InboxRequest[]>,
  },

  OVERTIME: {
    type: 'OVERTIME',
    link: '/dashboard/overtime',
    label: 'Overtime',
    requesterOf: employeeIdOf((p) => p.overtimeRequest as any),
    hydrate: (prisma, ids, opts) =>
      prisma.overtimeRequest.findMany({
        where: { id: { in: ids }, ...statusFilter(opts) },
        include: { employee: { select: empSelect } },
      }) as unknown as Promise<InboxRequest[]>,
  },

  TRAVEL: {
    type: 'TRAVEL',
    link: '/dashboard/travel',
    label: 'Travel',
    requesterOf: employeeIdOf((p) => p.travelRequest as any),
    hydrate: (prisma, ids, opts) =>
      prisma.travelRequest.findMany({
        where: { id: { in: ids }, ...statusFilter(opts) },
        select: {
          id: true,
          status: true,
          destination: true,
          country: true,
          travelType: true,
          departureDate: true,
          returnDate: true,
          estimatedCost: true,
          purpose: true,
          employee: { select: empSelect },
        },
      }) as unknown as Promise<InboxRequest[]>,
  },

  TRAINING: {
    type: 'TRAINING',
    link: '/dashboard/training',
    label: 'Training',
    requesterOf: employeeIdOf((p) => p.trainingNomination as any),
    hydrate: (prisma, ids, opts) =>
      prisma.trainingNomination.findMany({
        where: { id: { in: ids }, ...statusFilter(opts) },
        select: {
          id: true,
          status: true,
          cost: true,
          source: true,
          justification: true,
          session: {
            select: {
              startDate: true,
              endDate: true,
              course: { select: { code: true, title: true } },
            },
          },
          employee: { select: empSelect },
        },
      }) as unknown as Promise<InboxRequest[]>,
  },

  ADVANCE_LOAN: {
    type: 'ADVANCE_LOAN',
    link: '/dashboard/advance-loans',
    label: 'Advance & Loan',
    requesterOf: employeeIdOf((p) => p.advanceLoanRequest as any),
    hydrate: (prisma, ids, opts) =>
      prisma.advanceLoanRequest.findMany({
        where: { id: { in: ids }, ...statusFilter(opts) },
        select: {
          id: true,
          status: true,
          type: true,
          amount: true,
          installments: true,
          interestMethod: true,
          interestRate: true,
          reason: true,
          referenceNo: true,
          currency: true,
          createdAt: true,
          loanType: { select: { code: true, name: true } },
          employee: { select: empSelect },
        },
      }) as unknown as Promise<InboxRequest[]>,
  },

  BANK_CHANGE: {
    type: 'BANK_CHANGE',
    link: '/dashboard/approvals',
    label: 'Bank Change',
    requesterOf: employeeIdOf((p) => p.bankChangeRequest as any),
    hydrate: (prisma, ids, opts) =>
      prisma.bankChangeRequest.findMany({
        where: { id: { in: ids }, ...statusFilter(opts) },
        // Bank/account values are intentionally NOT hydrated — approvers decide
        // on the fact of a change, not the raw payment details (PII).
        select: {
          id: true,
          status: true,
          bank: { select: { name: true } },
          employee: { select: empSelect },
        },
      }) as unknown as Promise<InboxRequest[]>,
  },
};

/** All governable request types, for DTO validation and the frontend picker. */
export const APPROVAL_REQUEST_TYPES = Object.keys(
  APPROVAL_KINDS,
) as ApprovalRequestType[];

export function isApprovalRequestType(v: unknown): v is ApprovalRequestType {
  return typeof v === 'string' && v in APPROVAL_KINDS;
}

/** Registry entry for a type, or undefined when the type is unknown. */
export function approvalKind(
  type: string,
): ApprovalKind | undefined {
  return APPROVAL_KINDS[type as ApprovalRequestType];
}
