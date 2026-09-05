import { NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { GrievancesService } from './grievances.service';
import { PrismaService } from '../prisma/prisma.service';
import { canReadGrievance } from './grievance-visibility.util';

const prismaMock = () => ({
  grievance: { findUnique: jest.fn(), findMany: jest.fn() },
  grievanceEvent: { findMany: jest.fn() },
});

type PrismaMock = ReturnType<typeof prismaMock>;

/** The first argument a mocked Prisma call received, typed for the assertion. */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as T[][])[0][0];
}

/** A confidential case raised by Aisha ABOUT Karim, handled by an HR user. */
const CONFIDENTIAL = {
  id: 'grievance-1',
  employeeId: 'employee-aisha',
  againstEmployeeId: 'employee-karim',
  assignedToId: 'user-hr',
  isConfidential: true,
  status: 'INVESTIGATING',
  employee: {
    id: 'employee-aisha',
    firstName: 'Aisha',
    lastName: 'Al Balushi',
  },
  againstEmployee: {
    id: 'employee-karim',
    firstName: 'Karim',
    lastName: 'Said',
  },
};

const complainant = {
  id: 'user-aisha',
  role: UserRole.EMPLOYEE,
  employeeId: 'employee-aisha',
};
const subject = {
  id: 'user-karim',
  role: UserRole.EMPLOYEE,
  employeeId: 'employee-karim',
};
const handler = { id: 'user-hr', role: UserRole.HR_MANAGER, employeeId: null };
const bystander = {
  id: 'user-other',
  role: UserRole.EMPLOYEE,
  employeeId: 'employee-other',
};

describe('grievance confidentiality', () => {
  describe('canReadGrievance', () => {
    it('lets the complainant and the handler read a confidential case', () => {
      expect(canReadGrievance(CONFIDENTIAL, complainant)).toBe(true);
      expect(canReadGrievance(CONFIDENTIAL, handler)).toBe(true);
    });

    it('never lets the person it is about read it', () => {
      expect(canReadGrievance(CONFIDENTIAL, subject)).toBe(false);
    });

    it('does not let the subject read it even as HR or as the handler', () => {
      const subjectIsHr = {
        ...subject,
        role: UserRole.HR_MANAGER,
        id: 'user-hr',
      };
      expect(canReadGrievance(CONFIDENTIAL, subjectIsHr)).toBe(false);
      const subjectIsAdmin = { ...subject, role: UserRole.ADMIN };
      expect(canReadGrievance(CONFIDENTIAL, subjectIsAdmin)).toBe(false);
    });

    it('keeps an uninvolved employee out', () => {
      expect(canReadGrievance(CONFIDENTIAL, bystander)).toBe(false);
    });
  });

  describe('findOne', () => {
    let prisma: PrismaMock;
    let service: GrievancesService;

    beforeEach(() => {
      prisma = prismaMock();
      service = new GrievancesService(prisma as unknown as PrismaService);
      prisma.grievance.findUnique.mockResolvedValue(CONFIDENTIAL);
      prisma.grievanceEvent.findMany.mockResolvedValue([]);
    });

    it('answers 404 for the subject rather than 403', async () => {
      // Confirming a confidential case exists is itself the disclosure, so the
      // refusal must not distinguish "not yours" from "not there".
      await expect(
        service.findOne('grievance-1', subject),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('hides internal notes from the complainant', async () => {
      await service.findOne('grievance-1', complainant);
      const { where } = firstArg<{ where: Record<string, unknown> }>(
        prisma.grievanceEvent.findMany,
      );
      expect(where).toMatchObject({ isInternal: false });
    });

    it('shows internal notes to the handler', async () => {
      await service.findOne('grievance-1', handler);
      const { where } = firstArg<{ where: Record<string, unknown> }>(
        prisma.grievanceEvent.findMany,
      );
      expect(where).not.toHaveProperty('isInternal');
    });
  });

  describe('findAll', () => {
    it('excludes cases about the caller with an OR, not a NOT', async () => {
      const prisma = prismaMock();
      const service = new GrievancesService(prisma as unknown as PrismaService);
      prisma.grievance.findMany.mockResolvedValue([]);

      await service.findAll({}, handler);

      const { where } = firstArg<{ where: { AND?: unknown[] } }>(
        prisma.grievance.findMany,
      );
      // `NOT: { againstEmployeeId }` evaluates to NULL on the rows that name
      // nobody, so the database drops them — which would hide almost every
      // grievance from the desk. The predicate has to name both cases.
      expect(where.AND).toBeUndefined();
    });

    it('narrows a non-handler to their own cases and excludes ones about them', async () => {
      const prisma = prismaMock();
      const service = new GrievancesService(prisma as unknown as PrismaService);
      prisma.grievance.findMany.mockResolvedValue([]);

      await service.findAll({}, subject);

      const { where } = firstArg<{ where: { AND: unknown[] } }>(
        prisma.grievance.findMany,
      );
      expect(where.AND).toEqual([
        {
          OR: [
            { employeeId: 'employee-karim' },
            { assignedToId: 'user-karim' },
          ],
        },
        {
          OR: [
            { againstEmployeeId: null },
            { againstEmployeeId: { not: 'employee-karim' } },
          ],
        },
      ]);
    });
  });
});
