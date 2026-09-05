import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { IDENTITY_STATUS } from '../whatsapp.types';

/**
 * Recognising a number that HR already has on the employee record.
 *
 * When an admin "adds the number to the account" they reasonably expect the
 * chatbot to know who that is. It did not: `Employee.phone` is free-text HR
 * data and a WhatsApp identity is a separate consented record, so every message
 * came back "Not recognised" no matter what was on the profile.
 *
 * The link is offered, not assumed. A number on an HR record is unverified —
 * it may be a typo, or since reassigned to a stranger — and what sits behind
 * the link is somebody's leave balance and payslip. One word back from the
 * handset is what turns a claim into proof.
 */
describe('WhatsApp — linking a number already on the employee record', () => {
  const PHONE = '+919952982836';

  const harness = (opts: {
    candidates?: any[];
    enrollmentEnabled?: boolean;
    defaultRegion?: string;
    from?: string;
  }) => {
    const sent: any[] = [];
    const created: any[] = [];

    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue(opts.candidates ?? []),
      whatsAppIdentity: {
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return { id: 'wai-1', ...data };
        }),
        update: jest.fn(),
      },
    };

    const svc = new WhatsAppInboundService(
      prisma,
      {} as any,
      {} as any,
      { normalise: (s: string) => (s ?? '').trim().toLowerCase() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        send: jest.fn(async (_s: any, out: any) => {
          sent.push(out);
          return true;
        }),
        genericUnknownReply: () => ({ plain: 'Not recognised' }),
      } as any,
      { allowUnknownReply: jest.fn().mockReturnValue(true) } as any,
      {} as any,
      { log: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    (svc as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    const cfg = {
      enrollmentEnabled: opts.enrollmentEnabled ?? true,
      defaultRegion: opts.defaultRegion ?? 'IN',
      appBaseUrl: 'https://portal.example.com',
    };

    const from = opts.from ?? PHONE;
    const run = (identity: any = null) =>
      (svc as any).handleUnenrolled(
        { id: 'sess-1', remoteJid: `${from.slice(1)}@s.whatsapp.net` },
        { phoneE164: from, body: 'Hi', callbackId: null },
        identity,
        cfg,
      );

    return { svc, prisma, sent, created, run, cfg };
  };

  const employee = (over: Record<string, any> = {}) => ({
    employeeId: 'emp-1',
    fullName: 'Tara Menon',
    phone: '9952982836',
    phoneCountryCode: null,
    branchCountry: null,
    userId: 'user-1',
    ...over,
  });

  describe('when the number is on exactly one employee record', () => {
    it('greets them by name instead of "Not recognised"', async () => {
      const { sent, run } = harness({ candidates: [employee()] });
      await run();

      expect(sent).toHaveLength(1);
      expect(sent[0].plain).toContain('Tara');
      expect(sent[0].plain).not.toContain('Not recognised');
    });

    it('creates a PENDING identity, never an active one', async () => {
      // ACTIVE here would hand HR data to whoever holds a number that HR typed.
      const { created, run } = harness({ candidates: [employee()] });
      await run();

      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        userId: 'user-1',
        phoneE164: PHONE,
        status: IDENTITY_STATUS.PENDING,
        optedIn: false,
        verified: false,
      });
    });

    it('asks for one word back, and offers a button for it', async () => {
      const { sent, run } = harness({ candidates: [employee()] });
      await run();
      expect(sent[0].plain).toMatch(/START/);
      expect(sent[0].buttons?.items).toHaveLength(1);
    });

    it('matches however the number was typed on the record', async () => {
      // The three shapes real HR data actually contains.
      for (const phone of ['+91-99529-82836', '9952982836', '099 5298 2836']) {
        const { created, run } = harness({ candidates: [employee({ phone })] });
        await run();
        expect(created.length).toBe(1);
      }
    });

    it("parses the record against the employee's own phone country", async () => {
      // A national number on the record, an Omani employee, an Indian default.
      // Without the per-employee country this parses as +91 and never matches.
      const { created, run } = harness({
        candidates: [employee({ phone: '90010000', phoneCountryCode: 'OM' })],
        defaultRegion: 'IN',
        from: '+96890010000',
      });
      await run();
      expect(created).toHaveLength(1);
      expect(created[0].phoneE164).toBe('+96890010000');
    });

    it('does not match that same record against the global default', async () => {
      // The mirror: drop the employee's country and the Omani number is
      // unreachable, which is exactly the bug the phone-country field fixed.
      const { created, run } = harness({
        candidates: [employee({ phone: '90010000', phoneCountryCode: null })],
        defaultRegion: 'IN',
        from: '+96890010000',
      });
      await run();
      expect(created).toHaveLength(0);
    });
  });

  describe('when it must not guess', () => {
    it('stays generic when two employees share the number', async () => {
      // Guessing would hand one person's HR record to the other.
      const { created, sent, run } = harness({
        candidates: [employee(), employee({ employeeId: 'emp-2', userId: 'user-2' })],
      });
      await run();

      expect(created).toHaveLength(0);
      expect(sent[0].plain).toContain('Not recognised');
    });

    it('stays generic when the match has no portal account', async () => {
      const { created, sent, run } = harness({ candidates: [employee({ userId: null })] });
      await run();

      expect(created).toHaveLength(0);
      expect(sent[0].plain).toContain('Not recognised');
    });

    it('stays generic when the digits only partly match', async () => {
      // The SQL prefilter matches on a tail; the precise parse is what decides.
      const { created, sent, run } = harness({ candidates: [employee({ phone: '9111182836' })] });
      await run();

      expect(created).toHaveLength(0);
      expect(sent[0].plain).toContain('Not recognised');
    });

    it('does nothing at all while self-linking is switched off', async () => {
      const { prisma, created, run } = harness({
        candidates: [employee()],
        enrollmentEnabled: false,
      });
      await run();

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(created).toHaveLength(0);
    });

    it('never re-offers to a number that already has an identity', async () => {
      // REVOKED and BLOCKED are decisions, not gaps to be filled in again.
      const { prisma, created, run } = harness({ candidates: [employee()] });
      await run({ status: IDENTITY_STATUS.REVOKED, phoneE164: PHONE });

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(created).toHaveLength(0);
    });

    it('survives the lookup failing without dropping the reply', async () => {
      const { sent, run, prisma } = harness({ candidates: [employee()] });
      prisma.$queryRaw.mockRejectedValue(new Error('db down'));
      await run();

      expect(sent[0].plain).toContain('Not recognised');
    });
  });
});
