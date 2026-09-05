import { UnauthorizedException } from '@nestjs/common';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { WHATSAPP_WEBHOOK_HEADER } from '../whatsapp.types';

/**
 * Webhook authentication, and — just as important — why it failed.
 *
 * A production incident ran for two hours on a log line that said only
 * "Rejected WhatsApp webhook with a bad token (33 so far)". The instance
 * webhook was healthy the entire time; the 401s came from a SECOND, header-less
 * sender pointed at the same URL. "Bad token" sent the investigation towards
 * rotating a secret that was already correct — which would have broken the
 * working half.
 *
 * So the cause is part of the contract now, not decoration.
 */
describe('WhatsApp webhook — authentication and its diagnosis', () => {
  const SECRET = 'a'.repeat(64);

  const make = (secret = SECRET) => {
    const warn = jest.fn();
    const controller = new WhatsAppWebhookController(
      { get: jest.fn().mockResolvedValue({ webhookSecret: secret, instanceName: 'inst' }) } as any,
      { claim: jest.fn(), process: jest.fn() } as any,
      { runUnauthenticated: jest.fn() } as any,
    );
    (controller as any).logger = { warn, log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    return { controller, warn };
  };

  const res = () => {
    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.json = jest.fn().mockReturnValue(r);
    return r;
  };

  const body = { event: 'connection.update', instance: 'inst' };

  it('accepts the matching token', async () => {
    const { controller } = make();
    const r = res();
    await expect(controller.receive(body, SECRET, r)).resolves.toBeUndefined();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it.each([
    ['a token that does not match', 'b'.repeat(64)],
    ['no token at all', undefined],
  ])('rejects %s', async (_label, token) => {
    const { controller } = make();
    await expect(controller.receive(body, token as any, res())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  describe('the warning names the actual cause', () => {
    it('says the header was missing entirely, and points away from the secret', async () => {
      const { controller, warn } = make();
      await controller.receive(body, undefined as any, res()).catch(() => undefined);

      const line = warn.mock.calls[0][0];
      expect(line).toContain(WHATSAPP_WEBHOOK_HEADER);
      expect(line).toMatch(/no .* header at all/i);
      // The distinguishing detail: this is a different sender, not our instance.
      expect(line).toMatch(/global webhook|not the instance webhook/i);
    });

    it('says the token mismatched, and blames rotation elsewhere', async () => {
      const { controller, warn } = make();
      // Same instance as ours, so rotation really is the likely cause.
      await controller.receive(body, 'b'.repeat(64), res()).catch(() => undefined);

      const line = warn.mock.calls[0][0];
      expect(line).toMatch(/does not match/i);
      expect(line).toMatch(/rotated|another deployment/i);
    });

    it('names a foreign instance instead of blaming the secret', async () => {
      // The live case: two tenants' instances posting at one callback URL. The
      // "rotated somewhere else" wording sent an investigation towards rotating
      // a secret that was already correct, which would have broken the tenant
      // that still worked.
      const { controller, warn } = make();
      await controller
        .receive({ event: 'messages.upsert', instance: 'Taneka_prod' }, 'b'.repeat(64), res())
        .catch(() => undefined);

      const line = warn.mock.calls[0][0];
      expect(line).toContain('Taneka_prod');
      expect(line).toContain('inst');
      expect(line).toMatch(/two instances .* one url/i);
      // The instruction that matters most, because the intuitive fix is wrong.
      expect(line).toMatch(/do not rotate the secret/i);
    });

    it('does not claim a foreign instance when the name matches ours', async () => {
      const { controller, warn } = make();
      await controller
        .receive({ event: 'messages.upsert', instance: 'inst' }, 'b'.repeat(64), res())
        .catch(() => undefined);
      expect(warn.mock.calls[0][0]).not.toMatch(/two instances/i);
    });

    it('says we have no secret at all, and names the fix', async () => {
      const { controller, warn } = make('');
      await controller.receive(body, SECRET, res()).catch(() => undefined);

      const line = warn.mock.calls[0][0];
      expect(line).toMatch(/no webhook secret is configured/i);
      expect(line).toMatch(/Connect/i);
    });

    it('never puts the expected secret in the log', async () => {
      // The log is the least protected place a bearer credential can land.
      const { controller, warn } = make();
      await controller.receive(body, 'b'.repeat(64), res()).catch(() => undefined);
      expect(warn.mock.calls[0].join(' ')).not.toContain(SECRET);
    });

    it('records the event and instance, so the sender can be identified', async () => {
      const { controller, warn } = make();
      await controller
        .receive({ event: 'messages.upsert', instance: 'someone-else' }, undefined as any, res())
        .catch(() => undefined);
      expect(warn.mock.calls[0][0]).toContain('someone-else');
    });
  });
});
