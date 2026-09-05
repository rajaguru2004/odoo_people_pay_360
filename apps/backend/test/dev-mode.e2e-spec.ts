import * as bcrypt from 'bcrypt';

const DEV_PASSWORD = 'dev-mode-e2e-password';

const DEV_ENV_KEYS = [
  'DEV_MODE_PASSWORD_HASH',
  'DEV_MODE_TOKEN_SECRET',
  'DEV_MODE_TTL_MINUTES',
  'DEV_MODE_ENFORCED',
] as const;

/**
 * Captured so afterAll can put them back. The e2e config runs maxWorkers: 1, so
 * every spec file shares one process: leaving DEV_MODE_ENFORCED=true behind
 * would make the profile-template and settings suites that run after this one
 * start getting 403s from a gate they never asked for.
 */
const ORIGINAL_DEV_ENV = Object.fromEntries(DEV_ENV_KEYS.map((k) => [k, process.env[k]]));

// Must be set BEFORE the app boots: ConfigModule snapshots process.env at load.
process.env.DEV_MODE_PASSWORD_HASH = bcrypt.hashSync(DEV_PASSWORD, 4);
process.env.DEV_MODE_TOKEN_SECRET = 'dev-mode-e2e-token-secret';
process.env.DEV_MODE_TTL_MINUTES = '20';
process.env.DEV_MODE_ENFORCED = 'true';

import { bootE2EApp, E2EContext } from './utils/e2e-app';
import { Fixtures, setupFixtures } from './utils/fixtures';
import { withSetting, withSettings } from './utils/settings';

/**
 * Developer mode, over the real request pipeline.
 *
 * The point of this suite is the pair of assertions on every gated surface: an
 * ADMIN alone is refused, and the SAME admin with an elevation token is allowed.
 * A test that only checks the refusal would still pass if the gate were welded
 * shut, which would be a different bug and just as bad.
 */
describe('Developer mode (e2e)', () => {
  let ctx: E2EContext;
  let fx: Fixtures;
  let adminToken: string;
  let devToken: string;

  const auth = (path: string) => ctx.http().get(path).set('Authorization', `Bearer ${adminToken}`);
  const authDev = (path: string) => auth(path).set('X-Dev-Token', devToken);

  beforeAll(async () => {
    ctx = await bootE2EApp();
    fx = await setupFixtures(ctx);
    adminToken = fx.globalAdmin.token;

    const res = await ctx
      .http()
      .post('/dev-mode/elevate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: DEV_PASSWORD });
    devToken = res.body?.data?.devToken;
  });

  afterAll(async () => {
    await fx?.cleanup();
    await ctx?.app.close();

    for (const key of DEV_ENV_KEYS) {
      const original = ORIGINAL_DEV_ENV[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  describe('elevation', () => {
    it('issues a token for the right password', () => {
      expect(devToken).toEqual(expect.any(String));
    });

    it('refuses the wrong password with 401', async () => {
      await ctx
        .http()
        .post('/dev-mode/elevate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ password: 'wrong' })
        .expect(401);
    });

    it('is not reachable by a non-ADMIN at all', async () => {
      await ctx
        .http()
        .post('/dev-mode/elevate')
        .set('Authorization', `Bearer ${fx.scopedHr.token}`)
        .send({ password: DEV_PASSWORD })
        .expect(403);
    });

    it('reports the elevation back on /status', async () => {
      const res = await authDev('/dev-mode/status').expect(200);
      expect(res.body.data).toMatchObject({ available: true, enforced: true, elevated: true });
    });

    it('does not consider a plain admin elevated', async () => {
      const res = await auth('/dev-mode/status').expect(200);
      expect(res.body.data.elevated).toBe(false);
    });
  });

  describe('gated surfaces refuse a plain ADMIN and admit an elevated one', () => {
    // Only surfaces this e2e slice actually mounts. WhatsAppInboundModule
    // (/whatsapp/actions) and SampleDataModule are not in TestAppModule, so they
    // would 404 here regardless of the gate — asserting on them would test the
    // slice, not the feature. Their controllers carry the same class-level
    // @RequireDeveloper(), covered by dev-mode.guard.spec.ts.
    const GATED = [
      '/copilot-settings',
      '/whatsapp/settings',
      '/attendance-integrations',
      '/wps/employer-profiles',
    ];

    it.each(GATED)('%s → 403 for ADMIN, 2xx once elevated', async (path) => {
      await auth(path).expect(403);

      const allowed = await authDev(path);
      expect(allowed.status).toBeLessThan(400);
    });
  });

  describe('carve-outs stay reachable — these must NOT be gated', () => {
    it('the employee profile form still resolves for a plain EMPLOYEE', async () => {
      // Gating this would blank the profile page for the whole tenant.
      await ctx
        .http()
        .get('/profile-templates/active')
        .set('Authorization', `Bearer ${fx.plainEmployee.token}`)
        .expect(200);
    });

    it('WPS payroll operations still work for HR without elevation', async () => {
      await ctx
        .http()
        .get('/wps/formats')
        .set('Authorization', `Bearer ${fx.scopedHr.token}`)
        .expect(200);
    });

    it('the unauthenticated public settings projection is untouched', async () => {
      const res = await ctx.http().get('/system-settings/public').expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('mail_');
    });

    it('the System Settings tab still loads for a plain ADMIN', async () => {
      await auth('/system-settings').expect(200);
    });
  });

  describe('system-settings key-level gate', () => {
    it('strips developer keys from the dump for a plain ADMIN', async () => {
      const res = await auth('/system-settings').expect(200);
      const keys = res.body.data.map((r: any) => r.key);
      expect(keys.filter((k: string) => k.startsWith('mail_'))).toHaveLength(0);
      expect(keys).toContain('company_name'); // tenant keys still there
    });

    it('returns the developer keys once elevated', async () => {
      const res = await authDev('/system-settings').expect(200);
      const keys = res.body.data.map((r: any) => r.key);
      expect(keys).toContain('mail_host');
    });

    // A settings save once wrote EMPTY strings over all eight mail_* rows of a
    // live tenant. The transporter kept sending — it reads every key as
    // `stored || env` — but the settings dump resolved with `??`, which falls
    // through only when the ROW IS ABSENT, so the SMTP form rendered blank over
    // a working server and reported "not configured" about it. An empty row now
    // resolves exactly the way an absent one does.
    it('an elevated read reports the effective SMTP config over blanked rows', async () => {
      await withSettings(
        ctx,
        { mail_host: '', mail_port: '', mail_from_name: '' },
        async () => {
          const res = await authDev('/system-settings').expect(200);
          const val = (k: string) =>
            res.body.data.find((r: any) => r.key === k)?.value;
          expect(val('mail_host')).toBe(process.env.MAIL_HOST || 'smtp.gmail.com');
          expect(val('mail_port')).toBe(process.env.MAIL_PORT || '587');
          expect(val('mail_from_name')).toBe(
            process.env.MAIL_FROM_NAME || 'HR System',
          );
        },
      );
    });

    it('a stored SMTP host still wins over the environment', async () => {
      await withSetting(ctx, 'mail_host', 'smtp.stored.test', async () => {
        const res = await authDev('/system-settings').expect(200);
        expect(
          res.body.data.find((r: any) => r.key === 'mail_host')?.value,
        ).toBe('smtp.stored.test');
      });
    });

    it('refuses a write that touches a developer key', async () => {
      await ctx
        .http()
        .post('/system-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ settings: { mail_host: 'evil.example.com' } })
        .expect(403);
    });

    it('still allows an ordinary settings write', async () => {
      await ctx
        .http()
        .post('/system-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ settings: { company_subtitle: 'still writable' } })
        .expect(201);
    });

    it('refuses a mixed payload outright rather than half-applying it', async () => {
      await ctx
        .http()
        .post('/system-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ settings: { company_subtitle: 'x', mail_host: 'evil.example.com' } })
        .expect(403);
    });
  });

  describe('revocation', () => {
    it('a revoked token stops working immediately', async () => {
      const minted = (
        await ctx
          .http()
          .post('/dev-mode/elevate')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ password: DEV_PASSWORD })
      ).body.data.devToken;

      await ctx
        .http()
        .get('/copilot-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Dev-Token', minted)
        .expect(200);

      await ctx
        .http()
        .post('/dev-mode/revoke')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Dev-Token', minted)
        .expect(201);

      await ctx
        .http()
        .get('/copilot-settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Dev-Token', minted)
        .expect(403);
    });
  });
});
