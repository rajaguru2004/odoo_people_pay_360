import { WhatsAppIdentityService } from './whatsapp-identity.service';
import { IDENTITY_SOURCE } from './whatsapp.types';

/**
 * Bulk-linking the phone numbers already held on employee records.
 *
 * This is the gap that kept a correctly configured production channel delivering
 * to nobody: eleven employees with phones on file, one identity row, and no way
 * to create the rest from inside the product. `IDENTITY_SOURCE.ADMIN` was
 * declared and never written by anything.
 *
 * The cases here are the ones where being wrong is expensive:
 *
 *  1. **Dry-run must write nothing.** An operator has to be able to see which
 *     numbers are unreadable or shared BEFORE committing.
 *  2. **A shared number is refused, not linked.** `phone_e164` is unique because
 *     one WhatsApp account belongs to one person; linking a family number twice
 *     would deliver one employee's leave decisions to another.
 *  3. **Consent is explicit.** Writing `optedIn` records the EMPLOYER asserting
 *     it, so it only happens when asked for.
 *  4. **Self-service consent is never revoked** by a re-run.
 */

const EMPLOYEES = [
  {
    id: 'e1',
    employeeCode: 'E001',
    fullName: 'Aisha Al-Balushi',
    phone: '9001 0000',
    branchId: 'b1',
    user: { id: 'u1' },
  },
  {
    id: 'e2',
    employeeCode: 'E002',
    fullName: 'Ravi Kumar',
    phone: '+91 99529 82836',
    branchId: 'b1',
    user: { id: 'u2' },
  },
];

function makeService(
  over: {
    employees?: any[];
    exists?: Record<string, boolean>;
    owners?: Record<string, { userId: string }>;
    existing?: Record<string, any>;
    credentials?: boolean;
  } = {},
) {
  const employees = over.employees ?? EMPLOYEES;

  const prisma: any = {
    employee: { findMany: jest.fn().mockResolvedValue(employees) },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ employee: { phoneCountryCode: 'OM', branch: { country: 'OM' } } }),
    },
    systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    whatsAppIdentity: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) => over.owners?.[where.phoneE164] ?? null),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) => over.existing?.[where.userId] ?? null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };

  const settings: any = {
    get: jest.fn().mockResolvedValue({ defaultRegion: 'OM' }),
    ensureCredentials: jest
      .fn()
      .mockResolvedValue(over.credentials === false ? null : { baseUrl: 'x' }),
  };

  const evolution: any = {
    checkNumbers: jest.fn().mockImplementation(async (_cfg: any, nums: string[]) => {
      const m = new Map<string, { exists: boolean; jid?: string }>();
      for (const n of nums) {
        const e = over.exists?.[n];
        // Default: every number is on WhatsApp.
        m.set(n, { exists: e === undefined ? true : e, jid: `${n.slice(1)}@s.whatsapp.net` });
      }
      return m;
    }),
  };

  const svc = new WhatsAppIdentityService(prisma, settings, evolution);
  return { svc, prisma, evolution, settings };
}

/**
 * Auto-enrolment — the model the product actually has.
 *
 * WhatsApp is switched on for the company by an admin; employees do not
 * subscribe to it. Before this, `whatsapp.enabled` looked like that switch and
 * was not: a correctly configured channel with eleven numbers on file delivered
 * to nobody, because every one of them was waiting on an opt-in page no
 * employee had been told about.
 *
 * The two rules that keep it lawful are pinned hardest: it only ever CREATES,
 * so an explicit opt-out is never resurrected; and numbers are confirmed against
 * WhatsApp before they are written.
 */
describe('WhatsAppIdentityService.autoEnrollUsers', () => {
  const withUsers = (over: any = {}) => {
    const { svc, prisma, evolution } = makeService(over);
    prisma.user.findMany = jest.fn().mockResolvedValue(
      over.users ?? [
        {
          id: 'u1',
          employeeId: 'e1',
          employee: { id: 'e1', phone: '9001 0000', branchId: 'b1' },
        },
      ],
    );
    prisma.whatsAppIdentity.findMany = jest
      .fn()
      .mockResolvedValue(over.identities ?? []);
    return { svc, prisma, evolution };
  };

  it('makes an employee reachable from the number on their HR record', async () => {
    const { svc, prisma } = withUsers();
    expect(await svc.autoEnrollUsers(['u1'])).toBe(1);

    const data = prisma.whatsAppIdentity.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: 'u1',
      employeeId: 'e1',
      phoneE164: '+96890010000',
      source: IDENTITY_SOURCE.EMPLOYEE_PHONE,
      optedIn: true,
      verified: true,
    });
  });

  it('leaves an employee who opted OUT alone', async () => {
    // The compliance line. A row that exists is a decision already taken, and
    // the next notification must not quietly undo it.
    const { svc, prisma } = withUsers({
      identities: [{ userId: 'u1' }],
    });

    expect(await svc.autoEnrollUsers(['u1'])).toBe(0);
    expect(prisma.whatsAppIdentity.create).not.toHaveBeenCalled();
    expect(prisma.whatsAppIdentity.update).not.toHaveBeenCalled();
  });

  it('confirms the number against WhatsApp before writing it', async () => {
    const { svc, prisma } = withUsers({ exists: { '+96890010000': false } });

    expect(await svc.autoEnrollUsers(['u1'])).toBe(0);
    expect(prisma.whatsAppIdentity.create).not.toHaveBeenCalled();
  });

  it('writes nothing when the gateway cannot be reached', async () => {
    // Better to enrol nobody now and retry on the next notification than to
    // record an unverified guess as deliverable.
    const { svc, prisma } = withUsers({ credentials: false });

    expect(await svc.autoEnrollUsers(['u1'])).toBe(0);
    expect(prisma.whatsAppIdentity.create).not.toHaveBeenCalled();
  });

  it('does not link a number that belongs to somebody else', async () => {
    const { svc, prisma } = withUsers({ owners: { '+96890010000': { id: 'other' } } });

    expect(await svc.autoEnrollUsers(['u1'])).toBe(0);
    expect(prisma.whatsAppIdentity.create).not.toHaveBeenCalled();
  });

  it('skips a number two employees share', async () => {
    const { svc, prisma } = withUsers({
      users: [
        { id: 'u1', employeeId: 'e1', employee: { id: 'e1', phone: '9001 0000', branchId: null } },
        { id: 'u2', employeeId: 'e2', employee: { id: 'e2', phone: '9001 0000', branchId: null } },
      ],
    });

    expect(await svc.autoEnrollUsers(['u1', 'u2'])).toBe(1);
    expect(prisma.whatsAppIdentity.create).toHaveBeenCalledTimes(1);
  });

  it('only looks at active employees who still have a phone', async () => {
    const { svc, prisma } = withUsers();
    await svc.autoEnrollUsers(['u1']);

    expect(prisma.user.findMany.mock.calls[0][0].where.employee).toMatchObject({
      phone: { not: null },
      status: 'ACTIVE',
    });
  });

  it('never throws — a failure must not take the notification down', async () => {
    const { svc, prisma } = withUsers();
    prisma.whatsAppIdentity.findMany.mockRejectedValue(new Error('db is gone'));

    await expect(svc.autoEnrollUsers(['u1'])).resolves.toBe(0);
  });

  it('does nothing for an empty batch', async () => {
    const { svc, prisma } = withUsers();
    expect(await svc.autoEnrollUsers([])).toBe(0);
    expect(prisma.whatsAppIdentity.findMany).not.toHaveBeenCalled();
  });
});

describe('WhatsAppIdentityService.enrollFromEmployeePhones', () => {
  describe('dry run (the default)', () => {
    it('writes nothing at all', async () => {
      const { svc, prisma } = makeService();
      const res = await svc.enrollFromEmployeePhones({});

      expect(res.committed).toBe(false);
      expect(prisma.whatsAppIdentity.create).not.toHaveBeenCalled();
      expect(prisma.whatsAppIdentity.update).not.toHaveBeenCalled();
    });

    it('still reports exactly what would happen', async () => {
      const { svc } = makeService();
      const res = await svc.enrollFromEmployeePhones({});

      expect(res.considered).toBe(2);
      expect(res.results.map((r) => r.outcome)).toEqual(['linked', 'linked']);
      expect(res.results.every((r) => r.verified)).toBe(true);
    });

    it('normalises against the employee region chain', async () => {
      const { svc, evolution } = makeService();
      await svc.enrollFromEmployeePhones({});

      // '9001 0000' resolved against OM, the +91 number left as typed.
      expect(evolution.checkNumbers.mock.calls[0][1]).toEqual([
        '+96890010000',
        '+919952982836',
      ]);
    });

    it('masks numbers in the report', async () => {
      const { svc } = makeService();
      const res = await svc.enrollFromEmployeePhones({});
      expect(res.results[0].phoneMasked).not.toContain('90010000');
      expect(res.results[0].phoneMasked).toContain('•');
    });
  });

  describe('commit', () => {
    it('creates a verified identity per employee', async () => {
      const { svc, prisma } = makeService();
      await svc.enrollFromEmployeePhones({ commit: true });

      expect(prisma.whatsAppIdentity.create).toHaveBeenCalledTimes(2);
      const first = prisma.whatsAppIdentity.create.mock.calls[0][0].data;
      expect(first).toMatchObject({
        userId: 'u1',
        employeeId: 'e1',
        branchId: 'b1',
        phoneE164: '+96890010000',
        source: IDENTITY_SOURCE.ADMIN,
        verified: true,
      });
    });

    it('leaves them opted OUT unless consent is confirmed', async () => {
      // Linked and confirmed, but not deliverable — the employee still decides.
      const { svc, prisma } = makeService();
      await svc.enrollFromEmployeePhones({ commit: true });

      const data = prisma.whatsAppIdentity.create.mock.calls[0][0].data;
      expect(data.optedIn).toBe(false);
      expect(data.optedInAt).toBeNull();
    });

    it('records employer-asserted consent when asked', async () => {
      const { svc, prisma } = makeService();
      const res = await svc.enrollFromEmployeePhones({ commit: true, confirmConsent: true });

      const data = prisma.whatsAppIdentity.create.mock.calls[0][0].data;
      expect(data.optedIn).toBe(true);
      expect(data.optedInAt).toBeInstanceOf(Date);
      expect(data.source).toBe(IDENTITY_SOURCE.ADMIN);
      expect(res.optedIn).toBe(true);
    });

    it('updates rather than duplicating an existing row', async () => {
      const { svc, prisma } = makeService({
        existing: { u1: { id: 'i1', optedIn: false, source: IDENTITY_SOURCE.ADMIN } },
      });
      await svc.enrollFromEmployeePhones({ commit: true });

      expect(prisma.whatsAppIdentity.update).toHaveBeenCalledTimes(1);
      expect(prisma.whatsAppIdentity.create).toHaveBeenCalledTimes(1);
      expect(prisma.whatsAppIdentity.update.mock.calls[0][0].where).toEqual({ id: 'i1' });
    });

    it('never revokes consent an employee gave themselves', async () => {
      // A re-run without confirmConsent must not opt somebody out.
      const optedInAt = new Date('2026-08-01T00:00:00Z');
      const { svc, prisma } = makeService({
        existing: {
          u1: { id: 'i1', optedIn: true, optedInAt, source: IDENTITY_SOURCE.SELF },
        },
      });
      await svc.enrollFromEmployeePhones({ commit: true });

      const data = prisma.whatsAppIdentity.update.mock.calls[0][0].data;
      expect(data.optedIn).toBe(true);
      expect(data.optedInAt).toBe(optedInAt);
      // And it stays THEIR consent, not the employer's.
      expect(data.source).toBe(IDENTITY_SOURCE.SELF);
    });
  });

  describe('refusals', () => {
    it('skips a number it cannot parse, naming the country it tried', async () => {
      const { svc } = makeService({
        employees: [{ ...EMPLOYEES[0], phone: 'not a phone' }],
      });
      const res = await svc.enrollFromEmployeePhones({ commit: true });

      expect(res.results[0].outcome).toBe('skipped');
      expect(res.results[0].reason).toMatch(/not a valid number for OM/);
    });

    it('skips a number shared by two employees rather than linking it twice', async () => {
      const { svc, prisma } = makeService({
        employees: [EMPLOYEES[0], { ...EMPLOYEES[1], phone: '9001 0000', user: { id: 'u2' } }],
      });
      const res = await svc.enrollFromEmployeePhones({ commit: true });

      expect(res.results[1].outcome).toBe('skipped');
      expect(res.results[1].reason).toMatch(/Shares a number with Aisha/);
      expect(prisma.whatsAppIdentity.create).toHaveBeenCalledTimes(1);
    });

    it('skips a number already linked to somebody else', async () => {
      const { svc } = makeService({ owners: { '+96890010000': { userId: 'someone-else' } } });
      const res = await svc.enrollFromEmployeePhones({ commit: true });

      expect(res.results[0].outcome).toBe('skipped');
      expect(res.results[0].reason).toMatch(/already linked/i);
    });

    it('skips a number that is not on WhatsApp', async () => {
      const { svc } = makeService({ exists: { '+96890010000': false } });
      const res = await svc.enrollFromEmployeePhones({ commit: true });

      expect(res.results[0].outcome).toBe('skipped');
      expect(res.results[0].reason).toMatch(/not registered on WhatsApp/);
    });

    it('links but does not confirm when the gateway cannot be reached', async () => {
      // An unknown is not a "no": the operator can still link numbers they trust
      // and confirm them later with "Check unconfirmed numbers".
      const { svc, prisma } = makeService({ credentials: false });
      const res = await svc.enrollFromEmployeePhones({ commit: true });

      expect(res.results[0].outcome).toBe('linked');
      expect(res.results[0].verified).toBe(false);
      expect(res.results[0].reason).toMatch(/Could not check WhatsApp/);
      expect(prisma.whatsAppIdentity.create.mock.calls[0][0].data.lastCheckedAt).toBeNull();
    });
  });

  it('only considers active employees who have a login and a phone', async () => {
    const { svc, prisma } = makeService();
    await svc.enrollFromEmployeePhones({});

    expect(prisma.employee.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'ACTIVE',
      phone: { not: null },
      user: { isNot: null },
    });
  });

  it('can be limited to named employees', async () => {
    const { svc, prisma } = makeService();
    await svc.enrollFromEmployeePhones({ employeeIds: ['e1'] });

    expect(prisma.employee.findMany.mock.calls[0][0].where.id).toEqual({ in: ['e1'] });
  });
});
