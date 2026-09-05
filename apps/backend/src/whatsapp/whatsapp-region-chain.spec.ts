import { BadRequestException } from '@nestjs/common';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import { WhatsAppEnrollmentService } from './identity/whatsapp-enrollment.service';

/**
 * Region resolution for linking a handset, across BOTH services that do it.
 *
 * WhatsAppIdentityService (admin/self opt-in) and WhatsAppEnrollmentService
 * (code-to-the-handset) each resolve a region independently. If the two ever
 * disagree, the same typed digits enrol as one E.164 and are looked up as
 * another, and the identity silently fails to match — so the two are tested
 * against one shared table of cases rather than separately.
 *
 * Order: employee.phoneCountryCode -> branch.country -> whatsapp.defaultRegion
 *        -> payroll_country.
 */
describe('WhatsApp — phone region chain', () => {
  /** A user row as each service selects it. */
  const user = (phoneCountryCode: string | null, branchCountry: string | null) => ({
    employee: { phoneCountryCode, branch: { country: branchCountry } },
  });

  type Case = {
    name: string;
    employee: string | null;
    branch: string | null;
    defaultRegion: string;
    payrollCountry?: string;
    typed: string;
    expected: string | null;
  };

  const CASES: Case[] = [
    {
      name: "the employee's own country beats the branch and the default",
      employee: 'OM',
      branch: 'IN',
      defaultRegion: 'SG',
      typed: '90010000',
      expected: '+96890010000',
    },
    {
      name: 'the branch country applies when the employee has none',
      employee: null,
      branch: 'OM',
      defaultRegion: 'SG',
      typed: '90010000',
      expected: '+96890010000',
    },
    {
      name: 'the global default applies when neither is set',
      employee: null,
      branch: null,
      defaultRegion: 'IN',
      typed: '9500012345',
      expected: '+919500012345',
    },
    {
      name: 'payroll_country is the last resort',
      employee: null,
      branch: null,
      defaultRegion: '',
      payrollCountry: 'SG',
      typed: '80000001',
      expected: '+6580000001',
    },
    {
      name: 'an unusable employee code does not shadow the branch',
      employee: 'ZZ',
      branch: 'OM',
      defaultRegion: 'SG',
      typed: '90010000',
      expected: '+96890010000',
    },
    {
      name: 'an international number ignores the chain entirely',
      employee: 'IN',
      branch: 'IN',
      defaultRegion: 'IN',
      typed: '+96890010000',
      expected: '+96890010000',
    },
    {
      name: 'a national number with no usable region is rejected, not guessed',
      employee: null,
      branch: null,
      defaultRegion: '',
      typed: '90010000',
      expected: null,
    },
  ];

  const buildPrisma = (c: Case) => ({
    user: {
      findUnique: jest.fn().mockResolvedValue(user(c.employee, c.branch)),
    },
    systemSetting: {
      findUnique: jest
        .fn()
        .mockResolvedValue(c.payrollCountry ? { value: c.payrollCountry } : null),
    },
    whatsAppIdentity: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    whatsAppEnrollment: {
      updateMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: 'enr-1' })),
    },
    $transaction: jest.fn().mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(buildPrisma(c)) : Promise.all(arg),
    ),
  });

  const settingsFor = (c: Case) => ({
    get: jest.fn().mockResolvedValue({
      enabled: true,
      enrollmentEnabled: true,
      defaultRegion: c.defaultRegion,
    }),
    ensureCredentials: jest.fn().mockResolvedValue({ enabled: true }),
  });

  // ─────────────────────────────────────────────── opt-in (identity service)

  describe('WhatsAppIdentityService.previewOptIn', () => {
    const preview = (c: Case) => {
      const service = new WhatsAppIdentityService(
        buildPrisma(c) as any,
        settingsFor(c) as any,
        // Number-exists lookup is a separate concern; a null verdict is the
        // "gateway could not say" path and must not block the preview.
        { checkNumbers: jest.fn().mockResolvedValue(new Map()) } as any,
      );
      return service.previewOptIn('user-1', c.typed);
    };

    it.each(CASES.filter((c) => c.expected))('$name', async (c) => {
      await expect(preview(c)).resolves.toMatchObject({ phoneE164: c.expected });
    });

    it.each(CASES.filter((c) => !c.expected))('$name', async (c) => {
      await expect(preview(c)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('tells the user their country is unknown rather than blaming the number', async () => {
      const c = CASES.find((x) => x.expected === null)!;
      // The two messages send the user to different fixes, so the wrong one
      // costs a support round-trip.
      await expect(preview(c)).rejects.toThrow(/Could not determine your country/);
    });
  });

  // ────────────────────────────────────── enrollment (code to the handset)

  describe('WhatsAppEnrollmentService.start', () => {
    const start = (c: Case) => {
      const prisma = buildPrisma(c);
      const service = new WhatsAppEnrollmentService(
        prisma as any,
        settingsFor(c) as any,
        { checkNumbers: jest.fn().mockResolvedValue(new Map()), sendText: jest.fn().mockResolvedValue({ ok: true }) } as any,
        { allow: jest.fn().mockReturnValue(true) } as any,
        { log: jest.fn().mockResolvedValue(undefined) } as any,
      );
      return { prisma, promise: service.start('user-1', c.typed) };
    };

    it.each(CASES.filter((c) => c.expected))('$name', async (c) => {
      const { prisma, promise } = start(c);
      await promise.catch(() => undefined);
      // Whatever else start() does, the number it commits to must be the one
      // the chain resolved — that string is the join key for every later lookup.
      const created = prisma.whatsAppEnrollment.create.mock.calls[0]?.[0]?.data;
      const looked = prisma.whatsAppIdentity.findUnique.mock.calls[0]?.[0]?.where?.phoneE164;
      expect(created?.phoneE164 ?? looked).toBe(c.expected);
    });

    it.each(CASES.filter((c) => !c.expected))('$name', async (c) => {
      await expect(start(c).promise).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ───────────────────────────────────────────────────────────── agreement

  it('both services resolve every case to the same E.164', async () => {
    for (const c of CASES.filter((x) => x.expected)) {
      const identity = new WhatsAppIdentityService(
        buildPrisma(c) as any,
        settingsFor(c) as any,
        { checkNumbers: jest.fn().mockResolvedValue(new Map()) } as any,
      );
      const prisma = buildPrisma(c);
      const enrollment = new WhatsAppEnrollmentService(
        prisma as any,
        settingsFor(c) as any,
        { checkNumbers: jest.fn().mockResolvedValue(new Map()), sendText: jest.fn().mockResolvedValue({ ok: true }) } as any,
        { allow: jest.fn().mockReturnValue(true) } as any,
        { log: jest.fn().mockResolvedValue(undefined) } as any,
      );

      const viaOptIn = (await identity.previewOptIn('user-1', c.typed)).phoneE164;
      await enrollment.start('user-1', c.typed).catch(() => undefined);
      const viaEnrollment =
        prisma.whatsAppEnrollment.create.mock.calls[0]?.[0]?.data?.phoneE164 ??
        prisma.whatsAppIdentity.findUnique.mock.calls[0]?.[0]?.where?.phoneE164;

      expect([c.name, viaEnrollment]).toEqual([c.name, viaOptIn]);
    }
  });
});
