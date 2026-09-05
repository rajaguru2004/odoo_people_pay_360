import axios from 'axios';
import { EvolutionClient } from './evolution.client';
import { WhatsAppResolvedConfig } from '../whatsapp.types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

/**
 * Wire-format tests.
 *
 * Evolution v2 flattened its message bodies: there is no `options{}` wrapper and
 * no `textMessage{}` nesting (both were v1). Getting that wrong fails silently —
 * the API accepts the request and no message arrives — so the shape is asserted
 * explicitly rather than left to integration testing.
 */
const CFG: WhatsAppResolvedConfig = {
  enabled: true,
  baseUrl: 'https://wa.example.com',
  instanceName: 'skill_hive',
  apiKey: 'the-key',
  apiKeySource: 'db',
  adminNumber: '',
  defaultRegion: 'OM',
  appBaseUrl: 'https://ess.example.com',
  publicApiUrl: 'https://api.ess.example.com',
  minGapMs: 0,
  maxPerMinute: 1000,
  timeoutMs: 15_000,
  maxAttempts: 5,
  requireOptIn: true,
  requireVerified: true,
  allowGenericFallback: false,
  disabledTemplates: [],
  redirectAllTo: '',
  redirectMisconfigured: false,
  redirectAllToRaw: '',
  // Off in the fixture: these cases assert wire format, not recipient discovery.
  autoEnroll: false,
  // Off in the fixture: the copy is an opt-in debugging aid, and every
  // pre-existing case here asserts the single-recipient behaviour.
  carbonCopyEnabled: false,
  carbonCopyTo: '',
  carbonCopyMisconfigured: false,
  carbonCopyToRaw: '',
  inboundEnabled: false,
  enrollmentEnabled: true,
  mutationsEnabled: true,
  approvalsEnabled: false,
  aiFallbackEnabled: false,
  actionDenylist: [],
  requirePinForSensitive: true,
  interactiveMode: 'auto',
  attendanceVerification: 'OFF',
  supportContact: '',
  quietHoursStart: '',
  quietHoursEnd: '',
  quietHoursOverrideTemplates: [],
  selfieDailyCap: 4,
  selfieChallengeSeconds: 120,
  verificationLinkTtlMinutes: 10,
  attendanceFaceOverride: true,
  sessionIdleMinutes: 30,
  flowTtlMinutes: 15,
  pendingActionTtlMinutes: 10,
  approvalTokenTtlMinutes: 60,
  pinTtlMinutes: 10,
  webhookSecret: 'wh-secret',
  logMessageBodies: true,
  inboundRetentionDays: 90,
  ratePerPhone5Min: 20,
  ratePerUserHour: 60,
  rateMutations10Min: 5,
  dryRun: false,
  retentionDays: 90,
  staleHours: 24,
  drainBatchSize: 50,
};

describe('EvolutionClient', () => {
  let client: EvolutionClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new EvolutionClient();
    client.setPacing(0, 1000);
  });

  describe('sendText wire format', () => {
    beforeEach(() => {
      mockedAxios.post.mockResolvedValue({ data: { key: { id: 'WA123' } } } as any);
    });

    it('posts a v2 flat body with no options or textMessage wrapper', async () => {
      await client.sendText(CFG, { toE164: '+96890010000', text: 'hello' });

      const [, body] = mockedAxios.post.mock.calls[0];
      expect(body).toEqual({ number: '96890010000', text: 'hello', linkPreview: false });
      expect(body).not.toHaveProperty('options');
      expect(body).not.toHaveProperty('textMessage');
    });

    it('targets /message/sendText/{instance} with no version prefix', async () => {
      await client.sendText(CFG, { toE164: '+96890010000', text: 'hi' });

      expect(mockedAxios.post.mock.calls[0][0]).toBe(
        'https://wa.example.com/message/sendText/skill_hive',
      );
    });

    it('authenticates with the bare apikey header, not Authorization', async () => {
      await client.sendText(CFG, { toE164: '+96890010000', text: 'hi' });

      const cfg = mockedAxios.post.mock.calls[0][2] as any;
      expect(cfg.headers.apikey).toBe('the-key');
      expect(cfg.headers.Authorization).toBeUndefined();
      expect(cfg.timeout).toBe(15_000);
    });

    it('strips the plus from the recipient number', async () => {
      await client.sendText(CFG, { toE164: '+919000000100', text: 'hi' });
      expect((mockedAxios.post.mock.calls[0][1] as any).number).toBe('919000000100');
    });

    it('returns the provider message id', async () => {
      const res = await client.sendText(CFG, { toE164: '+96890010000', text: 'hi' });
      expect(res).toMatchObject({ ok: true, providerMessageId: 'WA123' });
    });

    it('includes delay only when asked', async () => {
      await client.sendText(CFG, { toE164: '+96890010000', text: 'hi' });
      expect(mockedAxios.post.mock.calls[0][1]).not.toHaveProperty('delay');

      await client.sendText(CFG, { toE164: '+96890010000', text: 'hi', delay: 600 });
      expect((mockedAxios.post.mock.calls[1][1] as any).delay).toBe(600);
    });
  });

  describe('sendMedia wire format', () => {
    it('posts a flat media body', async () => {
      mockedAxios.post.mockResolvedValue({ data: { key: { id: 'WA9' } } } as any);
      await client.sendMedia(CFG, {
        toE164: '+96890010000',
        mediatype: 'document',
        mimetype: 'application/pdf',
        media: 'https://x/y.pdf',
        fileName: 'payslip.pdf',
        caption: 'Your payslip',
      });

      expect(mockedAxios.post.mock.calls[0][1]).toEqual({
        number: '96890010000',
        mediatype: 'document',
        mimetype: 'application/pdf',
        media: 'https://x/y.pdf',
        fileName: 'payslip.pdf',
        caption: 'Your payslip',
      });
      expect(mockedAxios.post.mock.calls[0][1]).not.toHaveProperty('mediaMessage');
    });
  });

  describe('error classification', () => {
    it.each([400, 401, 403, 404, 422])('treats %d as non-retryable', async (status) => {
      mockedAxios.post.mockRejectedValue({ response: { status, data: { message: 'bad' } } });
      const res = await client.sendText(CFG, { toE164: '+96890010000', text: 'x' });

      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(false);
      expect(res.status).toBe(status);
    });

    it.each([408, 429, 500, 502, 503])('treats %d as retryable', async (status) => {
      mockedAxios.post.mockRejectedValue({ response: { status, data: 'busy' } });
      const res = await client.sendText(CFG, { toE164: '+96890010000', text: 'x' });

      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(true);
    });

    it.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'])(
      'treats %s as retryable',
      async (code) => {
        mockedAxios.post.mockRejectedValue({ code, message: code });
        const res = await client.sendText(CFG, { toE164: '+96890010000', text: 'x' });
        expect(res.retryable).toBe(true);
      },
    );

    it('extracts a message from Evolution\'s nested error shapes', () => {
      expect(
        client.classifyError({ response: { status: 400, data: { response: { message: 'deep' } } } })
          .message,
      ).toBe('deep');
      expect(
        client.classifyError({ response: { status: 400, data: { error: 'flat' } } }).message,
      ).toBe('flat');
      expect(client.classifyError({ message: 'axios said so' }).message).toBe('axios said so');
    });

    /**
     * Two FAILED rows in production carry the literal text "[object Object]".
     * Evolution reports validation failures as an ARRAY of messages, and
     * `String(['a','b'])`/`String({…})` destroyed the only forensic record a
     * failed send leaves behind.
     */
    it('serialises an array of messages instead of stringifying it to junk', () => {
      const message = client.classifyError({
        response: { status: 400, data: { response: { message: ['number is invalid', 'no session'] } } },
      }).message;

      expect(message).not.toContain('[object Object]');
      expect(message).toContain('number is invalid');
      expect(message).toContain('no session');
    });

    it('serialises a nested object payload as JSON', () => {
      const message = client.classifyError({
        response: { status: 400, data: { message: { reason: 'not-on-whatsapp', code: 44 } } },
      }).message;

      expect(message).not.toContain('[object Object]');
      expect(message).toContain('not-on-whatsapp');
    });

    it('truncates a runaway error body', () => {
      const long = 'x'.repeat(5000);
      expect(client.classifyError({ message: long }).message.length).toBeLessThanOrEqual(300);
    });

    it('never throws — a send failure is a return value', async () => {
      mockedAxios.post.mockRejectedValue(new Error('kaboom'));
      await expect(
        client.sendText(CFG, { toE164: '+96890010000', text: 'x' }),
      ).resolves.toMatchObject({ ok: false });
    });
  });

  describe('connectionState', () => {
    it('normalises the nested state field', async () => {
      mockedAxios.get.mockResolvedValue({ data: { instance: { state: 'open' } } } as any);
      await expect(client.connectionState(CFG)).resolves.toMatchObject({ state: 'open' });
    });

    it('reports unknown rather than throwing when the gateway is down', async () => {
      mockedAxios.get.mockRejectedValue(new Error('down'));
      const res = await client.connectionState(CFG);
      expect(res.state).toBe('unknown');
      expect(res.error).toBeTruthy();
    });
  });

  describe('checkNumbers', () => {
    it('maps results back onto the E.164 inputs', async () => {
      mockedAxios.post.mockResolvedValue({
        data: [
          { exists: true, jid: '96890010000@s.whatsapp.net', number: '96890010000' },
          { exists: false, number: '96890010001' },
        ],
      } as any);

      const res = await client.checkNumbers(CFG, ['+96890010000', '+96890010001']);
      expect(res.get('+96890010000')).toEqual({
        exists: true,
        jid: '96890010000@s.whatsapp.net',
      });
      expect(res.get('+96890010001')).toEqual({ exists: false, jid: undefined });
    });

    it('returns an empty map on failure — never a false "does not exist"', async () => {
      mockedAxios.post.mockRejectedValue(new Error('down'));
      const res = await client.checkNumbers(CFG, ['+96890010000']);
      expect(res.size).toBe(0);
      expect(res.has('+96890010000')).toBe(false);
    });

    it('short-circuits on an empty list', async () => {
      await client.checkNumbers(CFG, []);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('pacing', () => {
    it('spaces consecutive sends by at least minGapMs', async () => {
      mockedAxios.post.mockResolvedValue({ data: { key: { id: 'x' } } } as any);
      client.setPacing(120, 1000);

      const started = Date.now();
      await client.sendText(CFG, { toE164: '+96890010000', text: '1' });
      await client.sendText(CFG, { toE164: '+96890010000', text: '2' });

      expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    });
  });
});
