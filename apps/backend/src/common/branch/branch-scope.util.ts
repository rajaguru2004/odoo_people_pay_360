import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BranchContext, getBranchContext } from './branch-context';
import { BRANCH_SCOPE, buildBranchWhere } from './branch-scope.map';

/** Concrete branch ids the current request is restricted to, or null when the
 *  caller is unscoped/global (no filter). Empty array = scoped-but-no-branches
 *  (fail-closed: callers should match nothing). */
export function getScopedBranchIds(): string[] | null {
  const ctx = getBranchContext();
  if (!ctx || ctx.isAllBranches) return null;
  return ctx.effectiveBranchId
    ? [ctx.effectiveBranchId]
    : ctx.accessibleBranchIds;
}

/**
 * A `Prisma.Sql` fragment that restricts `<alias>.branch_id` to the active branch
 * scope, for use inside `$queryRaw` (which the Prisma `$use` middleware cannot
 * see). Returns `Prisma.empty` for unscoped/global callers. Fail-closed: an empty
 * envelope yields `= ANY('{}'::uuid[])`, which matches no rows.
 *
 * `alias` is a caller-supplied SQL identifier (e.g. `'e'`), never end-user input,
 * so interpolating it via `Prisma.raw` is safe. The fragment begins with `AND `,
 * so splice it into an existing `WHERE` clause.
 */
export function rawBranchFilter(alias = 'e'): Prisma.Sql {
  const ids = getScopedBranchIds();
  if (ids === null) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.raw(alias)}.branch_id = ANY(${ids}::uuid[])`;
}

/** Minimal shape of the authenticated principal used for branch resolution. */
export interface BranchPrincipal {
  role?: string;
  isGlobalBranchAccess?: boolean;
  accessibleBranchIds?: string[] | 'ALL';
  homeBranchId?: string | null;
}

export interface ResolveResult {
  ctx: BranchContext;
  /** Present when the requested branch is outside the caller's envelope. */
  crossBranchAttempt?: { requested: string; accessible: string[] };
}

/**
 * Resolve the effective branch context from the server-derived envelope
 * (`req.user`) and the client-supplied `X-Branch-Id` selector. The selector can
 * only *narrow* within the envelope — it can never widen it. Requesting a branch
 * outside the envelope surfaces `crossBranchAttempt` (the interceptor decides
 * whether to 403, based on enforcement mode).
 */
export function resolveBranchContext(
  user: BranchPrincipal | undefined,
  requested: string | undefined,
): ResolveResult {
  const isGlobal =
    user?.isGlobalBranchAccess === true || user?.accessibleBranchIds === 'ALL';
  const envelope: string[] = Array.isArray(user?.accessibleBranchIds)
    ? (user!.accessibleBranchIds as string[])
    : [];
  const req = requested && requested.trim() ? requested.trim() : undefined;

  if (isGlobal) {
    if (!req || req === 'ALL') {
      return {
        ctx: {
          effectiveBranchId: null,
          accessibleBranchIds: [],
          isAllBranches: true,
          isGlobal: true,
        },
      };
    }
    return {
      ctx: {
        effectiveBranchId: req,
        accessibleBranchIds: [req],
        isAllBranches: false,
        isGlobal: true,
      },
    };
  }

  // Scoped caller: default (no header / "ALL") = all branches within envelope.
  if (!req || req === 'ALL') {
    return {
      ctx: {
        effectiveBranchId: null,
        accessibleBranchIds: envelope,
        isAllBranches: false,
        isGlobal: false,
      },
    };
  }
  if (envelope.includes(req)) {
    return {
      ctx: {
        effectiveBranchId: req,
        accessibleBranchIds: envelope,
        isAllBranches: false,
        isGlobal: false,
      },
    };
  }
  // Requested a branch outside the envelope — fall back to the safe envelope
  // scope and report the attempt.
  return {
    ctx: {
      effectiveBranchId: null,
      accessibleBranchIds: envelope,
      isAllBranches: false,
      isGlobal: false,
    },
    crossBranchAttempt: { requested: req, accessible: envelope },
  };
}

/** The branch this request writes into (for stamping created rows), or null. */
export function getEffectiveBranchId(): string | null {
  return getBranchContext()?.effectiveBranchId ?? null;
}

/**
 * AND-compose a branch predicate onto a service-level `where`. Use in hot paths
 * (employee/attendance lists) for explicit, testable scoping; the Prisma
 * middleware is the fail-closed backstop for everything else.
 */
export function scopeWhere<T extends Record<string, any>>(
  model: string,
  where: T = {} as T,
): T {
  const ctx = getBranchContext();
  if (!ctx || ctx.isAllBranches) return where;
  const rule = BRANCH_SCOPE[model];
  if (!rule) return where;
  const ids = ctx.effectiveBranchId
    ? [ctx.effectiveBranchId]
    : ctx.accessibleBranchIds;
  const branchWhere = buildBranchWhere(rule, ids);
  const hasKeys = where && Object.keys(where).length > 0;
  return (hasKeys
    ? { AND: [where, branchWhere] }
    : branchWhere) as unknown as T;
}

/**
 * Object-level authorization for by-id access. Throws 404 (not 403 — no
 * existence leak) when the entity's branch is outside the caller's scope.
 * `entityBranchId` is the row's own branchId, or its employee's branchId for
 * relation-scoped models.
 */
export function assertInBranch(
  entityBranchId: string | null | undefined,
): void {
  const ctx = getBranchContext();
  if (!ctx || ctx.isAllBranches) return;
  // A record with no branch (null) is company-wide / unassigned — it is not
  // "another branch's" data. A global caller owns the whole company, and
  // narrowing the active branch is only a *view* filter (see
  // assertBranchAssignable), so it must not 404 them out of a company-wide
  // record such as a company-wide payroll run (branchId = null). Non-global
  // scoped callers stay restricted (fail-closed).
  if (entityBranchId == null) {
    if (ctx.isGlobal) return;
    throw new NotFoundException();
  }
  const allowed = ctx.effectiveBranchId
    ? entityBranchId === ctx.effectiveBranchId
    : ctx.accessibleBranchIds.includes(entityBranchId);
  if (!allowed) throw new NotFoundException();
}

/**
 * The branches the caller may reach AT ALL, or null when they may reach every
 * branch. This is the ENVELOPE, deliberately not the narrowed selection: the
 * branch list is the picker's own source, so narrowing to one branch must not
 * hide the others the user is allowed to switch to.
 *
 * Used for the `Branch` model itself, which cannot be handled by the branch
 * scope map — its identity IS the branch, so there is no `branchId` column for
 * the map's rules to filter on.
 */
export function getEnvelopeBranchIds(): string[] | null {
  const ctx = getBranchContext();
  if (!ctx || ctx.isAllBranches || ctx.isGlobal) return null;
  return ctx.accessibleBranchIds;
}

/**
 * Object-level authorization for a branch record itself. 404 rather than 403,
 * for the same reason `assertInBranch` does: a scoped caller must not be able to
 * learn that a branch exists by the shape of the refusal.
 */
export function assertBranchVisible(branchId: string): void {
  const envelope = getEnvelopeBranchIds();
  if (envelope === null) return;
  if (!envelope.includes(branchId))
    throw new NotFoundException('Branch not found');
}

/**
 * Authorize the *target* branch of a new record (e.g. onboarding an employee
 * into branch X). Unlike `assertInBranch`, this ignores the currently-narrowed
 * `effectiveBranchId` (the UI's active-branch selector) — narrowing is a view
 * filter for reads, not a ceiling on what a global caller may create. Global
 * callers may assign any branch; scoped callers are still limited to their
 * full envelope (`accessibleBranchIds`, which stays the complete list even
 * when narrowed — see resolveBranchContext).
 */
export function assertBranchAssignable(targetBranchId: string): void {
  const ctx = getBranchContext();
  if (!ctx || ctx.isAllBranches || ctx.isGlobal) return;
  if (!ctx.accessibleBranchIds.includes(targetBranchId)) {
    // The caller picked this branch from their own UI, so there's no
    // existence to leak here (unlike assertInBranch's read-path 404) — a
    // clear message beats a bare 404.
    throw new ForbiddenException(
      'You do not have access to assign records to this branch.',
    );
  }
}
