import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertBranchAssignable } from '../common/branch/branch-scope.util';
import { LoanPolicyService } from './loan-policy.service';
import { UpsertLoanPolicyDto } from './dto/loan-policy.dto';

/**
 * CRUD over the branch level of the loan policy chain.
 *
 * Kept separate from `LoanPolicyService`, which RESOLVES the chain and is
 * consumed by payroll on every run: resolution is hot and must stay free of
 * write concerns.
 *
 * Branch scoping is automatic — `LoanPolicy` is `direct-or-global` in
 * `branch-scope.map.ts`, so a scoped caller reads their own branch's row plus
 * the company-wide one, which is exactly the pair they need to understand what
 * applies to them.
 */
@Injectable()
export class LoanPoliciesService {
  constructor(
    private prisma: PrismaService,
    private resolver: LoanPolicyService,
  ) {}

  async findAll() {
    return this.prisma.loanPolicy.findMany({
      // Global first: it is the fallback every branch row is read against, so
      // it belongs at the top of the list rather than sorted among the branches.
      orderBy: [{ branchId: 'asc' }],
      include: { branch: { select: { id: true, code: true, name: true } } },
    });
  }

  /** What the engine will actually use for this branch. */
  async effective(branchId: string | null) {
    const resolved = await this.resolver.resolve(branchId);
    const row = await this.prisma.loanPolicy.findFirst({ where: { branchId } });
    return {
      branchId,
      /** The stored row, which is mostly nulls by design. */
      policy: row,
      /** The answer after branch → global → setting → default. */
      effective: resolved,
    };
  }

  async upsert(dto: UpsertLoanPolicyDto) {
    const branchId = dto.branchId ?? null;
    if (branchId) assertBranchAssignable(branchId);

    const { branchId: _ignored, ...fields } = dto;
    const data: Record<string, unknown> = {};
    // `undefined` means "leave it alone"; `null` means "stop overriding this
    // and defer to the company rules". Both have to survive, which is why the
    // fields are copied explicitly rather than spread.
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) data[key] = value;
    }

    // NOT `prisma.upsert`. `branchId` is a NULLABLE unique, and Postgres does
    // not treat two NULLs as equal, so `where: { branchId: null }` is not a
    // usable unique selector — the global row could never be found and the
    // upsert either threw or inserted a second one. Find-then-write is the
    // only correct shape here, and the unique index still stops a race from
    // producing two rows for the same branch.
    const include = { branch: { select: { id: true, code: true, name: true } } };
    const existing = await this.prisma.loanPolicy.findFirst({ where: { branchId } });

    if (existing) {
      return this.prisma.loanPolicy.update({
        where: { id: existing.id },
        data: data as Prisma.LoanPolicyUncheckedUpdateInput,
        include,
      });
    }

    return this.prisma.loanPolicy.create({
      data: { branchId, ...(data as object) } as Prisma.LoanPolicyUncheckedCreateInput,
      include,
    });
  }

  async remove(id: string) {
    const row = await this.prisma.loanPolicy.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Loan policy not found');
    await this.prisma.loanPolicy.delete({ where: { id } });
    return { success: true };
  }
}
