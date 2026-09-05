import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';
import { PayslipsService } from './payslips.service';

const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

const principal = (
  role: UserRole,
  employeeId: string | null = null,
): Principal => ({
  id: `u-${role}`,
  email: `${role}@example.com`,
  role,
  employeeId,
  departmentId: null,
  branchId: null,
});

const payslip = (overrides: Record<string, unknown> = {}) => ({
  id: 'ps-1',
  employeeId: 'e1',
  payslipNumber: 'PS-2026-08-0001',
  grossPay: 1000,
  totalDeductions: 70,
  netPay: 930,
  totalEmployerCost: 105,
  lines: [],
  employee: { id: 'e1', employeeCode: 'EMP001' },
  payrollRun: {
    id: 'run-1',
    periodStart: day('2026-08-01'),
    periodEnd: day('2026-08-31'),
    status: 'APPROVED',
    currency: 'OMR',
  },
  ...overrides,
});

/** The shape of the `where` the service builds for a self-service read. */
interface PayslipWhere {
  employeeId?: string;
  payrollRun?: { status?: { in?: string[] } };
}

function build(row: Record<string, unknown> | null = payslip()) {
  const findFirst = jest.fn(() => Promise.resolve(row));
  const findMany = jest.fn((args: { where: PayslipWhere }) => {
    void args;
    return Promise.resolve(row ? [row] : []);
  });
  const prisma = {
    payslip: {
      findUnique: jest.fn(() => Promise.resolve(row)),
      findFirst,
      findMany,
      count: jest.fn(() => Promise.resolve(row ? 1 : 0)),
    },
  } as unknown as PrismaService;
  return { service: new PayslipsService(prisma), prisma, findFirst, findMany };
}

describe('self-service', () => {
  it('reads only settled runs', async () => {
    const { service, findMany } = build();
    await service.findMine(principal(UserRole.EMPLOYEE, 'e1'), {});
    const where = findMany.mock.calls[0][0].where;
    expect(where.employeeId).toBe('e1');
    // A draft figure is still being corrected; an employee who reads one and
    // then reads a different approved figure has been told two things.
    expect(where.payrollRun?.status?.in).toEqual(['APPROVED', 'PAID']);
  });

  it('refuses an account with no employee record', async () => {
    const { service } = build();
    await expect(
      service.findMine(principal(UserRole.EMPLOYEE, null), {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it('answers 404, not 403, for somebody else’s id', async () => {
    // A 403 would confirm the id exists.
    const { service } = build(null);
    await expect(
      service.findMineOne('ps-other', principal(UserRole.EMPLOYEE, 'e1')),
    ).rejects.toThrow(NotFoundException);
  });

  it('formats the period label on the server', async () => {
    const { service } = build();
    const result = await service.findMineOne(
      'ps-1',
      principal(UserRole.EMPLOYEE, 'e1'),
    );
    expect(result.data.payrollRun.periodLabel).toBe('Aug 2026');
    expect(result.data.payrollRun.periodStart).toBe('2026-08-01');
  });
});

describe('findOne', () => {
  it('lets an employee read their own payslip', async () => {
    const { service } = build();
    const result = await service.findOne(
      'ps-1',
      principal(UserRole.EMPLOYEE, 'e1'),
    );
    expect(result.data.id).toBe('ps-1');
  });

  it('refuses an employee another employee’s payslip', async () => {
    const { service } = build();
    await expect(
      service.findOne('ps-1', principal(UserRole.EMPLOYEE, 'e2')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('hides a draft run’s payslip from its own employee', async () => {
    const { service } = build(
      payslip({
        payrollRun: {
          id: 'run-1',
          periodStart: day('2026-08-01'),
          periodEnd: day('2026-08-31'),
          status: 'CALCULATED',
          currency: 'OMR',
        },
      }),
    );
    await expect(
      service.findOne('ps-1', principal(UserRole.EMPLOYEE, 'e1')),
    ).rejects.toThrow(NotFoundException);
  });

  it('lets a payroll role read anybody’s, draft or not', async () => {
    const { service } = build(
      payslip({
        payrollRun: {
          id: 'run-1',
          periodStart: day('2026-08-01'),
          periodEnd: day('2026-08-31'),
          status: 'CALCULATED',
          currency: 'OMR',
        },
      }),
    );
    for (const role of [
      UserRole.ADMIN,
      UserRole.HR_MANAGER,
      UserRole.PAYROLL_OFFICER,
    ]) {
      const result = await service.findOne('ps-1', principal(role));
      expect(result.data.id).toBe('ps-1');
    }
  });

  it('refuses a manager somebody else’s payslip', async () => {
    // The workforce-wide payroll views answer by name; a manager is not on the
    // list that may ask them.
    const { service } = build();
    await expect(
      service.findOne('ps-1', principal(UserRole.MANAGER, 'e9')),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('findByEmployee', () => {
  it('narrows against the principal before it reads', async () => {
    const { service } = build();
    await expect(
      service.findByEmployee('e2', principal(UserRole.EMPLOYEE, 'e1'), {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it('hides unsettled runs from an employee asking for their OWN id', async () => {
    // The leak this route had: `assertMayRead` let the employee through, and
    // the list underneath applied no run-status filter — so the same person
    // reading the same month got a draft figure here and an approved one from
    // /payslips/my.
    const { service, findMany } = build();
    await service.findByEmployee('e1', principal(UserRole.EMPLOYEE, 'e1'), {});
    const where = findMany.mock.calls[0][0].where;
    expect(where.payrollRun?.status?.in).toEqual(['APPROVED', 'PAID']);
  });

  it('still shows a payroll role the draft rows', async () => {
    const { service, findMany } = build();
    await service.findByEmployee('e1', principal(UserRole.PAYROLL_OFFICER), {});
    const where = findMany.mock.calls[0][0].where;
    expect(where.payrollRun).toBeUndefined();
  });
});
