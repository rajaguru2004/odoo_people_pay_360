import { describe, expect, it, vi } from 'vitest';

/**
 * `DEMO_LOGINS_ENABLED` is a build-time constant: `next.config.ts` resolves the
 * rule (tested in demoLoginsGate.test.ts) and inlines the answer, so there is
 * nothing to evaluate at runtime here. What this file guards is the OTHER half
 * of the arrangement — that this module stays free of credentials.
 */
describe('demoAccounts', () => {
  it('exports the decision and nothing else', async () => {
    vi.resetModules();
    const mod = await import('./demoAccounts');

    // The accounts live in the panel component. If they ever move back here,
    // the bundler can no longer drop them when the gate folds to false — the
    // sign-in page imports THIS module unconditionally, so anything beside the
    // constant is shipped whether the panel renders or not.
    expect(Object.keys(mod)).toEqual(['DEMO_LOGINS_ENABLED']);
    expect(typeof mod.DEMO_LOGINS_ENABLED).toBe('boolean');
  });
});
