import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertBranchAssignable } from '../common/branch/branch-scope.util';
import { CreateLoanTypeDto, UpdateLoanTypeDto } from './dto/loan-type.dto';

/**
 * The loan product catalogue.
 *
 * `LoanType` was modelled in full and wired to nothing: no controller, no
 * route, and `loanTypeId` set by no create path — so twenty-five columns of
 * product terms were unreachable and the `loanTypeId` filter on the outstanding
 * report could never match. This service is the missing half.
 *
 * Branch scoping is automatic: `LoanType` is `direct-or-global` in
 * `branch-scope.map.ts`, so reads already carry the `branchId IN (...) OR
 * branchId IS NULL` predicate. Only the *target* branch of a write needs a
 * guard, which is what `assertBranchAssignable` is for.
 */
@Injectable()
export class LoanTypesService {
  constructor(private prisma: PrismaService) {}

  /**
   * `undefined` and `null` are different answers on an update: `undefined`
   * means "leave it alone", `null` means "clear this ceiling". Prisma treats a
   * `null` in `data` as a real write, so both survive round-tripping — this
   * exists so a caller can *remove* a maxAmount, which is otherwise impossible.
   */
  private scalarData(dto: Partial<CreateLoanTypeDto>): Prisma.LoanTypeUncheckedUpdateInput {
    const data: Record<string, unknown> = {};
    const copy = <K extends keyof CreateLoanTypeDto>(key: K) => {
      if (dto[key] !== undefined) data[key as string] = dto[key];
    };

    (
      [
        'name',
        'category',
        'branchId',
        'isActive',
        'sortOrder',
        'interestMethod',
        'interestRate',
        'deductionFrequency',
        'defaultInstallments',
        'maxInstallments',
        'processingFeePercent',
        'processingFeeFlat',
        'processingFeeMode',
        'employerSubsidyPercent',
        'gracePeriods',
        'graceMode',
        'maxAmount',
        'maxMultipleOfSalary',
        'minServiceMonths',
        'maxActiveLoans',
        'minNetSalaryAfterEmi',
        'maxEmiPercentOfNet',
        'minEmiAmount',
        'requiresSecurity',
        'eligiblePositions',
        'eligibleEmploymentTypes',
        'priority',
        'pauseOnUnpaidLeave',
        'allowPrepayment',
        'allowWriteOff',
      ] as (keyof CreateLoanTypeDto)[]
    ).forEach(copy);

    return data as Prisma.LoanTypeUncheckedUpdateInput;
  }

  /**
   * Cross-field rules the columns cannot express.
   *
   * `merged` is the state the row will be IN after the write, not the patch —
   * checking the patch alone would let an update lower `maxInstallments` below
   * a `defaultInstallments` it is not itself changing, and the product would
   * then default every request to a term it immediately refuses.
   */
  private assertCoherent(merged: {
    interestMethod?: string | null;
    interestRate?: unknown;
    defaultInstallments?: number | null;
    maxInstallments?: number | null;
    category?: string | null;
    graceMode?: string | null;
    gracePeriods?: number | null;
  }): void {
    const rate = Number(merged.interestRate ?? 0);
    const method = merged.interestMethod ?? 'NONE';
    if (method === 'NONE' && rate > 0) {
      throw new BadRequestException(
        'An interest rate was given but the interest method is NONE — either choose FLAT or REDUCING_BALANCE, or set the rate to 0.',
      );
    }
    if (method !== 'NONE' && rate === 0) {
      throw new BadRequestException(
        `Interest method ${method} needs a rate above 0, otherwise the product is interest-free and should use NONE.`,
      );
    }

    const def = merged.defaultInstallments ?? 1;
    const max = merged.maxInstallments ?? def;
    if (def > max) {
      throw new BadRequestException(
        `The default repayment period (${def}) is longer than this product allows (${max}).`,
      );
    }

    // A salary advance is recovered in a single deduction by definition; a
    // multi-instalment ADVANCE product would generate a schedule the advance
    // flow never reads.
    if (merged.category === 'ADVANCE' && max > 1) {
      throw new BadRequestException(
        'A salary advance is recovered in one deduction, so an ADVANCE product cannot allow more than 1 instalment.',
      );
    }

    const graceMode = merged.graceMode ?? 'NONE';
    const gracePeriods = merged.gracePeriods ?? 0;
    if (graceMode !== 'NONE' && gracePeriods === 0) {
      throw new BadRequestException(
        `Grace mode ${graceMode} needs at least one grace period, otherwise it changes nothing.`,
      );
    }
    if (graceMode === 'NONE' && gracePeriods > 0) {
      throw new BadRequestException(
        'Grace periods were given but the grace mode is NONE — choose MORATORIUM_FULL or MORATORIUM_INTEREST_ONLY.',
      );
    }
  }

  async findAll(includeInactive = false) {
    return this.prisma.loanType.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { branch: { select: { id: true, code: true, name: true } } },
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.loanType.findFirst({
      where: { id },
      include: { branch: { select: { id: true, code: true, name: true } } },
    });
    // `findFirst`, not `findUnique`: only the former carries the branch
    // predicate, so a product from another branch reads as absent rather than
    // as forbidden.
    if (!row) throw new NotFoundException('Loan product not found');
    return row;
  }

  async create(dto: CreateLoanTypeDto) {
    if (dto.branchId) assertBranchAssignable(dto.branchId);

    this.assertCoherent({
      interestMethod: dto.interestMethod ?? 'NONE',
      interestRate: dto.interestRate ?? 0,
      defaultInstallments: dto.defaultInstallments ?? 12,
      maxInstallments: dto.maxInstallments ?? 24,
      category: dto.category ?? 'LOAN',
      graceMode: dto.graceMode ?? 'NONE',
      gracePeriods: dto.gracePeriods ?? 0,
    });

    try {
      return await this.prisma.loanType.create({
        data: { ...(this.scalarData(dto) as object), code: dto.code } as Prisma.LoanTypeUncheckedCreateInput,
        include: { branch: { select: { id: true, code: true, name: true } } },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `A loan product with the code ${dto.code} already exists.`,
        );
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateLoanTypeDto) {
    const existing = await this.findOne(id);
    if (dto.branchId) assertBranchAssignable(dto.branchId);

    this.assertCoherent({
      interestMethod: dto.interestMethod ?? existing.interestMethod,
      interestRate: dto.interestRate ?? Number(existing.interestRate),
      defaultInstallments: dto.defaultInstallments ?? existing.defaultInstallments,
      maxInstallments: dto.maxInstallments ?? existing.maxInstallments,
      category: dto.category ?? existing.category,
      graceMode: dto.graceMode ?? existing.graceMode,
      gracePeriods: dto.gracePeriods ?? existing.gracePeriods,
    });

    return this.prisma.loanType.update({
      where: { id },
      data: this.scalarData(dto),
      include: { branch: { select: { id: true, code: true, name: true } } },
    });
  }

  /**
   * Deactivation, not deletion, is the ordinary retirement path: live loans
   * carry `loanTypeId` with `onDelete: Restrict`, and their terms were
   * snapshotted at approval, so the product row exists to explain history.
   */
  async setActive(id: string, isActive: boolean) {
    await this.findOne(id);
    return this.prisma.loanType.update({ where: { id }, data: { isActive } });
  }

  /**
   * Hard delete, allowed only for a product nothing has ever used — otherwise
   * the FK would refuse with a driver error and the caller would learn nothing.
   */
  async remove(id: string) {
    await this.findOne(id);

    // Counted with a RAW query on purpose.
    //
    // `prisma.advanceLoanRequest.count()` goes through the branch-scoping
    // middleware, so an admin narrowed to one branch counted only that
    // branch's loans — a product referenced from a DIFFERENT branch looked
    // unused, the guard passed, and the delete then hit the `onDelete:
    // Restrict` foreign key and surfaced as a raw driver error. Referential
    // integrity is not a per-branch question: the FK is global, so the check
    // that stands in front of it has to be too.
    const [{ count }] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM advance_loan_requests
      WHERE loan_type_id = ${id}::uuid
    `;
    const inUse = Number(count);
    if (inUse > 0) {
      throw new ConflictException(
        `This product cannot be deleted: ${inUse} loan${inUse === 1 ? '' : 's'} still reference it. Deactivate it instead — the terms on those loans were snapshotted at approval and the product row is what explains them.`,
      );
    }
    await this.prisma.loanType.delete({ where: { id } });
    return { success: true };
  }
}
