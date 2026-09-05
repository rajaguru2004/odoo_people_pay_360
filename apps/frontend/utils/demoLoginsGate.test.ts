import { describe, expect, it } from 'vitest';
import { resolveDemoLogins } from './demoLoginsGate';

/**
 * The rule that decides whether an administrator's email and password reach a
 * built bundle. Worth testing exhaustively.
 */
describe('resolveDemoLogins', () => {
  it('is on outside production, which is the case the panel exists for', () => {
    expect(resolveDemoLogins(undefined, 'development')).toBe(true);
    expect(resolveDemoLogins(undefined, 'test')).toBe(true);
  });

  it('is OFF in a production build unless somebody asked for it', () => {
    expect(resolveDemoLogins(undefined, 'production')).toBe(false);
    expect(resolveDemoLogins('', 'production')).toBe(false);
  });

  it('can be switched on for a deliberate demo deployment', () => {
    expect(resolveDemoLogins('true', 'production')).toBe(true);
  });

  it('can be switched off outside production too', () => {
    // Demonstrating a dev build to a client should not require building in
    // production mode just to hide the panel.
    expect(resolveDemoLogins('false', 'development')).toBe(false);
  });

  it('treats anything other than the two literals as unset', () => {
    // A typo must never read as consent to publish credentials.
    for (const typo of ['yes', 'TRUE', '1', 'on', 'enabled']) {
      expect(resolveDemoLogins(typo, 'production')).toBe(false);
    }
  });
});
