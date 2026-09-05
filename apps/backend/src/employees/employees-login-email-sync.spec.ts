import { ConflictException } from '@nestjs/common';
import { EmployeesService } from './employees.service';
// `update` requires an actor with no default — see the note in
// employees-pay-basis.spec.ts. Nothing here is field-permission work.
import { SYSTEM_ACTOR } from '../common/utils/self-service.util';

/**
 * The employee's address and the address they log in with are ONE thing.
 *
 * `employees.email` is what every mail is sent to — the welcome mail and
 * "Resend Credentials". `users.email` is what `AuthService.login` looks up.
 * `update()` wrote the first and never the second, so editing an employee's
 * email left the login row answering to the old address: the person received a
 * correct temporary password at the new address and was refused with "Email
 * does not exist in the system". Three rows on PROD had drifted this way, one
 * of them a live employee who could not get in at all.
 *
 * What these cases pin:
 *   - a changed email moves the login row, in the SAME transaction
 *   - a clash on either unique column is refused BEFORE anything is written
 *   - `resendWelcomeEmail` heals a row that drifted before the fix, because it
 *     is the exact button an admin presses when someone cannot log in
 */
describe('EmployeesService — employee email and login email stay in sync', () => {
  let prisma: any;
  let mail: any;
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
    email: 'old@trs.com',
    idCard: 'ID1',
    fullName: 'Sathananthavathi',
    employeeCode: 'TRS-FSD-006',
    startDate: new Date('2026-08-24'),
    phone: null as string | null,
    phoneCountryCode: null as string | null,
    department: { id: 'dept-1', code: 'FSD', name: 'Full Stack Development' },
    branch: { country: null as string | null },
    user: { id: 'user-1', email: 'old@trs.com' },
  };

  const stored = (over: Record<string, any> = {}) => ({ ...STORED, ...over });

  /** Another account already holding an address, or null for a free one. */
  let userByEmail: Record<string, { id: string }> = {};

  beforeEach(() => {
    userByEmail = {};
    prisma = {
      libraryItem: { findUnique: jest.fn().mockResolvedValue(null) },
      employee: {
        // Two callers, one mock: the row lookup keys on id, the uniqueness
        // check keys on email and must answer "free" unless a case says so.
        findUnique: jest.fn().mockImplementation(async ({ where }: any) =>
          where?.email ? null : stored(),
        ),
        update: jest.fn().mockImplementation(async ({ data }: any) => data),
      },
      employeeHistory: { createMany: jest.fn().mockResolvedValue({}) },
      department: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'dept-1', isActive: true, parentId: null }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockImplementation(async ({ where }: any) => userByEmail[where.email] ?? null),
        update: jest.fn().mockImplementation(async ({ data }: any) => data),
        create: jest.fn().mockImplementation(async ({ data }: any) => data),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (arg: any) =>
          typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
        ),
    };

    mail = { sendWelcomeEmail: jest.fn().mockResolvedValue(undefined) };

    service = new EmployeesService(
      prisma,
      {} as any,
      mail as any,
      {} as any,
      {} as any,
      { assertCleared: jest.fn().mockResolvedValue(undefined) } as any,
      // WhatsApp outbox / settings — the resend also messages the employee, but
      // it is fire-and-forget and disabled here so nothing races the assertions.
      { enqueueDirect: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue({ enabled: false }) } as any,
      { resolve: jest.fn().mockResolvedValue({ enabled: false, fields: [] }) } as any,
      {
        assign: jest.fn().mockResolvedValue(undefined),
        unassign: jest.fn().mockResolvedValue(undefined),
      } as any,
      { markOutstandingAsReceivable: jest.fn().mockResolvedValue(0) } as any,
    );
  });

  const update = (dto: any, current: Record<string, any> = {}) => {
    prisma.employee.findUnique.mockImplementation(async ({ where }: any) =>
      where?.email ? null : stored(current),
    );
    return service.update('emp-1', dto as any, 'actor-1', SYSTEM_ACTOR);
  };

  /** The data written to the login row, or undefined if it was never touched. */
  const userWrite = () => prisma.user.update.mock.calls[0]?.[0];

  // ───────────────────────────────────────────────────────────────── update()

  describe('update()', () => {
    it('moves the login row when the employee email changes', async () => {
      await update({ email: 'new@trs.com' });

      expect(prisma.employee.update.mock.calls[0][0].data.email).toBe('new@trs.com');
      expect(userWrite()).toEqual({
        where: { id: 'user-1' },
        data: { email: 'new@trs.com' },
      });
    });

    it('writes both rows in ONE transaction', async () => {
      await update({ email: 'new@trs.com' });

      // The array handed to $transaction carries the employee update, and the
      // user update rides along in it — not in a second, unprotected call.
      const [batch] = prisma.$transaction.mock.calls[0];
      expect(Array.isArray(batch)).toBe(true);
      expect(batch).toHaveLength(2);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('leaves the login row alone when the email is unchanged', async () => {
      await update({ position: 'Senior Fitter' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('leaves the login row alone when the same email is re-sent', async () => {
      await update({ email: 'old@trs.com' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('heals a row that drifted before this fix', async () => {
      // employees.email was edited while users.email stayed behind — the exact
      // PROD state. Re-saving the employee with the address they already have
      // must still pull the login row across.
      await update(
        { email: 'new@trs.com' },
        { email: 'new@trs.com', user: { id: 'user-1', email: 'stale@trs.com' } },
      );

      expect(userWrite().data).toEqual({ email: 'new@trs.com' });
    });

    it('refuses an address another user account already holds', async () => {
      userByEmail['taken@trs.com'] = { id: 'user-2' };

      await expect(update({ email: 'taken@trs.com' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Refused BEFORE the write, or the employee row would save against a
      // login row that then dies on the unique constraint.
      expect(prisma.employee.update).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('does not mistake the employee own login row for a clash', async () => {
      userByEmail['new@trs.com'] = { id: 'user-1' };

      await expect(update({ email: 'new@trs.com' })).resolves.toBeTruthy();
      expect(userWrite().data).toEqual({ email: 'new@trs.com' });
    });

    it('survives an employee with no login row', async () => {
      await expect(
        update({ email: 'new@trs.com' }, { user: null }),
      ).resolves.toBeTruthy();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────── resendWelcomeEmail()

  describe('resendWelcomeEmail()', () => {
    const resend = (current: Record<string, any> = {}) => {
      prisma.employee.findUnique.mockImplementation(async ({ where }: any) =>
        where?.email ? null : stored(current),
      );
      return service.resendWelcomeEmail('emp-1');
    };

    it('pulls a drifted login row onto the address the mail goes to', async () => {
      await resend({
        email: 'new@trs.com',
        user: { id: 'user-1', email: 'stale@trs.com' },
      });

      expect(userWrite().data.email).toBe('new@trs.com');
      expect(userWrite().data.passwordHash).toEqual(expect.any(String));
      expect(userWrite().data.isActive).toBe(true);
      // The password in the mail must belong to the account that now answers to
      // that address — same address, one credential.
      expect(mail.sendWelcomeEmail).toHaveBeenCalledWith(
        'new@trs.com',
        expect.objectContaining({ email: 'new@trs.com' }),
      );
    });

    it('refuses rather than stealing an address from another account', async () => {
      userByEmail['new@trs.com'] = { id: 'user-2' };

      await expect(
        resend({ email: 'new@trs.com', user: { id: 'user-1', email: 'stale@trs.com' } }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(mail.sendWelcomeEmail).not.toHaveBeenCalled();
    });

    it('still resets the password when nothing drifted', async () => {
      await resend();

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(userWrite().data.email).toBe('old@trs.com');
      expect(userWrite().data.passwordHash).toEqual(expect.any(String));
    });

    it('creates the login row when the employee never had one', async () => {
      await resend({ user: null });

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'old@trs.com', employeeId: 'emp-1' }),
        }),
      );
    });
  });
});
