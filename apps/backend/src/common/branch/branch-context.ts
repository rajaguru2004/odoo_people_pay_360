import { AsyncLocalStorage } from 'async_hooks';

/**
 * Request-scoped multi-branch context.
 *
 * Established per request by BranchContextMiddleware (seeds an empty, mutable
 * store) and filled by BranchContextInterceptor once `req.user` exists. The
 * Prisma `$use` middleware, service-level `scopeWhere`, and object-level
 * `assertInBranch` all read the context from here — a single source of truth.
 *
 * Uses Node's built-in AsyncLocalStorage (no external dependency).
 */

export type BranchEnforcement = 'off' | 'shadow' | 'on';

export interface BranchContext {
  /** A single concrete branch to scope to, or null = "not narrowed to one". */
  effectiveBranchId: string | null;
  /** Concrete branches the caller may see (used when effectiveBranchId is null). */
  accessibleBranchIds: string[];
  /** True only for global (all-branches, incl. future) callers — no filter applied. */
  isAllBranches: boolean;
  /** Whether the caller has global branch access. */
  isGlobal: boolean;
}

interface BranchStore {
  ctx: BranchContext | null;
  /**
   * How many bypasses are currently open, NOT a boolean.
   *
   * This was a boolean with save/restore, and that is unsound the moment two
   * bypasses overlap in one store — which they do, because the store is shared
   * across everything a request awaits. Interleaved, save/restore ends like
   * this:
   *
   *   A: prev = false; bypass = true
   *   B: prev = TRUE;  bypass = true
   *   A: bypass = prev (false)
   *   B: bypass = prev (TRUE)   <-- stuck on, for the rest of the request
   *
   * A stuck bypass makes getBranchContext() return null forever after, so
   * every later tool call fail-closes with "branch context missing" while
   * earlier ones in the same request succeeded. Counting makes the nesting
   * order irrelevant: the flag clears only when the last bypass closes.
   */
  bypassDepth: number;
}

const als = new AsyncLocalStorage<BranchStore>();

/** Seed an empty, mutable branch store for the lifetime of a request. */
export function runWithBranchStore<T>(fn: () => T): T {
  return als.run({ ctx: null, bypassDepth: 0 }, fn);
}

/** Fill the current request's branch context (called by the interceptor). */
export function setBranchContext(ctx: BranchContext | null): void {
  const store = als.getStore();
  if (store) store.ctx = ctx;
}

/** Read the effective branch context, or null when unscoped / bypassed / no request. */
export function getBranchContext(): BranchContext | null {
  const store = als.getStore();
  if (!store || store.bypassDepth > 0) return null;
  return store.ctx;
}

/**
 * Run a function with branch scoping disabled (system operations: audit record
 * lookups, cross-branch admin reports, globally-unique code generation).
 *
 * Mutates the *active* store's bypass flag rather than nesting a new als.run —
 * a nested context does not reliably propagate into Prisma's `$use` async
 * execution, whereas the already-active store is exactly the one `$use` reads.
 */
export async function runWithBranchBypass<T>(fn: () => Promise<T>): Promise<T> {
  const store = als.getStore();
  if (!store) return fn(); // no request context (scripts/seeds) — nothing to bypass
  store.bypassDepth++;
  try {
    return await fn();
  } finally {
    // Counted, never assigned: see BranchStore.bypassDepth for why restoring a
    // saved boolean here silently disabled branch scoping for whole requests.
    store.bypassDepth--;
  }
}

/** Resolve the enforcement mode from env. Defaults to full enforcement. */
export function getBranchEnforcement(): BranchEnforcement {
  const v = (process.env.BRANCH_ENFORCEMENT || 'on').toLowerCase();
  return v === 'off' || v === 'shadow' ? (v as BranchEnforcement) : 'on';
}
