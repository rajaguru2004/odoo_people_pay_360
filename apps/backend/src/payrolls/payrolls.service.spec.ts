import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PayrollRunStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';
import { PayrollsService } from './payrolls.service';

const AISHA = '11111111-1111-4111-8111-111111111111';
const KHALID = '22222222-2222-4222-8222-222222222222';

const prismaMock = () => ({
  payslip: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  salaryStructure: { findUnique: jest.fn() },
});

type PrismaMock = ReturnType<typeof prismaMock>;

/** The `where` a mocked Prisma call received, typed for the assertion. */
interface PayslipWhere {
  employeeId?: string;
  payrollRun?: {
    status?: { in: PayrollRunStatus[] };
    periodStart?: unknown;
  };
}

function whereOf(mock: jest.Mock, call = 0): PayslipWhere {
  const args = mock.mock.calls as Array<[{ where: PayslipWhere }]>;
  return args[call][0].where;
}

function principal(role: UserRole, employeeId: string | null): Principal {
  return {
    id: 'user-1',
    email: 'someone@peoplepay360.com',
    role,
    employeeId,
    departmentId: null,
    branchId: null,
  };
}

/** A published payslip for August 2026, with one line of each kind. */
function payslipRow(employeeId = AISHA) {
  return {
    id: 'payslip-1',
    payrollRunId: 'run-1',
    employeeId,
    grossPay: 1000,
    totalDeductions: 42,
    netPay: 958,
    createdAt: new Date('2026-08-31T00:00:00.000Z'),
    updatedAt: new Date('2026-08-31T00:00:00.000Z'),
    payrollRun: {
      id: 'run-1',
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-31T00:00:00.000Z'),
      status: PayrollRunStatus.PAID,
      currency: 'OMR',
      approvedAt: new Date('2026-08-31T00:00:00.000Z'),
    },
    employee: {
      id: employeeId,
      employeeCode: 'EMP-0001',
      firstName: 'Aisha',
      lastName: 'Al Balushi',
      position: 'Chief Executive Officer',
      avatarUrl: null,
      department: { id: 'dep-1', name: 'Executive' },
      branch: { id: 'br-1', code: 'HQ', name: 'Head Office' },
    },
    lines: [
      {
        id: 'l1',
        componentId: 'c1',
        label: 'Basic Salary',
        type: 'EARNING',
        amount: 1000,
        sequence: 10,
      },
      {
        id: 'l2',
        componentId: 'c2',
        label: 'Social Security',
        type: 'DEDUCTION',
        amount: 42,
        sequence: 110,
      },
      {
        id: 'l3',
        componentId: 'c3',
        label: 'Social Security (Employer)',
        type: 'EMPLOYER_CONTRIBUTION',
        amount: 69,
        sequence: 210,
      },
    ],
  };
}

describe('PayrollsService', () => {
  let prisma: PrismaMock;
  let service: PayrollsService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new PayrollsService(prisma as unknown as PrismaService);
    prisma.payslip.findMany.mockResolvedValue([payslipRow()]);
    prisma.payslip.findFirst.mockResolvedValue(payslipRow());
    prisma.salaryStructure.findUnique.mockResolvedValue(null);
  });

  describe('who may read a payslip', () => {
    it("lets an employee open their own period's payslip", async () => {
      const slip = await service.findForPeriod(
        principal(UserRole.EMPLOYEE, AISHA),
        AISHA,
        8,
        2026,
      );

      expect(slip.employee?.fullName).toBe('Aisha Al Balushi');
      expect(slip.month).toBe(8);
      expect(slip.year).toBe(2026);
    });

    it("refuses an employee asking for a colleague's payslip", async () => {
      await expect(
        service.findForPeriod(
          principal(UserRole.EMPLOYEE, KHALID),
          AISHA,
          8,
          2026,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Refused before the query, not after it — a check that runs on the way
      // back has already read the row it is meant to be protecting.
      expect(prisma.payslip.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a MANAGER, who has no business reading pay', async () => {
      // Deliberately narrower than the management set the attendance module
      // uses. When somebody arrived is an operational fact; what they are paid
      // is not.
      await expect(
        service.findForPeriod(
          principal(UserRole.MANAGER, KHALID),
          AISHA,
          8,
          2026,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER])(
      'lets %s read anybody',
      async (role) => {
        await expect(
          service.findForPeriod(principal(role, null), AISHA, 8, 2026),
        ).resolves.toMatchObject({ employeeId: AISHA });
      },
    );

    it('narrows an employee to published runs and leaves the payroll office unfiltered', async () => {
      await service.findForPeriod(
        principal(UserRole.EMPLOYEE, AISHA),
        AISHA,
        8,
        2026,
      );
      expect(
        whereOf(prisma.payslip.findFirst, 0).payrollRun?.status?.in,
      ).toEqual([PayrollRunStatus.APPROVED, PayrollRunStatus.PAID]);

      await service.findForPeriod(
        principal(UserRole.PAYROLL_OFFICER, null),
        AISHA,
        8,
        2026,
      );
      expect(
        whereOf(prisma.payslip.findFirst, 1).payrollRun?.status,
      ).toBeUndefined();
    });

    it('serves nothing to a user with no employee record rather than failing', async () => {
      await expect(
        service.findMine(principal(UserRole.ADMIN, null)),
      ).resolves.toEqual([]);
      expect(prisma.payslip.findMany).not.toHaveBeenCalled();

      await expect(
        service.findMineById(principal(UserRole.ADMIN, null), 'payslip-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('only ever queries the caller for the self-service list', async () => {
      await service.findMine(principal(UserRole.EMPLOYEE, KHALID));

      const where = whereOf(prisma.payslip.findMany);
      expect(where.employeeId).toBe(KHALID);
      expect(where.payrollRun?.status?.in).toEqual([
        PayrollRunStatus.APPROVED,
        PayrollRunStatus.PAID,
      ]);
    });
  });

  describe('the figures on a payslip', () => {
    it('totals the lines by type and leaves the stored gross and net alone', async () => {
      const slip = await service.findMineById(
        principal(UserRole.EMPLOYEE, AISHA),
        'payslip-1',
      );

      expect(slip.totals).toEqual({
        earnings: 1000,
        deductions: 42,
        employerContributions: 69,
        net: 958,
      });
      // The stored columns are what payroll wrote. They are reported as they
      // stand, so a discrepancy with the lines is visible rather than papered
      // over by recomputing on read.
      expect(slip.grossPay).toBe(1000);
      expect(slip.netPay).toBe(958);
    });

    it('counts only paid runs toward year to date', async () => {
      const ytd = await service.ytdSummary(
        principal(UserRole.EMPLOYEE, AISHA),
        2026,
      );

      expect(ytd).toMatchObject({
        year: 2026,
        monthsCount: 1,
        totalGross: 1000,
        totalDeductions: 42,
        totalNet: 958,
        currency: 'OMR',
      });
      expect(ytd.monthlyBreakdown).toEqual([
        { month: 8, gross: 1000, deductions: 42, net: 958 },
      ]);
      expect(whereOf(prisma.payslip.findMany).payrollRun?.status?.in).toEqual([
        PayrollRunStatus.PAID,
      ]);
    });

    it('reads a period off its first day in UTC, not the server zone', async () => {
      // A period starting 1 January is the January period everywhere. Read in a
      // zone west of Greenwich it would otherwise file as the previous December.
      const january = payslipRow();
      january.payrollRun.periodStart = new Date('2026-01-01T00:00:00.000Z');
      january.payrollRun.periodEnd = new Date('2026-01-31T00:00:00.000Z');
      prisma.payslip.findMany.mockResolvedValue([january]);

      const [row] = await service.findMine(principal(UserRole.EMPLOYEE, AISHA));

      expect(row).toMatchObject({ month: 1, year: 2026 });
    });
  });

  describe('the salary structure', () => {
    it('applies the same self-or-privileged rule', async () => {
      await expect(
        service.salaryStructure(principal(UserRole.EMPLOYEE, KHALID), AISHA),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('says so plainly when nobody has set one', async () => {
      await expect(
        service.salaryStructure(principal(UserRole.EMPLOYEE, AISHA), AISHA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
