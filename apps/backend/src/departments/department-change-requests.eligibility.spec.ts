import { DepartmentChangeRequestsService } from './department-change-requests.service';

/**
 * checkManagerEligibility() used to reject any candidate already heading another
 * active department ("Already managing <name>"). With multi-department managers
 * that check is removed; ACTIVE status and tenure remain.
 */
describe('DepartmentChangeRequestsService.checkManagerEligibility', () => {
  const build = (employee: any, minTenureMonths = '6') => {
    const prisma = {
      employee: { findUnique: jest.fn().mockResolvedValue(employee) },
    };
    const mail = {};
    const settings = { getSetting: jest.fn().mockResolvedValue(minTenureMonths) };
    // The service delegates a parent change to DepartmentsService so the
    // hierarchy rules re-run at approval time; eligibility never touches it.
    const departments = {};
    // In-app notifications (R18). Eligibility never raises one; the stub is
    // here so the constructor arity stays satisfied.
    const notifications = { create: jest.fn() };
    const service = new DepartmentChangeRequestsService(
      prisma as any,
      mail as any,
      settings as any,
      departments as any,
      notifications as any,
    );
    return { service, prisma, settings };
  };

  const tenuredActiveEmployee = {
    id: 'emp-1',
    status: 'ACTIVE',
    startDate: new Date('2000-01-01'),
    user: { id: 'user-1', role: 'MANAGER' },
  };

  it('is eligible even though the employee already heads another department', async () => {
    const { service } = build(tenuredActiveEmployee);

    const result = await (service as any).checkManagerEligibility(
      'emp-1',
      'dept-b',
    );

    expect(result.eligible).toBe(true);
    expect(result.reasons).not.toContain(
      expect.stringContaining('Already managing'),
    );
  });

  it('still rejects a non-ACTIVE employee', async () => {
    const { service } = build({ ...tenuredActiveEmployee, status: 'INACTIVE' });

    const result = await (service as any).checkManagerEligibility(
      'emp-1',
      'dept-b',
      true,
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('Employee must be ACTIVE');
  });

  it('still enforces minimum tenure', async () => {
    const freshHire = {
      ...tenuredActiveEmployee,
      startDate: new Date(), // 0 months tenure
    };
    const { service } = build(freshHire, '6');

    const result = await (service as any).checkManagerEligibility(
      'emp-1',
      'dept-b',
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r: string) => r.includes('tenure'))).toBe(true);
  });
});
