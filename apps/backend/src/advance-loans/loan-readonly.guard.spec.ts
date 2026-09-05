import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { LoanAccessService } from './loan-access.service';
import {
  ALLOW_READ_ONLY_KEY,
  LoanReadOnlyGuard,
  READ_ONLY_REFUSAL,
} from './loan-readonly.guard';

/**
 * Defect §8: `isReadOnly()` existed and had no caller, so `advance_loan_auditor_roles`
 * granted the read half of "read-only auditor" and quietly nothing else — a role
 * that already held write access kept it.
 *
 * These cover the two halves of the fix that are testable without a database:
 * who `isReadOnly()` names, and what the guard does about it.
 */

const AUDITOR_USER = '11111111-1111-1111-1111-111111111111';

/** LoanAccessService over an in-memory settings table. */
function accessWith(settings: Record<string, string>): LoanAccessService {
  return new LoanAccessService({
    getSetting: async (key: string, fallback: string) => settings[key] ?? fallback,
  } as any);
}

describe('LoanAccessService.isReadOnly', () => {
  it('is false for everyone when neither auditor setting is populated', async () => {
    const access = accessWith({});
    expect(await access.isReadOnly({ id: AUDITOR_USER, role: 'HR_MANAGER' })).toBe(false);
    expect(await access.isReadOnly({ id: AUDITOR_USER, role: 'ADMIN' })).toBe(false);
  });

  it('names a role listed in advance_loan_auditor_roles', async () => {
    const access = accessWith({ advance_loan_auditor_roles: 'HR_MANAGER,MANAGER' });
    expect(await access.isReadOnly({ id: 'u1', role: 'HR_MANAGER' })).toBe(true);
    expect(await access.isReadOnly({ id: 'u2', role: 'MANAGER' })).toBe(true);
    // Not listed — untouched.
    expect(await access.isReadOnly({ id: 'u3', role: 'EMPLOYEE' })).toBe(false);
  });

  it('tolerates whitespace and case in the setting', async () => {
    const access = accessWith({ advance_loan_auditor_roles: ' hr_manager , manager ' });
    expect(await access.isReadOnly({ id: 'u1', role: 'HR_MANAGER' })).toBe(true);
  });

  it('does NOT lock ADMIN out through the ROLE list', async () => {
    // The deliberate carve-out: a role-wide grant that swept in ADMIN would
    // otherwise leave nobody in the system able to act on a loan.
    const access = accessWith({ advance_loan_auditor_roles: 'ADMIN,HR_MANAGER' });
    expect(await access.isReadOnly({ id: 'u1', role: 'ADMIN' })).toBe(false);
    expect(await access.isReadOnly({ id: 'u2', role: 'HR_MANAGER' })).toBe(true);
  });

  it('DOES bind an ADMIN named individually in advance_loan_auditor_user_ids', async () => {
    // Naming a UUID is not something anyone does by accident, so the per-user
    // list beats the role — including ADMIN.
    const access = accessWith({ advance_loan_auditor_user_ids: AUDITOR_USER });
    expect(await access.isReadOnly({ id: AUDITOR_USER, role: 'ADMIN' })).toBe(true);
    expect(await access.isReadOnly({ id: 'someone-else', role: 'ADMIN' })).toBe(false);
  });

  it('matches a named user id regardless of case', async () => {
    const access = accessWith({
      advance_loan_auditor_user_ids: AUDITOR_USER.toUpperCase(),
    });
    expect(await access.isReadOnly({ id: AUDITOR_USER, role: 'EMPLOYEE' })).toBe(true);
  });

  it('leaves the READ grant alone — an auditor still sees every loan', async () => {
    const access = accessWith({ advance_loan_auditor_roles: 'MANAGER' });
    expect(await access.canViewAll({ id: 'u1', role: 'MANAGER' })).toBe(true);
    expect(await access.isReadOnly({ id: 'u1', role: 'MANAGER' })).toBe(true);
  });
});

describe('LoanReadOnlyGuard', () => {
  const handler = () => undefined;
  class FakeController {}

  const ctx = (method: string, user: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
      getHandler: () => handler,
      getClass: () => FakeController,
    }) as any;

  /** Reflector stub: `allow` decides whether @AllowReadOnly is on the route. */
  const reflector = (allow = false): any => ({
    getAllAndOverride: (key: string) =>
      key === ALLOW_READ_ONLY_KEY ? allow || undefined : undefined,
  });

  const AUDITOR = { id: 'u1', role: 'HR_MANAGER' };
  const auditorAccess = () =>
    accessWith({ advance_loan_auditor_roles: 'HR_MANAGER' });

  it('lets every read through — the read is what the auditor grant is for', async () => {
    const guard = new LoanReadOnlyGuard(reflector(), auditorAccess());
    await expect(guard.canActivate(ctx('GET', AUDITOR))).resolves.toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses %s for a read-only caller, with the reason spelled out',
    async (method) => {
      const guard = new LoanReadOnlyGuard(reflector(), auditorAccess());
      await expect(guard.canActivate(ctx(method, AUDITOR))).rejects.toThrow(
        ForbiddenException,
      );
      await expect(guard.canActivate(ctx(method, AUDITOR))).rejects.toThrow(
        READ_ONLY_REFUSAL,
      );
    },
  );

  it('leaves a caller who is not an auditor alone', async () => {
    const guard = new LoanReadOnlyGuard(reflector(), auditorAccess());
    await expect(
      guard.canActivate(ctx('POST', { id: 'u2', role: 'ADMIN' })),
    ).resolves.toBe(true);
  });

  it('allows a mutating verb that persists nothing when @AllowReadOnly is set', async () => {
    // POST /advance-loans/eligibility — a what-if question, not a write.
    const guard = new LoanReadOnlyGuard(reflector(true), auditorAccess());
    await expect(guard.canActivate(ctx('POST', AUDITOR))).resolves.toBe(true);
  });

  it('defers to JwtAuthGuard when there is no user — 401 is the right answer, not 403', async () => {
    const guard = new LoanReadOnlyGuard(reflector(), auditorAccess());
    await expect(guard.canActivate(ctx('POST', undefined))).resolves.toBe(true);
  });

  it('refuses an ADMIN named individually in the per-user auditor list', async () => {
    const guard = new LoanReadOnlyGuard(
      reflector(),
      accessWith({ advance_loan_auditor_user_ids: AUDITOR_USER }),
    );
    await expect(
      guard.canActivate(ctx('POST', { id: AUDITOR_USER, role: 'ADMIN' })),
    ).rejects.toThrow(READ_ONLY_REFUSAL);
  });

  it('does not refuse an ADMIN swept into the auditor ROLE list', async () => {
    const guard = new LoanReadOnlyGuard(
      reflector(),
      accessWith({ advance_loan_auditor_roles: 'ADMIN' }),
    );
    await expect(
      guard.canActivate(ctx('POST', { id: 'u9', role: 'ADMIN' })),
    ).resolves.toBe(true);
  });
});
