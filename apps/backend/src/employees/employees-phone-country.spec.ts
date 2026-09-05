import { EmployeesService } from './employees.service';
// `update` requires an actor with no default: while it was optional the
// privileged controller branch passed none, and an HR_MANAGER could write a
// field marked editableByRoles: ['ADMIN']. A test with no human behind it says
// so explicitly, exactly as the production callers do.
import { SYSTEM_ACTOR } from '../common/utils/self-service.util';

/**
 * Per-employee phone country.
 *
 * A single instance now messages staff in several countries, so "the number has
 * no country prefix" can no longer be answered with one global setting. Each
 * employee may carry their own ISO-3166 code, and the resolution order is
 *
 *     employee.phoneCountryCode -> branch.country -> whatsapp.defaultRegion
 *
 * The failure mode these tests exist to prevent is not "no message" but
 * "message to the wrong human": an Omani national number parsed against IN is a
 * valid Indian number belonging to a stranger. That is why the no-region case
 * must send NOTHING rather than fall back to a guess.
 */
describe('EmployeesService — per-employee phone country', () => {
  let prisma: any;
  let outbox: any;
  let whatsappSettings: any;
  let service: EmployeesService;

  const STORED = {
    id: 'emp-1',
    branchId: null,
    employmentType: null as string | null,
    salaryType: 'MONTHLY',
    baseSalary: 50000,
    position: 'Fitter',
    departmentId: 'dept-1',
    status: 'ACTIVE',
    email: 'a@b.c',
    idCard: 'ID1',
    phone: '90010000',
    phoneCountryCode: null as string | null,
  };

  const stored = (over: Record<string, any> = {}) => ({ ...STORED, ...over });

  beforeEach(() => {
    prisma = {
      libraryItem: { findUnique: jest.fn().mockResolvedValue(null) },
      employee: {
        findUnique: jest.fn().mockResolvedValue(stored()),
        update: jest.fn().mockImplementation(async ({ data }: any) => data),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          ...data,
          id: 'emp-new',
          department: { name: 'Ops' },
          startDate: new Date(),
        })),
      },
      employeeHistory: { createMany: jest.fn().mockResolvedValue({}) },
      department: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'dept-1', isActive: true, parentId: null, code: 'OPS' }),
      },
      user: {
        // Consulted only when the login address drifted from the employee's —
        // never in these cases, and "nobody else holds it" if it ever is.
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (arg: any) =>
          typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
        ),
    };

    outbox = { enqueueDirect: jest.fn().mockResolvedValue(undefined) };
    whatsappSettings = {
      get: jest.fn().mockResolvedValue({ enabled: true, defaultRegion: '', appBaseUrl: '' }),
    };

    service = new EmployeesService(
      prisma,
      {} as any,
      // MailService — the welcome mail is not what these tests are about, but it
      // must succeed or resendWelcomeEmail never reaches the WhatsApp branch.
      { sendWelcomeEmail: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      {} as any,
      { assertCleared: jest.fn().mockResolvedValue(undefined) } as any,
      outbox as any,
      whatsappSettings as any,
      // Profile template resolver. These cases never send customFields, but
      // createEmployeeRecord consults the resolver, so a bare {} would throw.
      {
        resolve: jest.fn().mockResolvedValue({ enabled: false, fields: [] }),
      } as any,
      // SupervisorsService — supervisorId is never sent by these cases.
      {
        assign: jest.fn().mockResolvedValue(undefined),
        unassign: jest.fn().mockResolvedValue(undefined),
      } as any,
          // GarnishmentsService — appended to the ctor when court orders became a
      // real model; an exit flips any unrecovered balance to RECEIVABLE.
      { markOutstandingAsReceivable: jest.fn().mockResolvedValue(0) } as any,
);
  });

  // ───────────────────────────────────────────────────────────── persistence

  describe('createEmployeeRecord() — what gets stored', () => {
    const create = (dto: Record<string, any>) =>
      (service as any).createEmployeeRecord({
        fullName: 'A',
        email: 'a@b.c',
        idCard: 'ID1',
        dateOfBirth: '1990-01-01',
        startDate: '2026-01-01',
        departmentId: 'dept-1',
        position: 'Fitter',
        baseSalary: 1,
        ...dto,
      });

    const written = () => prisma.employee.create.mock.calls[0][0].data;

    beforeEach(() => {
      // generateEmployeeCode reads the department and existing codes.
      jest
        .spyOn(service as any, 'generateEmployeeCode')
        .mockResolvedValue('OPS001');
    });

    it.each([
      ['OM', 'OM'],
      ['om', 'OM'],
      [' sg ', 'SG'],
    ])('stores %p canonicalised as %p', async (input, expected) => {
      await create({ phoneCountryCode: input });
      expect(written().phoneCountryCode).toBe(expected);
    });

    it.each([undefined, '', 'ZZ', 'IND', '99'])(
      'stores null for %p rather than a code the parser cannot use',
      async (input) => {
        await create({ phoneCountryCode: input });
        expect(written().phoneCountryCode).toBeNull();
      },
    );

    it('never writes more than the column holds', async () => {
      await create({ phoneCountryCode: 'om' });
      // VARCHAR(2). Anything longer would be a runtime insert failure in prod.
      expect(written().phoneCountryCode).toHaveLength(2);
    });
  });

  describe('update() — changing and clearing', () => {
    const update = (dto: Record<string, any>, current: Record<string, any> = {}) => {
      prisma.employee.findUnique.mockResolvedValue(stored(current));
      return service.update('emp-1', dto as any, 'user-1', SYSTEM_ACTOR);
    };

    const written = () => prisma.employee.update.mock.calls[0][0].data;

    it('canonicalises a new code', async () => {
      await update({ phoneCountryCode: 'sg' });
      expect(written().phoneCountryCode).toBe('SG');
    });

    it("clears the code on '' — the form's way of saying 'use the default again'", async () => {
      await update({ phoneCountryCode: '' }, { phoneCountryCode: 'OM' });
      expect(written().phoneCountryCode).toBeNull();
    });

    it('nulls an unusable code instead of storing it to fail later', async () => {
      await update({ phoneCountryCode: 'ZZ' }, { phoneCountryCode: 'OM' });
      expect(written().phoneCountryCode).toBeNull();
    });

    it('leaves a stored code untouched when the field is not in the payload', async () => {
      // An edit of an unrelated field must not silently drop the country — this
      // is the regression that would strand an employee on the wrong region.
      await update({ position: 'Foreman' }, { phoneCountryCode: 'OM' });
      expect(written()).not.toHaveProperty('phoneCountryCode');
    });
  });

  // ──────────────────────────────────────────────────── the resolution chain

  describe('credential send — region resolution order', () => {
    const employee = (over: Record<string, any> = {}) => ({
      id: 'emp-1',
      branchId: 'br-1',
      employeeCode: 'OPS001',
      fullName: 'A B',
      email: 'a@b.c',
      position: 'Fitter',
      phone: '90010000',
      phoneCountryCode: null,
      department: { name: 'Ops' },
      branch: { country: null },
      startDate: new Date('2026-01-01'),
      // A real login row always carries the address it answers to, and
      // resendWelcomeEmail now compares the two: a user stub with no email
      // reads as a login that drifted off the employee's address.
      user: { id: 'user-1', email: 'a@b.c' },
      ...over,
    });

    const resend = async (over: Record<string, any> = {}, cfg: Record<string, any> = {}) => {
      prisma.employee.findUnique.mockResolvedValue(employee(over));
      whatsappSettings.get.mockResolvedValue({
        enabled: true,
        defaultRegion: '',
        appBaseUrl: '',
        ...cfg,
      });
      await service.resendWelcomeEmail('emp-1');
      // The send is fire-and-forget; let its promise chain settle.
      await new Promise((r) => setImmediate(r));
    };

    const sentTo = () => outbox.enqueueDirect.mock.calls[0]?.[0]?.toE164;

    it("uses the employee's own country ahead of the branch and the default", async () => {
      await resend(
        { phoneCountryCode: 'OM', branch: { country: 'IN' } },
        { defaultRegion: 'SG' },
      );
      expect(sentTo()).toBe('+96890010000');
    });

    it('falls back to the branch country when the employee has none', async () => {
      await resend({ phoneCountryCode: null, branch: { country: 'OM' } }, { defaultRegion: 'SG' });
      expect(sentTo()).toBe('+96890010000');
    });

    it('falls back to the global WhatsApp default when neither is set', async () => {
      await resend(
        { phoneCountryCode: null, branch: { country: null }, phone: '9500012345' },
        { defaultRegion: 'IN' },
      );
      expect(sentTo()).toBe('+919500012345');
    });

    it('skips an unusable employee code rather than letting it shadow the branch', async () => {
      await resend({ phoneCountryCode: 'ZZ', branch: { country: 'OM' } }, { defaultRegion: 'SG' });
      expect(sentTo()).toBe('+96890010000');
    });

    it('sends nothing when no region in the chain is usable', async () => {
      // The whole point: no 'IN' backstop. A national number with no country is
      // unaddressable, and guessing reaches a stranger who holds those digits.
      await resend(
        { phoneCountryCode: null, branch: { country: null } },
        { defaultRegion: '' },
      );
      expect(outbox.enqueueDirect).not.toHaveBeenCalled();
    });

    it('ignores the whole chain once the number is already international', async () => {
      await resend(
        { phone: '+96890010000', phoneCountryCode: 'IN', branch: { country: 'IN' } },
        { defaultRegion: 'IN' },
      );
      expect(sentTo()).toBe('+96890010000');
    });

    it('sends nothing at all while WhatsApp is switched off', async () => {
      await resend({ phoneCountryCode: 'OM' }, { enabled: false });
      expect(outbox.enqueueDirect).not.toHaveBeenCalled();
    });

    it('still resends the welcome email when the number cannot be resolved', async () => {
      // WhatsApp is best-effort; an unresolvable number must not fail the request.
      prisma.employee.findUnique.mockResolvedValue(
        employee({ phoneCountryCode: null, branch: { country: null } }),
      );
      await expect(service.resendWelcomeEmail('emp-1')).resolves.toMatchObject({
        success: true,
      });
    });
  });
});
