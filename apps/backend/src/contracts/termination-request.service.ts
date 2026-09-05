import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ContractStatus,
  EmployeeStatus,
  Prisma,
  RequestStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import { CreateTerminationDto } from './dto/create-termination.dto';
import { ListTerminationsDto } from './dto/list-terminations.dto';
import {
  ReviewTerminationDto,
  TerminationReviewAction,
} from './dto/review-termination.dto';

const TERMINATION_INCLUDE = {
  contract: {
    select: {
      id: true,
      contractNumber: true,
      contractType: true,
      status: true,
      startDate: true,
      endDate: true,
      employee: {
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          position: true,
          department: { select: { id: true, name: true } },
        },
      },
    },
  },
  requestedBy: { select: { id: true, email: true } },
  reviewedBy: { select: { id: true, email: true } },
} satisfies Prisma.TerminationRequestInclude;

@Injectable()
export class TerminationRequestService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListTerminationsDto) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.TerminationRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.contractId ? { contractId: query.contractId } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.terminationRequest.findMany({
        where,
        include: TERMINATION_INCLUDE,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.terminationRequest.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  async create(dto: CreateTerminationDto, requestedById: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: dto.contractId },
      select: { id: true, status: true },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    if (contract.status === ContractStatus.TERMINATED) {
      throw new BadRequestException(
        'This contract has already been terminated',
      );
    }

    // One live request per contract. Two pending requests would race each
    // other through the review step and the second approval would rewrite an
    // exit date that has already been acted on by payroll.
    const pending = await this.prisma.terminationRequest.findFirst({
      where: { contractId: dto.contractId, status: RequestStatus.PENDING },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictException(
        'A termination request for this contract is already awaiting review',
      );
    }

    const noticeDate = new Date(dto.noticeDate);
    const terminationDate = new Date(dto.terminationDate);
    if (terminationDate < noticeDate) {
      throw new BadRequestException(
        'The termination date cannot fall before the notice date',
      );
    }

    return this.prisma.terminationRequest.create({
      data: {
        contractId: dto.contractId,
        category: dto.category,
        reason: dto.reason,
        noticeServed: dto.noticeServed,
        noticeDate,
        terminationDate,
        requestedById,
      },
      include: TERMINATION_INCLUDE,
    });
  }

  /**
   * The only place employment actually ends.
   *
   * While a request is merely PENDING the employee record is deliberately left
   * alone: the person is still employed, still on the payroll run, still
   * counted in headcount, and a request that gets rejected must leave no trace
   * on them at all. Writing the exit date at request time and reversing it on
   * rejection would mean any report taken in between reads an exit that never
   * happened.
   *
   * On approval the three writes go together — the request, the contract and
   * the employee. Any one of them landing alone leaves the workforce reports
   * disagreeing with the contract register about who still works here.
   */
  async review(id: string, dto: ReviewTerminationDto, reviewedById: string) {
    const request = await this.prisma.terminationRequest.findUnique({
      where: { id },
      include: { contract: { select: { id: true, employeeId: true } } },
    });
    if (!request) throw new NotFoundException('Termination request not found');

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `This request was already ${request.status.toLowerCase()}`,
      );
    }

    const stamp = {
      reviewedById,
      reviewedAt: new Date(),
      reviewNote: dto.reviewNote ?? null,
    };

    if (dto.action === TerminationReviewAction.REJECT) {
      return this.prisma.terminationRequest.update({
        where: { id },
        data: { ...stamp, status: RequestStatus.REJECTED },
        include: TERMINATION_INCLUDE,
      });
    }

    const [reviewed] = await this.prisma.$transaction([
      this.prisma.terminationRequest.update({
        where: { id },
        data: { ...stamp, status: RequestStatus.APPROVED },
        include: TERMINATION_INCLUDE,
      }),
      this.prisma.contract.update({
        where: { id: request.contractId },
        data: { status: ContractStatus.TERMINATED },
      }),
      this.prisma.employee.update({
        where: { id: request.contract.employeeId },
        data: {
          status: EmployeeStatus.TERMINATED,
          exitDate: request.terminationDate,
        },
      }),
    ]);

    return reviewed;
  }
}
