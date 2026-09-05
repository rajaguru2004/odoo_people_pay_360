import { Prisma, ApprovalRequestType } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export type { ApprovalRequestType };

/** One row in the approver's inbox, already hydrated from its domain table. */
export interface InboxRequest {
  id: string;
  [key: string]: unknown;
}

export interface HydrateOpts {
  /** Include decided rows. Default false — the inbox wants pending only. */
  anyStatus?: boolean;
}

/**
 * Everything the engine needs to know about a request type that is NOT generic.
 *
 * `RequestApproval` is a side table keyed by (requestType, requestId) with no
 * foreign key to the domain row, so the engine cannot resolve a requester or
 * render an inbox without a per-type hook. Keeping those hooks here rather than
 * as branches inside the engine means adding a governable type is one entry in
 * this file plus the enum value, not an edit across the whole module.
 */
export interface ApprovalKind {
  type: ApprovalRequestType;
  /** Deep link carried on the inbox card. */
  link: string;
  /** Human label for the chain builder and the inbox headers. */
  label: string;
  /**
   * The employee who raised this request, or null when the row is gone. The
   * engine treats "not resolvable" as a dead row rather than an error, so a
   * deleted request cannot wedge an approver's queue.
   */
  requesterOf(prisma: PrismaService, requestId: string): Promise<string | null>;
  /**
   * Hydrate rows for the approver's screens.
   *
   * Filters to requests still awaiting a decision by default, so anything
   * omitted drops off the inbox. `opts.anyStatus` lifts that filter for the
   * decided history, whose whole point is rows the approver has already
   * settled — hydrating those pending-only renders it permanently empty.
   */
  hydrate(
    prisma: PrismaService,
    ids: string[],
    opts?: HydrateOpts,
  ): Promise<InboxRequest[]>;
}

/** `{ status: 'PENDING' }` unless the caller asked for decided rows too. */
const statusFilter = (opts?: HydrateOpts) =>
  opts?.anyStatus ? {} : { status: 'PENDING' as const };

/**
 * Employee shape shown on every inbox card.
 *
 * `fullName` is joined below rather than selected: employees are stored as
 * `firstName`/`lastName` here, and the screens read one field.
 */
const EMPLOYEE_CARD_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  employeeCode: true,
  department: { select: { name: true } },
} satisfies Prisma.EmployeeSelect;

type EmployeeCard = Prisma.EmployeeGetPayload<{
  select: typeof EMPLOYEE_CARD_SELECT;
}>;

function withFullName(employee: EmployeeCard | null | undefined) {
  if (!employee) return employee ?? null;
  return {
    ...employee,
    fullName: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
  };
}

/** Attach the joined name to every hydrated row's employee. */
function cards<T extends { employee?: EmployeeCard | null }>(rows: T[]) {
  return rows.map((row) => ({
    ...row,
    employee: withFullName(row.employee),
  })) as unknown as InboxRequest[];
}

/** Shared `requesterOf` for any model with a plain `employeeId` column. */
function employeeIdOf(
  read: (
    prisma: PrismaService,
    requestId: string,
  ) => Promise<{ employeeId: string } | null>,
) {
  return async (prisma: PrismaService, requestId: string) => {
    const row = await read(prisma, requestId);
    return row?.employeeId ?? null;
  };
}

export const APPROVAL_KINDS: Record<ApprovalRequestType, ApprovalKind> = {
  LEAVE: {
    type: 'LEAVE',
    link: '/dashboard/leaves',
    label: 'Leave',
    requesterOf: employeeIdOf((prisma, id) =>
      prisma.leaveRequest.findUnique({
        where: { id },
        select: { employeeId: true },
      }),
    ),
    hydrate: async (prisma, ids, opts) =>
      cards(
        await prisma.leaveRequest.findMany({
          where: { id: { in: ids }, ...statusFilter(opts) },
          include: { employee: { select: EMPLOYEE_CARD_SELECT } },
        }),
      ),
  },

  OVERTIME: {
    type: 'OVERTIME',
    link: '/dashboard/overtime',
    label: 'Overtime',
    requesterOf: employeeIdOf((prisma, id) =>
      prisma.overtimeRequest.findUnique({
        where: { id },
        select: { employeeId: true },
      }),
    ),
    hydrate: async (prisma, ids, opts) =>
      cards(
        await prisma.overtimeRequest.findMany({
          where: { id: { in: ids }, ...statusFilter(opts) },
          include: { employee: { select: EMPLOYEE_CARD_SELECT } },
        }),
      ),
  },

  TRAINING: {
    type: 'TRAINING',
    link: '/dashboard/training',
    label: 'Training',
    requesterOf: employeeIdOf((prisma, id) =>
      prisma.trainingNomination.findUnique({
        where: { id },
        select: { employeeId: true },
      }),
    ),
    hydrate: async (prisma, ids, opts) =>
      cards(
        await prisma.trainingNomination.findMany({
          where: { id: { in: ids }, ...statusFilter(opts) },
          select: {
            id: true,
            status: true,
            cost: true,
            justification: true,
            session: {
              select: {
                startDate: true,
                endDate: true,
                course: { select: { code: true, title: true } },
              },
            },
            employee: { select: EMPLOYEE_CARD_SELECT },
          },
        }),
      ),
  },
};

/** Every governable request type, for DTO validation and the frontend picker. */
export const APPROVAL_REQUEST_TYPES = Object.keys(
  APPROVAL_KINDS,
) as ApprovalRequestType[];

export function isApprovalRequestType(v: unknown): v is ApprovalRequestType {
  return typeof v === 'string' && v in APPROVAL_KINDS;
}
