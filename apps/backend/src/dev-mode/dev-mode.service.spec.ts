import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DevModeService } from './dev-mode.service';

/**
 * Pins the security properties of the elevation token. Each test here maps to a
 * way the gate could be walked around:
 *
 *   - guessing the password              -> bcrypt compare
 *   - forging a token from JWT_SECRET    -> distinct signing secret
 *   - replaying someone else's token     -> sub bound to the session user
 *   - reusing a revoked/expired token    -> server-side jti allowlist
 *   - elevating from a non-ADMIN account -> role check
 */
const PASSWORD = 'correct-horse-battery-staple';
const TOKEN_SECRET = 'dev-mode-token-secret-not-the-jwt-one';

function makeService(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    DEV_MODE_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4), // low cost: tests only
    DEV_MODE_TOKEN_SECRET: TOKEN_SECRET,
    DEV_MODE_TTL_MINUTES: '20',
    DEV_MODE_ENFORCED: 'true',
    ...overrides,
  };
  const config: any = { get: (k: string) => env[k] };
  return new DevModeService(config, new JwtService({}));
}

function reqFor(userId: string, token?: string, role = 'ADMIN') {
  return {
    user: { id: userId, role },
    headers: token ? { 'x-dev-token': token } : {},
  };
}

describe('DevModeService', () => {
  describe('password verification', () => {
    it('accepts the configured password', async () => {
      await expect(makeService().verifyPassword(PASSWORD)).resolves.toBe(true);
    });

    it('rejects a wrong password', async () => {
      await expect(makeService().verifyPassword('nope')).resolves.toBe(false);
    });

    it('rejects an empty password rather than treating it as a match', async () => {
      await expect(makeService().verifyPassword('')).resolves.toBe(false);
    });

    it('is unavailable, and refuses everything, when no hash is configured', async () => {
      const svc = makeService({ DEV_MODE_PASSWORD_HASH: '' });
      expect(svc.isAvailable()).toBe(false);
      await expect(svc.verifyPassword(PASSWORD)).resolves.toBe(false);
    });

    it('fails closed on a malformed hash instead of throwing', async () => {
      const svc = makeService({ DEV_MODE_PASSWORD_HASH: 'not-a-bcrypt-hash' });
      await expect(svc.verifyPassword(PASSWORD)).resolves.toBe(false);
    });

    it('reports unavailable when the hash is present but not a bcrypt hash', () => {
      // Distinguishing this from "blank" is what lets onModuleInit warn instead
      // of leaving a bare 401 as the only symptom.
      expect(makeService({ DEV_MODE_PASSWORD_HASH: 'Dev@1234' }).isAvailable()).toBe(false);
      expect(makeService({ DEV_MODE_PASSWORD_HASH: '$2b$12$short' }).isAvailable()).toBe(false);
    });

    describe('hashes mangled in transit still work', () => {
      const HASH = bcrypt.hashSync(PASSWORD, 4);

      it('tolerates the surrounding double quotes Docker Compose env_file can keep', async () => {
        const svc = makeService({ DEV_MODE_PASSWORD_HASH: `"${HASH}"` });
        expect(svc.isAvailable()).toBe(true);
        await expect(svc.verifyPassword(PASSWORD)).resolves.toBe(true);
      });

      it('tolerates single quotes and stray whitespace', async () => {
        const svc = makeService({ DEV_MODE_PASSWORD_HASH: `  '${HASH}'  ` });
        await expect(svc.verifyPassword(PASSWORD)).resolves.toBe(true);
      });

      it('accepts the $$-escaped form Docker Compose requires', async () => {
        // What you must write in a .env that Compose reads. Compose collapses
        // $$ -> $ itself; on the host dotenv does not, so the service must.
        const svc = makeService({ DEV_MODE_PASSWORD_HASH: HASH.replace(/\$/g, '$$$$') });
        expect(svc.isAvailable()).toBe(true);
        await expect(svc.verifyPassword(PASSWORD)).resolves.toBe(true);
      });

      it('accepts $$-escaped AND quoted together', async () => {
        const svc = makeService({
          DEV_MODE_PASSWORD_HASH: `"${HASH.replace(/\$/g, '$$$$')}"`,
        });
        await expect(svc.verifyPassword(PASSWORD)).resolves.toBe(true);
      });

      it('does NOT silently accept a hash whose $ segments were already eaten', async () => {
        // The real production symptom: $2b$12$pSOAs0lIbIKeFHLN.Bo31... arrived
        // as $2b$12.Bo31... because Compose substituted $pSOAs0lIbIKeFHLN away.
        // The original is unrecoverable, so this stays a hard, loud failure.
        const eaten = '$2b$12.Bo31.FnwY9M7QlyNj/CJlr0tBp9pow.1747q';
        const svc = makeService({ DEV_MODE_PASSWORD_HASH: eaten });
        expect(svc.isAvailable()).toBe(false);
        await expect(svc.verifyPassword(PASSWORD)).resolves.toBe(false);
      });
    });
  });

  describe('elevation tokens', () => {
    it('elevates the user who authenticated', () => {
      const svc = makeService();
      const { devToken } = svc.elevate('user-1');
      expect(svc.isElevated(reqFor('user-1', devToken))).toBe(true);
    });

    it('refuses a token minted for a different user', () => {
      const svc = makeService();
      const { devToken } = svc.elevate('user-1');
      // The stolen-token case: a valid elevation replayed on another session.
      expect(svc.isElevated(reqFor('user-2', devToken))).toBe(false);
    });

    it('refuses a token signed with the access-token secret', () => {
      const svc = makeService();
      const forged = new JwtService({}).sign(
        { sub: 'user-1', dev: true, jti: 'made-up' },
        { secret: 'the-jwt-secret', expiresIn: '20m' },
      );
      expect(svc.isElevated(reqFor('user-1', forged))).toBe(false);
    });

    it('refuses a well-formed token whose jti was never issued', () => {
      const svc = makeService();
      const unissued = new JwtService({}).sign(
        { sub: 'user-1', dev: true, jti: 'never-minted' },
        { secret: TOKEN_SECRET, expiresIn: '20m' },
      );
      expect(svc.isElevated(reqFor('user-1', unissued))).toBe(false);
    });

    it('refuses a token once its TTL has run out', () => {
      jest.useFakeTimers();
      try {
        const svc = makeService({ DEV_MODE_TTL_MINUTES: '1' });
        const { devToken } = svc.elevate('user-1');
        expect(svc.isElevated(reqFor('user-1', devToken))).toBe(true);

        jest.advanceTimersByTime(61_000);
        expect(svc.isElevated(reqFor('user-1', devToken))).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('refuses a non-ADMIN even with a valid token', () => {
      const svc = makeService();
      const { devToken } = svc.elevate('user-1');
      expect(svc.isElevated(reqFor('user-1', devToken, 'HR_MANAGER'))).toBe(false);
    });

    it('refuses when no token is presented', () => {
      const svc = makeService();
      svc.elevate('user-1');
      expect(svc.isElevated(reqFor('user-1'))).toBe(false);
    });

    it('reports the expiry so the UI can count down', () => {
      const svc = makeService();
      const { devToken, expiresAt } = svc.elevate('user-1');
      expect(svc.elevationFor(reqFor('user-1', devToken))?.expiresAt).toBe(expiresAt);
    });
  });

  describe('revocation', () => {
    it('revoke() drops the elevation immediately', () => {
      const svc = makeService();
      const { devToken } = svc.elevate('user-1');
      svc.revoke(devToken);
      expect(svc.isElevated(reqFor('user-1', devToken))).toBe(false);
    });

    it('revokeAllForUser() drops every session for that user only', () => {
      const svc = makeService();
      const a = svc.elevate('user-1');
      const b = svc.elevate('user-1');
      const other = svc.elevate('user-2');

      expect(svc.revokeAllForUser('user-1')).toBe(2);
      expect(svc.isElevated(reqFor('user-1', a.devToken))).toBe(false);
      expect(svc.isElevated(reqFor('user-1', b.devToken))).toBe(false);
      expect(svc.isElevated(reqFor('user-2', other.devToken))).toBe(true);
    });
  });

  describe('rollout switch', () => {
    it('is off by default so the feature ships inert', () => {
      expect(makeService({ DEV_MODE_ENFORCED: undefined }).isEnforced()).toBe(false);
    });

    it('reads true only from the literal string', () => {
      expect(makeService({ DEV_MODE_ENFORCED: 'true' }).isEnforced()).toBe(true);
      expect(makeService({ DEV_MODE_ENFORCED: 'yes' }).isEnforced()).toBe(false);
    });
  });

  describe('ttl', () => {
    it('falls back to the default when unset or nonsense', () => {
      expect(makeService({ DEV_MODE_TTL_MINUTES: undefined }).ttlMinutes()).toBe(20);
      expect(makeService({ DEV_MODE_TTL_MINUTES: 'abc' }).ttlMinutes()).toBe(20);
      expect(makeService({ DEV_MODE_TTL_MINUTES: '-5' }).ttlMinutes()).toBe(20);
    });
  });
});
