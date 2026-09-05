/**
 * Resolve whether the sign-in screen should offer the seeded demo accounts.
 *
 * Evaluated in `next.config.ts` at BUILD time, not in the browser, and its
 * answer is inlined as a literal. That indirection is load-bearing: Next only
 * substitutes a `NEXT_PUBLIC_*` value that is actually SET, and leaves an unset
 * one as a runtime `process.env` lookup. An expression containing such a lookup
 * is not a constant, so nothing guarded by it can be folded away — which is how
 * a build with the panel switched off still shipped the account list and its
 * password inside the bundle, unrendered but perfectly readable.
 *
 * Resolving it here means the client sees `"true"` or `"false"` and never an
 * absent variable, so the guard folds and the credentials are removed.
 *
 * Defaults: on outside production (the case the panel exists for), off in a
 * production build unless somebody asks for it. Anything other than the two
 * literals is treated as unset — a typo must not read as consent to publish an
 * administrator password.
 */
export function resolveDemoLogins(
  flag: string | undefined,
  nodeEnv: string | undefined,
): boolean {
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return nodeEnv !== 'production';
}
