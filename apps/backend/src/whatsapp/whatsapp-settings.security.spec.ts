import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { encryptSecret, isEncryptedSecret } from '../common/crypto/secret-crypto';
import { SETTING_KEYS } from './whatsapp.types';
import { isProtectedSettingKey } from '../system-settings/protected-setting-keys';

/**
 * Pins the hard requirement: the Evolution API key must never appear in any API
 * response.
 *
 * There are four independent layers (types, a dedicated ADMIN controller outside
 * the settings catalogue, the PROTECTED_SETTING_KEYS denylist, and the
 * getAllSettings filter). This file covers the two that are pure logic; the
 * HTTP-level assertions live in test/whatsapp.e2e-spec.ts.
 */
const PLAINTEXT_KEY = 'super-secret-evolution-key-12345';

function makeService(rows: Array<{ key: string; value: string }>) {
  const prisma: any = {
    systemSetting: {
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { svc: new WhatsAppSettingsService(prisma), prisma };
}

describe('WhatsApp settings — secret handling', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getPublic() never carries the key', () => {
    it('omits both the plaintext and the ciphertext', async () => {
      const ciphertext = encryptSecret(PLAINTEXT_KEY);
      const { svc } = makeService([
        { key: SETTING_KEYS.apiKeyEnc, value: ciphertext },
        { key: SETTING_KEYS.baseUrl, value: 'https://wa.example.com' },
      ]);

      const serialised = JSON.stringify(await svc.getPublic());

      expect(serialised).not.toContain(PLAINTEXT_KEY);
      expect(serialised).not.toContain(ciphertext);
      // 'v1:' is the encrypted-payload prefix; its presence would mean a
      // ciphertext leaked into the projection.
      expect(serialised).not.toContain('v1:');
      expect(serialised).not.toContain('apiKey"');
    });

    it('reports configured state and a masked hint instead', async () => {
      const { svc } = makeService([
        { key: SETTING_KEYS.apiKeyEnc, value: encryptSecret(PLAINTEXT_KEY) },
      ]);
      const pub = await svc.getPublic();

      expect(pub.apiKeyConfigured).toBe(true);
      expect(pub.apiKeySource).toBe('db');
      expect(pub.apiKeyMasked).toBe('••••2345');
      expect((pub as any).apiKey).toBeUndefined();
    });

    it('reports "none" when no key is set anywhere', async () => {
      delete process.env.WHATSAPP_API_KEY;
      const { svc } = makeService([]);
      const pub = await svc.getPublic();

      expect(pub.apiKeyConfigured).toBe(false);
      expect(pub.apiKeySource).toBe('none');
      expect(pub.apiKeyMasked).toBe('');
    });

    it('does not leak an env-sourced key either', async () => {
      process.env.WHATSAPP_API_KEY = PLAINTEXT_KEY;
      const { svc } = makeService([]);
      const pub = await svc.getPublic();

      expect(pub.apiKeySource).toBe('env');
      expect(JSON.stringify(pub)).not.toContain(PLAINTEXT_KEY);
    });
  });

  describe('resolution order', () => {
    it('prefers the encrypted DB value over the environment', async () => {
      process.env.WHATSAPP_API_KEY = 'from-env';
      const { svc } = makeService([
        { key: SETTING_KEYS.apiKeyEnc, value: encryptSecret('from-db') },
      ]);
      const cfg = await svc.get();

      expect(cfg.apiKey).toBe('from-db');
      expect(cfg.apiKeySource).toBe('db');
    });

    it('falls back to the environment when the stored ciphertext is corrupt', async () => {
      // A malformed row must degrade, not brick the channel.
      process.env.WHATSAPP_API_KEY = 'from-env';
      const { svc } = makeService([{ key: SETTING_KEYS.apiKeyEnc, value: 'not-a-ciphertext' }]);
      const cfg = await svc.get();

      expect(cfg.apiKey).toBe('from-env');
      expect(cfg.apiKeySource).toBe('env');
    });
  });

  describe('write path — encrypt on write, keep on omit, delete on clear', () => {
    it('stores the key encrypted, never as plaintext', async () => {
      const { svc, prisma } = makeService([]);
      await svc.update({ apiKey: PLAINTEXT_KEY });

      const write = prisma.systemSetting.upsert.mock.calls.find(
        (c: any[]) => c[0].where.key === SETTING_KEYS.apiKeyEnc,
      )[0];
      expect(write.create.value).not.toBe(PLAINTEXT_KEY);
      expect(isEncryptedSecret(write.create.value)).toBe(true);
    });

    it('leaves the stored key alone when the field is omitted', async () => {
      const { svc, prisma } = makeService([]);
      await svc.update({ baseUrl: 'https://wa.example.com' });

      const touched = prisma.systemSetting.upsert.mock.calls.some(
        (c: any[]) => c[0].where.key === SETTING_KEYS.apiKeyEnc,
      );
      expect(touched).toBe(false);
      expect(prisma.systemSetting.deleteMany).not.toHaveBeenCalled();
    });

    it('deletes the row on an explicit clear', async () => {
      const { svc, prisma } = makeService([]);
      await svc.update({ clearApiKey: true });

      expect(prisma.systemSetting.deleteMany).toHaveBeenCalledWith({
        where: { key: SETTING_KEYS.apiKeyEnc },
      });
    });

    it('ignores a blank key rather than storing an empty secret', async () => {
      const { svc, prisma } = makeService([]);
      await svc.update({ apiKey: '   ' });

      const touched = prisma.systemSetting.upsert.mock.calls.some(
        (c: any[]) => c[0].where.key === SETTING_KEYS.apiKeyEnc,
      );
      expect(touched).toBe(false);
    });
  });

  describe('ensureConfigured gate', () => {
    const full = [
      { key: SETTING_KEYS.enabled, value: 'true' },
      { key: SETTING_KEYS.baseUrl, value: 'https://wa.example.com' },
      { key: SETTING_KEYS.instanceName, value: 'inst' },
      { key: SETTING_KEYS.apiKeyEnc, value: encryptSecret(PLAINTEXT_KEY) },
    ];

    it('returns the config only when enabled and complete', async () => {
      const { svc } = makeService(full);
      await expect(svc.ensureConfigured()).resolves.toMatchObject({ instanceName: 'inst' });
    });

    it('returns null when the kill switch is off', async () => {
      const { svc } = makeService(
        full.map((r) => (r.key === SETTING_KEYS.enabled ? { ...r, value: 'false' } : r)),
      );
      await expect(svc.ensureConfigured()).resolves.toBeNull();
    });

    it('defaults to off when the switch was never set', async () => {
      delete process.env.WHATSAPP_ENABLED;
      const { svc } = makeService(full.filter((r) => r.key !== SETTING_KEYS.enabled));
      await expect(svc.ensureConfigured()).resolves.toBeNull();
    });

    it.each([SETTING_KEYS.baseUrl, SETTING_KEYS.instanceName, SETTING_KEYS.apiKeyEnc])(
      'returns null when %s is missing',
      async (missing) => {
        delete process.env.WHATSAPP_API_KEY;
        delete process.env.WHATSAPP_BASE_URL;
        delete process.env.WHATSAPP_INSTANCE_NAME;
        const { svc } = makeService(full.filter((r) => r.key !== missing));
        await expect(svc.ensureConfigured()).resolves.toBeNull();
      },
    );
  });

  describe('per-update switches', () => {
    it('defaults to nothing switched off', async () => {
      const { svc } = makeService([]);
      await expect(svc.get()).resolves.toMatchObject({ disabledTemplates: [] });
    });

    it('parses the stored list', async () => {
      const { svc } = makeService([
        { key: SETTING_KEYS.disabledTemplates, value: 'leave_approved, payslip_ready' },
      ]);
      const cfg = await svc.get();
      expect(cfg.disabledTemplates).toEqual(['leave_approved', 'payslip_ready']);
    });

    it('drops keys that are not real templates', async () => {
      // Stops a stale key from an older deployment lingering in the admin list.
      const { svc, prisma } = makeService([]);
      await svc.update({ disabledTemplates: ['leave_approved', 'not_a_template', ''] });

      const write = prisma.systemSetting.upsert.mock.calls.find(
        (c: any[]) => c[0].where.key === SETTING_KEYS.disabledTemplates,
      )[0];
      expect(write.create.value).toBe('leave_approved');
    });

    it('de-duplicates', async () => {
      const { svc, prisma } = makeService([]);
      await svc.update({ disabledTemplates: ['payslip_ready', 'payslip_ready'] });

      const write = prisma.systemSetting.upsert.mock.calls.find(
        (c: any[]) => c[0].where.key === SETTING_KEYS.disabledTemplates,
      )[0];
      expect(write.create.value).toBe('payslip_ready');
    });

    it('an empty array switches everything back on', async () => {
      const { svc, prisma } = makeService([
        { key: SETTING_KEYS.disabledTemplates, value: 'leave_approved' },
      ]);
      await svc.update({ disabledTemplates: [] });

      const write = prisma.systemSetting.upsert.mock.calls.find(
        (c: any[]) => c[0].where.key === SETTING_KEYS.disabledTemplates,
      )[0];
      expect(write.create.value).toBe('');
    });

    it('leaves the list untouched when the field is omitted', async () => {
      const { svc, prisma } = makeService([]);
      await svc.update({ baseUrl: 'https://wa.example.com' });

      const touched = prisma.systemSetting.upsert.mock.calls.some(
        (c: any[]) => c[0].where.key === SETTING_KEYS.disabledTemplates,
      );
      expect(touched).toBe(false);
    });
  });

  describe('test mode (redirect all messages to one number)', () => {
    const live = [
      { key: SETTING_KEYS.enabled, value: 'true' },
      { key: SETTING_KEYS.baseUrl, value: 'https://wa.example.com' },
      { key: SETTING_KEYS.instanceName, value: 'inst' },
      { key: SETTING_KEYS.apiKeyEnc, value: encryptSecret(PLAINTEXT_KEY) },
    ];

    beforeEach(() => {
      delete process.env.WHATSAPP_REDIRECT_ALL_TO;
    });

    it('is off by default', async () => {
      const { svc } = makeService([]);
      await expect(svc.get()).resolves.toMatchObject({
        redirectAllTo: '',
        redirectMisconfigured: false,
      });
    });

    it('accepts a full international number', async () => {
      const { svc } = makeService([
        { key: SETTING_KEYS.redirectAllTo, value: '+91 99529 82836' },
      ]);
      await expect(svc.get()).resolves.toMatchObject({ redirectAllTo: '+919952982836' });
    });

    it('accepts a national number when a default country is set', async () => {
      const { svc } = makeService([
        { key: SETTING_KEYS.defaultRegion, value: 'IN' },
        { key: SETTING_KEYS.redirectAllTo, value: '9952982836' },
      ]);
      await expect(svc.get()).resolves.toMatchObject({ redirectAllTo: '+919952982836' });
    });

    it('reads from the environment', async () => {
      process.env.WHATSAPP_REDIRECT_ALL_TO = '+919952982836';
      const { svc } = makeService([]);
      await expect(svc.get()).resolves.toMatchObject({ redirectAllTo: '+919952982836' });
    });

    it('lets the stored value override the environment', async () => {
      process.env.WHATSAPP_REDIRECT_ALL_TO = '+919952982836';
      const { svc } = makeService([
        { key: SETTING_KEYS.redirectAllTo, value: '+96890010000' },
      ]);
      await expect(svc.get()).resolves.toMatchObject({ redirectAllTo: '+96890010000' });
    });

    it('an explicit clear beats a leftover environment variable', async () => {
      // Otherwise an admin clears the field, sees test mode still on, and cannot
      // tell whether staff are being messaged. The empty row is the decision.
      process.env.WHATSAPP_REDIRECT_ALL_TO = '+919952982836';
      const { svc } = makeService([{ key: SETTING_KEYS.redirectAllTo, value: '' }]);
      await expect(svc.get()).resolves.toMatchObject({
        redirectAllTo: '',
        redirectMisconfigured: false,
      });
    });

    it('saving an empty value writes the row rather than skipping it', async () => {
      const { svc, prisma } = makeService([]);
      await svc.update({ redirectAllTo: '' });

      const write = prisma.systemSetting.upsert.mock.calls.find(
        (c: any[]) => c[0].where.key === SETTING_KEYS.redirectAllTo,
      );
      expect(write).toBeDefined();
      expect(write[0].create.value).toBe('');
    });

    describe('fail-closed on a bad value', () => {
      it('flags a number it cannot read', async () => {
        const { svc } = makeService([{ key: SETTING_KEYS.redirectAllTo, value: 'not-a-number' }]);
        const cfg = await svc.get();
        expect(cfg.redirectAllTo).toBe('');
        expect(cfg.redirectMisconfigured).toBe(true);
      });

      it('flags a national number with no default country', async () => {
        // Exactly the "9952982836" case with no region — guessing here could
        // dial a stranger.
        const { svc } = makeService([{ key: SETTING_KEYS.redirectAllTo, value: '9952982836' }]);
        await expect(svc.get()).resolves.toMatchObject({ redirectMisconfigured: true });
      });

      it('STOPS sending rather than falling back to real employees', async () => {
        // The whole point: a typo in the catcher must never become a live send.
        const { svc } = makeService([
          ...live,
          { key: SETTING_KEYS.redirectAllTo, value: 'oops' },
        ]);
        await expect(svc.ensureConfigured()).resolves.toBeNull();
      });

      it('leaves diagnostics working so the admin can fix it', async () => {
        const { svc } = makeService([
          ...live,
          { key: SETTING_KEYS.redirectAllTo, value: 'oops' },
        ]);
        await expect(svc.ensureCredentials()).resolves.not.toBeNull();
      });
    });

    it('does not block sending when the value is good', async () => {
      const { svc } = makeService([
        ...live,
        { key: SETTING_KEYS.redirectAllTo, value: '+919952982836' },
      ]);
      await expect(svc.ensureConfigured()).resolves.toMatchObject({
        redirectAllTo: '+919952982836',
      });
    });

    it('is visible in the admin projection', async () => {
      const { svc } = makeService([
        { key: SETTING_KEYS.redirectAllTo, value: '+919952982836' },
      ]);
      const pub = await svc.getPublic();
      expect(pub.redirectAllTo).toBe('+919952982836');
    });

    /**
     * The production outage of 2026-08-12.
     *
     * '917603941558' was saved against a Singapore default region. It cannot be
     * parsed, so `redirectAllTo` became '' — and because the admin page binds to
     * that, the field rendered EMPTY while the banner told the reader to clear
     * it. The channel was down for 19 days with no reachable way to fix it from
     * the product. Two independent guards below, because either alone would
     * have prevented it.
     */
    describe('an unreadable value must stay fixable from the UI', () => {
      const BAD = '917603941558';

      it('keeps the raw value so the admin can see what to correct', async () => {
        const { svc } = makeService([
          { key: SETTING_KEYS.defaultRegion, value: 'SG' },
          { key: SETTING_KEYS.redirectAllTo, value: BAD },
        ]);
        const cfg = await svc.get();

        expect(cfg.redirectMisconfigured).toBe(true);
        expect(cfg.redirectAllTo).toBe('');
        // Without this the settings page has nothing to render, and the state
        // is undiagnosable from the product.
        expect(cfg.redirectAllToRaw).toBe(BAD);
      });

      it('carries the raw value through the admin projection', async () => {
        const { svc } = makeService([
          { key: SETTING_KEYS.defaultRegion, value: 'SG' },
          { key: SETTING_KEYS.redirectAllTo, value: BAD },
        ]);
        await expect(svc.getPublic()).resolves.toMatchObject({
          redirectAllTo: '',
          redirectMisconfigured: true,
          redirectAllToRaw: BAD,
        });
      });

      it('reports no raw value when the field is simply off', async () => {
        const { svc } = makeService([]);
        await expect(svc.get()).resolves.toMatchObject({ redirectAllToRaw: '' });
      });
    });

    describe('write-time validation — the state must not be creatable', () => {
      const BAD = '917603941558';

      it('refuses to store a number it will not be able to read back', async () => {
        const { svc, prisma } = makeService([{ key: SETTING_KEYS.defaultRegion, value: 'SG' }]);

        await expect(svc.update({ redirectAllTo: BAD })).rejects.toThrow(
          /not a valid test recipient/i,
        );

        // Nothing at all may be written: a partially applied save would leave
        // the admin guessing which of their edits took.
        expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
      });

      it('names the number and the country it was judged against', async () => {
        const { svc } = makeService([{ key: SETTING_KEYS.defaultRegion, value: 'SG' }]);
        await expect(svc.update({ redirectAllTo: BAD })).rejects.toThrow(
          new RegExp(`${BAD}[\\s\\S]*SG`),
        );
      });

      it('stores the normalised E.164, not what was typed', async () => {
        // Read and write must not disagree about what was saved.
        const { svc, prisma } = makeService([{ key: SETTING_KEYS.defaultRegion, value: 'IN' }]);
        await svc.update({ redirectAllTo: ' 99529 82836 ' });

        const write = prisma.systemSetting.upsert.mock.calls.find(
          (c: any[]) => c[0].where.key === SETTING_KEYS.redirectAllTo,
        );
        expect(write[0].create.value).toBe('+919952982836');
      });

      it('judges the number against the country saved in the SAME request', async () => {
        // An admin fixing both the country and the number in one save must not
        // be refused on the country they are in the middle of replacing.
        const { svc, prisma } = makeService([{ key: SETTING_KEYS.defaultRegion, value: 'SG' }]);
        await svc.update({ defaultRegion: 'in', redirectAllTo: '9952982836' });

        const write = prisma.systemSetting.upsert.mock.calls.find(
          (c: any[]) => c[0].where.key === SETTING_KEYS.redirectAllTo,
        );
        expect(write[0].create.value).toBe('+919952982836');
      });

      it('still allows clearing, which is how the outage is ended', async () => {
        const { svc, prisma } = makeService([
          { key: SETTING_KEYS.defaultRegion, value: 'SG' },
          { key: SETTING_KEYS.redirectAllTo, value: BAD },
        ]);
        await expect(svc.update({ redirectAllTo: '' })).resolves.toBeDefined();

        const write = prisma.systemSetting.upsert.mock.calls.find(
          (c: any[]) => c[0].where.key === SETTING_KEYS.redirectAllTo,
        );
        expect(write[0].create.value).toBe('');
      });

      it('leaves the key untouched when the field is not part of the save', async () => {
        const { svc, prisma } = makeService([
          { key: SETTING_KEYS.defaultRegion, value: 'SG' },
          { key: SETTING_KEYS.redirectAllTo, value: BAD },
        ]);
        await svc.update({ enabled: true });

        const write = prisma.systemSetting.upsert.mock.calls.find(
          (c: any[]) => c[0].where.key === SETTING_KEYS.redirectAllTo,
        );
        expect(write).toBeUndefined();
      });
    });
  });

  /**
   * The watcher copy. Two properties matter more than the rest: it must NOT be
   * able to halt sending (unlike the redirect it fails open), and it must never
   * be confused with test mode, which takes delivery away from employees.
   */
  describe('carbon copy', () => {
    const live = [
      { key: SETTING_KEYS.enabled, value: 'true' },
      { key: SETTING_KEYS.baseUrl, value: 'https://wa.example.com' },
      { key: SETTING_KEYS.instanceName, value: 'inst' },
      { key: SETTING_KEYS.apiKeyEnc, value: encryptSecret(PLAINTEXT_KEY) },
    ];

    beforeEach(() => {
      delete process.env.WHATSAPP_CARBON_COPY_TO;
      delete process.env.WHATSAPP_CARBON_COPY_ENABLED;
    });

    it('ships on, with a default watcher number', async () => {
      const { svc } = makeService([]);
      await expect(svc.get()).resolves.toMatchObject({
        carbonCopyEnabled: true,
        carbonCopyTo: '+917603941558',
        carbonCopyMisconfigured: false,
      });
    });

    it('an admin can switch it off', async () => {
      const { svc } = makeService([{ key: SETTING_KEYS.carbonCopyEnabled, value: 'false' }]);
      await expect(svc.get()).resolves.toMatchObject({ carbonCopyEnabled: false });
    });

    it('an explicitly cleared number beats the built-in default', async () => {
      // Same rule as the redirect: the empty row IS the decision, or an admin
      // who clears the field finds copies still going out.
      const { svc } = makeService([{ key: SETTING_KEYS.carbonCopyTo, value: '' }]);
      await expect(svc.get()).resolves.toMatchObject({ carbonCopyTo: '' });
    });

    it('accepts a national number against the default country', async () => {
      const { svc } = makeService([
        { key: SETTING_KEYS.defaultRegion, value: 'IN' },
        { key: SETTING_KEYS.carbonCopyTo, value: '9952982836' },
      ]);
      await expect(svc.get()).resolves.toMatchObject({ carbonCopyTo: '+919952982836' });
    });

    it('FAILS OPEN on a number it cannot read — employees keep their messages', async () => {
      // The opposite of the redirect on purpose. A bad watcher number costs a
      // copy; halting the channel over it would turn a debug aid into an outage.
      const { svc } = makeService([
        ...live,
        { key: SETTING_KEYS.defaultRegion, value: 'SG' },
        { key: SETTING_KEYS.carbonCopyTo, value: '917603941558' },
      ]);
      const cfg = await svc.get();

      expect(cfg.carbonCopyMisconfigured).toBe(true);
      expect(cfg.carbonCopyTo).toBe('');
      expect(cfg.carbonCopyToRaw).toBe('917603941558');
      expect(cfg.redirectMisconfigured).toBe(false);
      await expect(svc.ensureConfigured()).resolves.not.toBeNull();
    });

    it('refuses to store a number it will not be able to read back', async () => {
      const { svc, prisma } = makeService([{ key: SETTING_KEYS.defaultRegion, value: 'SG' }]);
      await expect(svc.update({ carbonCopyTo: '917603941558' })).rejects.toThrow(
        /not a valid carbon-copy number/i,
      );
      expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
    });

    it('stores the normalised E.164', async () => {
      const { svc, prisma } = makeService([{ key: SETTING_KEYS.defaultRegion, value: 'IN' }]);
      await svc.update({ carbonCopyTo: ' 99529 82836 ' });

      const write = prisma.systemSetting.upsert.mock.calls.find(
        (c: any[]) => c[0].where.key === SETTING_KEYS.carbonCopyTo,
      );
      expect(write[0].create.value).toBe('+919952982836');
    });

    it('persists the switch', async () => {
      const { svc, prisma } = makeService([]);
      await svc.update({ carbonCopyEnabled: false });

      const write = prisma.systemSetting.upsert.mock.calls.find(
        (c: any[]) => c[0].where.key === SETTING_KEYS.carbonCopyEnabled,
      );
      expect(write[0].create.value).toBe('false');
    });

    it('is visible in the admin projection', async () => {
      const { svc } = makeService([]);
      await expect(svc.getPublic()).resolves.toMatchObject({
        carbonCopyEnabled: true,
        carbonCopyTo: '+917603941558',
      });
    });
  });

  describe('ensureCredentials gate — diagnostics must not depend on the kill switch', () => {
    const creds = [
      { key: SETTING_KEYS.baseUrl, value: 'https://wa.example.com' },
      { key: SETTING_KEYS.instanceName, value: 'inst' },
      { key: SETTING_KEYS.apiKeyEnc, value: encryptSecret(PLAINTEXT_KEY) },
    ];

    it('resolves with valid credentials even while sending is disabled', async () => {
      // The regression this pins: gating connection state / QR / number
      // verification on `enabled` made a correctly configured, connected
      // instance report "Not configured" in the admin UI.
      const { svc } = makeService([...creds, { key: SETTING_KEYS.enabled, value: 'false' }]);

      await expect(svc.ensureConfigured()).resolves.toBeNull();
      await expect(svc.ensureCredentials()).resolves.toMatchObject({
        instanceName: 'inst',
        enabled: false,
      });
    });

    it('still returns null when credentials are incomplete', async () => {
      delete process.env.WHATSAPP_API_KEY;
      delete process.env.WHATSAPP_BASE_URL;
      delete process.env.WHATSAPP_INSTANCE_NAME;
      const { svc } = makeService([
        { key: SETTING_KEYS.enabled, value: 'true' },
        { key: SETTING_KEYS.baseUrl, value: 'https://wa.example.com' },
      ]);
      await expect(svc.ensureCredentials()).resolves.toBeNull();
    });

    it('agrees with ensureConfigured once sending is on', async () => {
      const { svc } = makeService([...creds, { key: SETTING_KEYS.enabled, value: 'true' }]);
      const [a, b] = await Promise.all([svc.ensureConfigured(), svc.ensureCredentials()]);
      expect(a).toEqual(b);
    });
  });
});

describe('PROTECTED_SETTING_KEYS', () => {
  it.each([
    'whatsapp.apiKeyEnc',
    'whatsapp.adminNumber',
    'copilot.llmApiKeyEnc',
    'some.futureKeyEnc',
    'vendor_auth_secret',
    'vendor_apikey',
    'vendor_api_key',
  ])('protects %s', (key) => {
    expect(isProtectedSettingKey(key)).toBe(true);
  });

  it.each(['company_name', 'whatsapp.enabled', 'whatsapp.baseUrl', 'payroll_country'])(
    'leaves %s writable',
    (key) => {
      expect(isProtectedSettingKey(key)).toBe(false);
    },
  );
});
