/**
 * Whether the sign-in screen offers the seeded demo accounts.
 *
 * A single comparison against a value `next.config.ts` guarantees is present
 * (see `resolveDemoLogins`), so `next build` folds this to a literal `true` or
 * `false`. When it is `false` the JSX guarded by it is dead code, the panel
 * component becomes unreferenced, and the account list and password it carries
 * are dropped from the bundle — absent, not merely undrawn.
 *
 * That is why this module holds the decision and nothing else. The sign-in page
 * imports it unconditionally; anything sitting beside it would be pulled in too.
 */
export const DEMO_LOGINS_ENABLED =
  process.env.NEXT_PUBLIC_DEMO_LOGINS === 'true';
