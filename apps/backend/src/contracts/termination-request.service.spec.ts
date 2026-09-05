import { BadRequestException, ConflictException } from '@nestjs/common';
import { TerminationRequestService } from './termination-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { TerminationReviewAction } from './dto/review-termination.dto';

const prismaMock = () => ({
  contract: { findUnique: jest.fn(), update: jest.fn() },
  employee: { update: jest.fn() },
  terminationRequest: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
});

type PrismaMock = ReturnType<typeof prismaMock>;

/** The first argument a mocked Prisma call received, typed for the assertion. */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as T[][])[0][0];
}

const requestDto = {
  contractId: 'contract-1',
  category: 'RESIGNATION' as const,
  noticeDate: '2026-03-01',
  terminationDate: '2026-03-31',
  reason: 'Moving abroad',
};

describe('TerminationRequestService', () => {
  let prisma: PrismaMock;
  let service: TerminationRequestService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new TerminationRequestService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('refuses a second request while one is still awaiting review', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        id: 'contract-1',
        status: 'ACTIVE',
      });
      prisma.terminationRequest.findFirst.mockResolvedValue({
        id: 'request-existing',
      });

      await expect(service.create(requestDto, 'user-1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(prisma.terminationRequest.create).not.toHaveBeenCalled();
    });

    it('records the request without touching the employee', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        id: 'contract-1',
        status: 'ACTIVE',
      });
      prisma.terminationRequest.findFirst.mockResolvedValue(null);
      prisma.terminationRequest.create.mockResolvedValue({ id: 'request-1' });

      await service.create(requestDto, 'user-1');

      expect(
        firstArg<{ data: Record<string, unknown> }>(
          prisma.terminationRequest.create,
        ).data,
      ).toMatchObject({ contractId: 'contract-1', requestedById: 'user-1' });
      expect(prisma.employee.update).not.toHaveBeenCalled();
      expect(prisma.contract.update).not.toHaveBeenCalled();
    });

    it('refuses a termination date before the notice date', async () => {
      prisma.contract.findUnique.mockResolvedValue({
        id: 'contract-1',
        status: 'ACTIVE',
      });
      prisma.terminationRequest.findFirst.mockResolvedValue(null);

      await expect(
        service.create(
          { ...requestDto, terminationDate: '2026-02-01' },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('review', () => {
    const pending = {
      id: 'request-1',
      contractId: 'contract-1',
      status: 'PENDING',
      terminationDate: new Date('2026-03-31'),
      contract: { id: 'contract-1', employeeId: 'employee-1' },
    };

    it('ends the employment in one transaction on approval', async () => {
      prisma.terminationRequest.findUnique.mockResolvedValue(pending);
      prisma.terminationRequest.update.mockResolvedValue({
        ...pending,
        status: 'APPROVED',
      });
      prisma.contract.update.mockResolvedValue({});
      prisma.employee.update.mockResolvedValue({});

      await service.review(
        'request-1',
        { action: TerminationReviewAction.APPROVE },
        'admin-1',
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(firstArg<unknown[]>(prisma.$transaction)).toHaveLength(3);

      const stamped = firstArg<{
        where: { id: string };
        data: Record<string, unknown>;
      }>(prisma.terminationRequest.update);
      expect(stamped.where).toEqual({ id: 'request-1' });
      expect(stamped.data).toMatchObject({
        status: 'APPROVED',
        reviewedById: 'admin-1',
      });
      expect(prisma.contract.update).toHaveBeenCalledWith({
        where: { id: 'contract-1' },
        data: { status: 'TERMINATED' },
      });
      expect(prisma.employee.update).toHaveBeenCalledWith({
        where: { id: 'employee-1' },
        data: { status: 'TERMINATED', exitDate: pending.terminationDate },
      });
    });

    it('leaves the contract and the employee alone on rejection', async () => {
      prisma.terminationRequest.findUnique.mockResolvedValue(pending);
      prisma.terminationRequest.update.mockResolvedValue({
        ...pending,
        status: 'REJECTED',
      });

      await service.review(
        'request-1',
        { action: TerminationReviewAction.REJECT, reviewNote: 'Retained' },
        'admin-1',
      );

      expect(prisma.contract.update).not.toHaveBeenCalled();
      expect(prisma.employee.update).not.toHaveBeenCalled();
    });

    it('refuses to review a request a second time', async () => {
      prisma.terminationRequest.findUnique.mockResolvedValue({
        ...pending,
        status: 'APPROVED',
      });

      await expect(
        service.review(
          'request-1',
          { action: TerminationReviewAction.APPROVE },
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.employee.update).not.toHaveBeenCalled();
    });
  });
});
