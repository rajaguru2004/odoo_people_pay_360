import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { WhatsAppAdminService } from './whatsapp-admin.service';
import {
  buildWebhookUrl,
  WHATSAPP_WEBHOOK_EVENTS,
  WHATSAPP_WEBHOOK_HEADER,
  WHATSAPP_WEBHOOK_PATH,
} from './whatsapp.types';

/**
 * The inbound callback address the admin has to give the WhatsApp service.
 *
 * Everything here guards one failure mode: a webhook that LOOKS configured and
 * silently receives nothing. It has three causes, and each has a test —
 * the address is built from the portal host instead of the API host, the
 * service is pointed somewhere else and nobody notices, or the secret is
 * rotated without the service being told.
 */
describe('WhatsApp webhook configuration', () => {
  const CFG = {
    enabled: true,
    baseUrl: 'https://wa.example.com',
    instanceName: 'hrms',
    apiKey: 'k',
    appBaseUrl: 'https://portal.example.com',
    publicApiUrl: 'https://api.example.com',
    webhookSecret: 'sekret',
  };

  const build = (over: Record<string, any> = {}, found: any = null, instances?: string[] | null) => {
    const cfg = { ...CFG, ...over };
    const evolution = {
      findWebhook: jest.fn().mockResolvedValue(found),
      setWebhook: jest.fn().mockResolvedValue({ ok: true }),
      listInstanceNames: jest
        .fn()
        .mockResolvedValue(instances === undefined ? [cfg.instanceName] : instances),
    };
    const settings = {
      get: jest.fn().mockResolvedValue(cfg),
      ensureCredentials: jest.fn().mockResolvedValue(cfg.apiKey ? cfg : null),
      getPublic: jest.fn().mockResolvedValue({ webhookSecretConfigured: true }),
      rotateWebhookSecret: jest.fn().mockResolvedValue('rotated-secret'),
    };
    const service = new WhatsAppAdminService(
      {} as any,
      settings as any,
      {} as any,
      {} as any,
      evolution as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return { service, evolution, settings };
  };

  // ─────────────────────────────────────── the constant vs the real route

  /**
   * The address we hand out has to be the address we serve.
   *
   * Nothing else catches a drift here: renaming the controller's route would
   * keep every other test green while the URL in the admin page quietly starts
   * 404ing, which looks exactly like "the provider is not sending anything".
   * Source text rather than Nest's metadata, so the failure names the file a
   * reviewer would open.
   */
  describe('agrees with the controller it documents', () => {
    const controller = readFileSync(
      join(__dirname, 'inbound/whatsapp-webhook.controller.ts'),
      'utf8',
    );

    it('serves exactly WHATSAPP_WEBHOOK_PATH', () => {
      const route = controller.match(/@Controller\('([^']+)'\)/)?.[1];
      expect(route).toBeDefined();
      expect(`/${route}`).toBe(WHATSAPP_WEBHOOK_PATH);
    });

    it('reads the secret from WHATSAPP_WEBHOOK_HEADER', () => {
      // A header mismatch fails closed with a 401 on every callback, which is
      // safe but indistinguishable from a wrong secret.
      const header = controller.match(/@Headers\('([^']+)'\)/)?.[1];
      expect(header).toBe(WHATSAPP_WEBHOOK_HEADER);
    });

    it('has no global prefix in front of it', () => {
      // buildWebhookUrl joins the base straight onto the path; a prefix added
      // in main.ts would silently invalidate every URL this page hands out.
      const main = readFileSync(join(__dirname, '../main.ts'), 'utf8');
      expect(main).not.toMatch(/setGlobalPrefix\(/);
    });
  });

  // ────────────────────────────────────────────────────────────── the URL

  describe('buildWebhookUrl', () => {
    it('appends the route the controller actually serves', () => {
      expect(buildWebhookUrl('https://api.example.com')).toBe(
        `https://api.example.com${WHATSAPP_WEBHOOK_PATH}`,
      );
    });

    it.each([
      'https://api.example.com/',
      'https://api.example.com//',
      '  https://api.example.com  ',
    ])('normalises %p to one clean join', (base) => {
      expect(buildWebhookUrl(base)).toBe(`https://api.example.com${WHATSAPP_WEBHOOK_PATH}`);
    });

    it.each([null, undefined, '', '   '])('returns empty for %p rather than a bare path', (base) => {
      // A bare "/whatsapp/webhook" pasted into the service would be accepted
      // and never resolve to anything.
      expect(buildWebhookUrl(base as any)).toBe('');
    });
  });

  describe('webhookConfig()', () => {
    it('builds the callback from the API address, never the portal address', async () => {
      const { service } = build();
      const res = await service.webhookConfig();
      // The whole reason publicApiUrl exists: the portal host serves the Next.js
      // app, which would answer a POST with a 404 page and lose every message.
      expect(res.webhookUrl).toBe(`https://api.example.com${WHATSAPP_WEBHOOK_PATH}`);
      expect(res.webhookUrl).not.toContain('portal.example.com');
    });

    it('still returns the path and header when no API address is set', async () => {
      // The admin needs the shape of the URL BEFORE anything is configured;
      // withholding it until setup is complete would be circular.
      const { service } = build({ publicApiUrl: '' });
      const res = await service.webhookConfig();
      expect(res.webhookUrl).toBe('');
      expect(res.path).toBe(WHATSAPP_WEBHOOK_PATH);
      expect(res.headerName).toBe(WHATSAPP_WEBHOOK_HEADER);
      expect(res.events).toEqual([...WHATSAPP_WEBHOOK_EVENTS]);
    });

    it('reports the service as unconfigured without calling it', async () => {
      const { service, evolution } = build({ apiKey: '' });
      const res = await service.webhookConfig();
      expect(res.configured).toBe(false);
      expect(evolution.findWebhook).not.toHaveBeenCalled();
    });

    it('confirms a match when the service already posts here', async () => {
      const { service } = build({}, { url: `https://api.example.com${WHATSAPP_WEBHOOK_PATH}`, enabled: true });
      const res = await service.webhookConfig();
      expect(res.matches).toBe(true);
      expect(res.registeredEnabled).toBe(true);
    });

    it.each([
      ['a trailing slash', `https://api.example.com${WHATSAPP_WEBHOOK_PATH}/`],
      ['a capitalised host', `https://API.example.com${WHATSAPP_WEBHOOK_PATH}`],
    ])('still matches despite %s', async (_label, registered) => {
      // Reporting "not wired up" here would send an admin to re-register a
      // webhook that was already correct.
      const { service } = build({}, { url: registered });
      expect((await service.webhookConfig()).matches).toBe(true);
    });

    it('does NOT match a different host', async () => {
      const { service } = build({}, { url: 'https://old.example.com/whatsapp/webhook' });
      const res = await service.webhookConfig();
      expect(res.matches).toBe(false);
      // The wrong address is surfaced, not just a boolean — that is what tells
      // the admin which stale deployment is still holding the instance.
      expect(res.registeredUrl).toBe('https://old.example.com/whatsapp/webhook');
    });

    it('does not match a different path on the right host', async () => {
      const { service } = build({}, { url: 'https://api.example.com/some/other/hook' });
      expect((await service.webhookConfig()).matches).toBe(false);
    });

    it('reads Evolution’s nested webhook shape as well as the flat one', async () => {
      // The provider has returned both across versions.
      const { service } = build(
        {},
        { webhook: { url: `https://api.example.com${WHATSAPP_WEBHOOK_PATH}`, enabled: false } },
      );
      const res = await service.webhookConfig();
      expect(res.matches).toBe(true);
      expect(res.registeredEnabled).toBe(false);
    });

    it('never claims a match when we have no URL of our own', async () => {
      const { service } = build({ publicApiUrl: '' }, { url: '' });
      expect((await service.webhookConfig()).matches).toBe(false);
    });

    it('names the events the service is not subscribed to', async () => {
      // Drawn from a real instance: correct URL, MESSAGES_UPSERT only. Inbound
      // worked, so nobody looked — while delivery receipts and connection drops
      // were never delivered at all.
      const { service } = build(
        {},
        { url: `https://api.example.com${WHATSAPP_WEBHOOK_PATH}`, events: ['MESSAGES_UPSERT'] },
      );
      const res = await service.webhookConfig();
      expect(res.matches).toBe(true);
      expect(res.missingEvents).toEqual([
        'MESSAGES_UPDATE',
        'CONNECTION_UPDATE',
        'QRCODE_UPDATED',
      ]);
    });

    it('reports nothing missing when every event is subscribed', async () => {
      const { service } = build(
        {},
        {
          url: `https://api.example.com${WHATSAPP_WEBHOOK_PATH}`,
          events: [...WHATSAPP_WEBHOOK_EVENTS],
        },
      );
      expect((await service.webhookConfig()).missingEvents).toEqual([]);
    });

    it('compares event names case-insensitively', async () => {
      const { service } = build(
        {},
        {
          url: `https://api.example.com${WHATSAPP_WEBHOOK_PATH}`,
          events: WHATSAPP_WEBHOOK_EVENTS.map((e) => e.toLowerCase()),
        },
      );
      expect((await service.webhookConfig()).missingEvents).toEqual([]);
    });

    it('does not list missing events for somebody else’s webhook', async () => {
      // Noise: the subscription of a webhook pointed elsewhere is not our problem.
      const { service } = build({ publicApiUrl: '' }, null);
      expect((await service.webhookConfig()).missingEvents).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────── registration

  describe('registerWebhook()', () => {
    it('falls back to the configured address when the body is empty', async () => {
      const { service, evolution } = build();
      const res = await service.registerWebhook('', { id: 'u1' });
      expect(evolution.setWebhook.mock.calls[0][1]).toMatchObject({
        url: `https://api.example.com${WHATSAPP_WEBHOOK_PATH}`,
        events: [...WHATSAPP_WEBHOOK_EVENTS],
      });
      expect(res.url).toBe(`https://api.example.com${WHATSAPP_WEBHOOK_PATH}`);
    });

    it('lets an explicit URL win, for a one-off tunnel', async () => {
      const { service, evolution } = build();
      await service.registerWebhook('https://tunnel.example.dev/whatsapp/webhook', {});
      expect(evolution.setWebhook.mock.calls[0][1].url).toBe(
        'https://tunnel.example.dev/whatsapp/webhook',
      );
    });

    it('refuses when there is neither a body nor a configured address', async () => {
      const { service } = build({ publicApiUrl: '' });
      await expect(service.registerWebhook('', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a relative URL', async () => {
      const { service } = build();
      await expect(service.registerWebhook('/whatsapp/webhook', {})).rejects.toThrow(/absolute/i);
    });

    it('returns the rotated secret exactly once, for hand-configured services', async () => {
      // There is no decrypt-to-UI path afterwards, so a response that omitted it
      // would leave an admin unable to configure the service manually at all.
      const { service } = build();
      const res = await service.registerWebhook('', {});
      expect(res.secret).toBe('rotated-secret');
      expect(res.headerName).toBe(WHATSAPP_WEBHOOK_HEADER);
    });

    it('records the address it actually used in the audit trail', async () => {
      const audit = { log: jest.fn().mockResolvedValue(undefined) };
      const cfg = { ...CFG };
      const service = new WhatsAppAdminService(
        {} as any,
        {
          get: jest.fn().mockResolvedValue(cfg),
          ensureCredentials: jest.fn().mockResolvedValue(cfg),
          getPublic: jest.fn().mockResolvedValue({ webhookSecretConfigured: true }),
          rotateWebhookSecret: jest.fn().mockResolvedValue('s'),
        } as any,
        {} as any,
        {} as any,
        {
          setWebhook: jest.fn().mockResolvedValue({ ok: true }),
          findWebhook: jest.fn(),
          listInstanceNames: jest.fn().mockResolvedValue([cfg.instanceName]),
        } as any,
        audit as any,
      );

      await service.registerWebhook('', { id: 'u1' });
      // Logging the empty request body instead would make every audit row for
      // the normal path read `url: ''`.
      expect(audit.log.mock.calls[0][0].newData.url).toBe(
        `https://api.example.com${WHATSAPP_WEBHOOK_PATH}`,
      );
    });

    it('surfaces a provider refusal instead of reporting success', async () => {
      const { service, evolution } = build();
      evolution.setWebhook.mockResolvedValue({ ok: false, error: 'instance not found' });
      await expect(service.registerWebhook('', {})).rejects.toThrow(/instance not found/);
    });
  });

  // ───────────────────────────────────────────── the wrong-account guard

  describe('refuses to configure an account that is not ours', () => {
    /**
     * One Evolution server hosts several tenants here. Registering writes the
     * callback and rotates the secret onto whatever `instanceName` names — so a
     * wrong name does not fail, it silently reconfigures a DIFFERENT company's
     * WhatsApp and locks them out, while this system keeps rejecting its own
     * traffic. That is a live incident, not a hypothetical.
     */
    it('stops before rotating anything when the account does not exist', async () => {
      const { service, evolution } = build({ instanceName: 'typo_prod' }, null, [
        'skill_hive_innovations',
        'Taneka_prod',
      ]);

      await expect(service.registerWebhook('', {})).rejects.toThrow(/does not exist/i);
      // The two calls that would have done the damage.
      expect(evolution.setWebhook).not.toHaveBeenCalled();
      expect((service as any).settings.rotateWebhookSecret).not.toHaveBeenCalled();
    });

    it('lists the real account names, so the fix is obvious', async () => {
      const { service } = build({ instanceName: 'typo_prod' }, null, [
        'skill_hive_innovations',
        'Taneka_prod',
      ]);
      await expect(service.registerWebhook('', {})).rejects.toThrow(/Taneka_prod/);
    });

    it('proceeds when the account is one the service knows', async () => {
      const { service, evolution } = build({ instanceName: 'Taneka_prod' }, null, [
        'skill_hive_innovations',
        'Taneka_prod',
      ]);
      await expect(service.registerWebhook('', {})).resolves.toMatchObject({ ok: true });
      expect(evolution.setWebhook).toHaveBeenCalled();
    });

    it('still registers when the account list cannot be read', async () => {
      // An unreachable server is not evidence that the account is missing.
      // Failing closed here would make the button unusable during an outage.
      const { service, evolution } = build({}, null, null);
      await expect(service.registerWebhook('', {})).resolves.toMatchObject({ ok: true });
      expect(evolution.setWebhook).toHaveBeenCalled();
    });

    it('reports a wrong account name on the settings page too', async () => {
      const { service } = build({ instanceName: 'typo_prod' }, null, ['Taneka_prod']);
      const res = await service.webhookConfig();
      expect(res.unknownInstance).toEqual({
        configured: 'typo_prod',
        available: ['Taneka_prod'],
      });
    });

    it('reports nothing wrong when the account name is right', async () => {
      const { service } = build({}, null, ['skill_hive_innovations', CFG.instanceName]);
      expect((await service.webhookConfig()).unknownInstance).toBeNull();
    });

    it('never reports a missing account when the list is unreadable', async () => {
      const { service } = build({}, null, null);
      expect((await service.webhookConfig()).unknownInstance).toBeNull();
    });
  });
});
