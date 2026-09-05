import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContractStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated, resolvePagination } from '../common/utils/pagination.util';
import { addDays, daysUntil, startOfUtcDay } from '../common/utils/expiry.util';
import { CreateContractDto } from './dto/create-contract.dto';
import { UpdateContractDto } from './dto/update-contract.dto';
import { ListContractsDto } from './dto/list-contracts.dto';
import { RenewContractDto } from './dto/renew-contract.dto';

const CONTRACT_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: true,
      // The employment status travels with the contract because the two can
      // legitimately disagree: a terminated employee keeps their contract row,
      // and a list that cannot say so shows an ACTIVE contract against somebody
      // who left months ago.
      status: true,
      department: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ContractInclude;

@Injectable()
export class ContractsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListContractsDto) {
    const { page, limit, skip, take } = resolvePagination(query);
    const insensitive = Prisma.QueryMode.insensitive;
    const today = startOfUtcDay(new Date());

    const where: Prisma.ContractWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.contractType ? { contractType: query.contractType } : {}),
      ...(query.expiringWithinDays !== undefined
        ? {
            endDate: {
              gte: today,
              lte: addDays(today, query.expiringWithinDays),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { contractNumber: { contains: query.search, mode: insensitive } },
              {
                employee: {
                  employeeCode: { contains: query.search, mode: insensitive },
                },
              },
              {
                employee: {
                  firstName: { contains: query.search, mode: insensitive },
                },
              },
              {
                employee: {
                  lastName: { contains: query.search, mode: insensitive },
                },
              },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.contract.findMany({
        where,
        include: CONTRACT_INCLUDE,
        skip,
        take,
        orderBy: { startDate: 'desc' },
      }),
      this.prisma.contract.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  /**
   * The expiry report.
   *
   * Only ACTIVE contracts: a DRAFT has not started and a RENEWED one has
   * already been replaced, so counting either down to its end date would put
   * work on somebody's desk that has already been done.
   */
  async expiring(days = 30) {
    const today = startOfUtcDay(new Date());
    const rows = await this.prisma.contract.findMany({
      where: {
        status: ContractStatus.ACTIVE,
        endDate: { gte: today, lte: addDays(today, days) },
      },
      include: CONTRACT_INCLUDE,
      orderBy: { endDate: 'asc' },
    });

    return rows
      .filter((row): row is typeof row & { endDate: Date } => !!row.endDate)
      .map((row) => ({ ...row, daysUntilExpiry: daysUntil(row.endDate) }));
  }

  async findOne(id: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id },
      include: {
        ...CONTRACT_INCLUDE,
        terminations: {
          orderBy: { createdAt: 'desc' },
          include: {
            requestedBy: { select: { id: true, email: true } },
            reviewedBy: { select: { id: true, email: true } },
          },
        },
      },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    return contract;
  }

  async create(dto: CreateContractDto) {
    await this.assertEmployeeExists(dto.employeeId);

    const startDate = new Date(dto.startDate);
    const endDate = dto.endDate ? new Date(dto.endDate) : null;
    const probationEndDate = dto.probationEndDate
      ? new Date(dto.probationEndDate)
      : null;
    this.assertTermIsCoherent(startDate, endDate, probationEndDate);

    const contractNumber = await this.resolveContractNumber(
      dto.contractNumber,
      startDate,
    );

    // The converted dates and the resolved number overwrite the DTO's own
    // values, which are ISO strings and an optional.
    return this.prisma.contract.create({
      data: { ...dto, contractNumber, startDate, endDate, probationEndDate },
      include: CONTRACT_INCLUDE,
    });
  }

  async update(id: string, dto: UpdateContractDto) {
    const current = await this.findOne(id);

    // A terminated contract is the record of how somebody's employment ended.
    // Editing it after the fact rewrites that record; a correction belongs in a
    // new contract, and a mistaken termination is reversed by the review flow.
    if (current.status === ContractStatus.TERMINATED) {
      throw new BadRequestException(
        'A terminated contract can no longer be edited',
      );
    }

    const startDate = dto.startDate
      ? new Date(dto.startDate)
      : current.startDate;
    const endDate =
      dto.endDate !== undefined
        ? dto.endDate
          ? new Date(dto.endDate)
          : null
        : current.endDate;
    const probationEndDate =
      dto.probationEndDate !== undefined
        ? dto.probationEndDate
          ? new Date(dto.probationEndDate)
          : null
        : current.probationEndDate;
    this.assertTermIsCoherent(startDate, endDate, probationEndDate);

    if (dto.contractNumber && dto.contractNumber !== current.contractNumber) {
      await this.assertContractNumberFree(dto.contractNumber);
    }

    // `undefined` is Prisma's "leave this column alone", so an untouched date
    // stays put while an explicit null clears the column.
    return this.prisma.contract.update({
      where: { id },
      data: {
        ...dto,
        startDate: dto.startDate ? startDate : undefined,
        endDate: dto.endDate !== undefined ? endDate : undefined,
        probationEndDate:
          dto.probationEndDate !== undefined ? probationEndDate : undefined,
      },
      include: CONTRACT_INCLUDE,
    });
  }

  /**
   * Closes the current contract and opens its successor.
   *
   * Both writes or neither: a contract marked RENEWED with no successor leaves
   * the employee with no live contract at all, and a successor created while
   * the old row is still ACTIVE gives them two — either half on its own is
   * worse than the renewal not happening.
   */
  async renew(id: string, dto: RenewContractDto) {
    const current = await this.findOne(id);

    if (current.status === ContractStatus.TERMINATED)
      throw new BadRequestException('A terminated contract cannot be renewed');
    if (current.status === ContractStatus.RENEWED)
      throw new BadRequestException('This contract has already been renewed');

    const startDate = new Date(dto.startDate);
    const endDate = dto.endDate ? new Date(dto.endDate) : null;
    const probationEndDate = dto.probationEndDate
      ? new Date(dto.probationEndDate)
      : null;
    this.assertTermIsCoherent(startDate, endDate, probationEndDate);

    const contractNumber = await this.resolveContractNumber(
      dto.contractNumber,
      startDate,
    );

    const [, successor] = await this.prisma.$transaction([
      this.prisma.contract.update({
        where: { id },
        data: { status: ContractStatus.RENEWED },
      }),
      this.prisma.contract.create({
        data: {
          employeeId: current.employeeId,
          contractNumber,
          contractType: dto.contractType ?? current.contractType,
          workType: dto.workType ?? current.workType,
          status: ContractStatus.ACTIVE,
          startDate,
          endDate,
          probationEndDate,
          workHoursPerWeek: dto.workHoursPerWeek ?? current.workHoursPerWeek,
          salary: dto.salary ?? current.salary,
          currency: current.currency,
          noticePeriodDays: current.noticePeriodDays,
          annualLeaveDays: current.annualLeaveDays,
          terms: current.terms,
          notes: dto.notes ?? null,
        },
        include: CONTRACT_INCLUDE,
      }),
    ]);

    return successor;
  }

  /**
   * `CTR-<year>-<sequence>`, the sequence being how many contracts already
   * carry that year's prefix. The year comes from the START DATE rather than
   * today: a 2027 contract signed in December 2026 belongs in the 2027 run.
   */
  private async generateContractNumber(startDate: Date): Promise<string> {
    const prefix = `CTR-${startDate.getUTCFullYear()}-`;
    const used = await this.prisma.contract.count({
      where: { contractNumber: { startsWith: prefix } },
    });
    return `${prefix}${String(used + 1).padStart(4, '0')}`;
  }

  private async resolveContractNumber(
    supplied: string | undefined,
    startDate: Date,
  ): Promise<string> {
    if (!supplied) return this.generateContractNumber(startDate);
    await this.assertContractNumberFree(supplied);
    return supplied;
  }

  private async assertContractNumberFree(contractNumber: string) {
    const clash = await this.prisma.contract.findUnique({
      where: { contractNumber },
      select: { id: true },
    });
    if (clash)
      throw new ConflictException(
        `Contract number ${contractNumber} is already in use`,
      );
  }

  private assertTermIsCoherent(
    startDate: Date,
    endDate: Date | null,
    probationEndDate: Date | null,
  ) {
    if (endDate && endDate <= startDate) {
      throw new BadRequestException(
        'The end date must fall after the start date',
      );
    }
    if (probationEndDate) {
      if (probationEndDate < startDate) {
        throw new BadRequestException(
          'Probation cannot end before the contract starts',
        );
      }
      if (endDate && probationEndDate > endDate) {
        throw new BadRequestException(
          'Probation cannot end after the contract does',
        );
      }
    }
  }

  private async assertEmployeeExists(id: string) {
    const found = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Employee not found');
  }
}
