import type { UserRole } from '@prisma/client';

export const GRIEVANCE_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'RESOLVED',
  'CLOSED',
  'WITHDRAWN',
] as const;

export type GrievanceStatus = (typeof GRIEVANCE_STATUSES)[number];

/**
 * "Still on somebody's desk" — the single definition of an open case.
 *
 * A grievance is open until it is resolved, closed or withdrawn. Everything
 * else is a STAGE of being open, not a different thing; counting only OPEN and
 * ACKNOWLEDGED drops INVESTIGATING, which is the status a case spends the
 * longest in.
 */
export const OPEN_GRIEVANCE_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
] as const;

/** How long an open case may sit before the desk calls it out. */
export const GRIEVANCE_AGING_DAYS = 14;

/** Statuses the complainant may still withdraw from. */
export const WITHDRAWABLE_STATUSES = new Set<string>(['OPEN', 'ACKNOWLEDGED']);

/** The roles that run the grievance desk. */
const HANDLER_ROLES: UserRole[] = ['ADMIN', 'HR_MANAGER'];

export interface GrievanceReader {
  id?: string;
  role?: UserRole | string;
  employeeId?: string | null;
}

export interface GrievanceSubject {
  employeeId: string;
  againstEmployeeId?: string | null;
  assignedToId?: string | null;
}

export function isGrievanceHandler(user: GrievanceReader | null | undefined) {
  return HANDLER_ROLES.includes(user?.role as UserRole);
}

/**
 * May this person read this grievance?
 *
 * The rule that outranks every other: a grievance ABOUT someone is never
 * visible to that someone — not as HR, not as the assigned handler, not as an
 * administrator. The check runs first and returns false before any role is
 * consulted.
 *
 * Department scope is deliberately absent. A manager heading the complainant's
 * department is frequently the person being complained about, so scoping by
 * department would hand the case to exactly the wrong reader.
 */
export function canReadGrievance(
  grievance: GrievanceSubject,
  user: GrievanceReader | null | undefined,
): boolean {
  if (!user) return false;
  if (
    grievance.againstEmployeeId &&
    grievance.againstEmployeeId === user.employeeId
  ) {
    return false;
  }
  if (user.employeeId && grievance.employeeId === user.employeeId) return true;
  if (user.id && grievance.assignedToId === user.id) return true;
  return isGrievanceHandler(user);
}

/**
 * Whether the reader sees the handler's internal notes.
 *
 * The complainant does not, however the case was raised — the notes are how a
 * handler thinks out loud about it.
 */
export function canReadInternalNotes(
  grievance: GrievanceSubject,
  user: GrievanceReader | null | undefined,
): boolean {
  if (!user) return false;
  return isGrievanceHandler(user) || grievance.assignedToId === user.id;
}
