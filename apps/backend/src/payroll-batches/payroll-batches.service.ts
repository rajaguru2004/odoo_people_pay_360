import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getBranchContext } from '../common/branch/branch-context';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';

@Injectable()
export class PayrollBatchesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The concrete branch a new batch belongs to, or null when scoping is off. */
  private resolveBatchBranchId(): string | null {
    const ctx = getBranchContext();
    if (!ctx) return null; // branch scoping disabled for this request
    const branchId =
      ctx.effectiveBranchId ??
      (!ctx.isAllBranches && ctx.accessibleBranchIds.length === 1
        ? ctx.accessibleBranchIds[0]
        : null);
    if (!branchId) {
      throw new BadRequestException(
        'Select a specific branch before managing payroll batches — batches are per-branch.',
      );
    }
    return branchId;
  }

  /** Reject employees that don't belong to the batch's branch (scoped count). */
  private async assertEmployeesInBranch(
    tx: Prisma.TransactionClient,
    employeeIds: string[],
    branchId: string | null,
  ): Promise<void> {
    if (!branchId || employeeIds.length === 0) return;
    const inBranch = await tx.employee.count({
      where: { id: { in: employeeIds }, branchId },
    });
    if (inBranch !== employeeIds.length) {
      throw new BadRequestException(
        'One or more selected employees do not belong to the batch branch.',
      );
    }
  }

  async findAll() {
    return this.prisma.payrollBatch.findMany({
      include: {
        _count: {
          select: { members: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const batch = await this.prisma.payrollBatch.findUnique({
      where: { id },
      include: {
        members: {
          include: {
            employee: {
              include: {
                department: true,
              },
            },
          },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException(`Payroll batch with ID ${id} not found`);
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(batch.branchId);

    return batch;
  }

  async create(dto: CreateBatchDto, userId: string) {
    const branchId = this.resolveBatchBranchId();
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.payrollBatch.create({
        data: {
          name: dto.name,
          description: dto.description,
          createdBy: userId,
          branchId,
        },
      });

      if (dto.employeeIds && dto.employeeIds.length > 0) {
        const uniqueEmployeeIds = Array.from(new Set(dto.employeeIds));
        await this.assertEmployeesInBranch(tx, uniqueEmployeeIds, branchId);
        await tx.payrollBatchMember.createMany({
          data: uniqueEmployeeIds.map((employeeId) => ({
            batchId: batch.id,
            employeeId,
          })),
        });
      }

      return tx.payrollBatch.findUnique({
        where: { id: batch.id },
        include: {
          members: {
            include: {
              employee: true,
            },
          },
        },
      });
    });
  }

  async update(id: string, dto: UpdateBatchDto) {
    const batch = await this.prisma.payrollBatch.findUnique({ where: { id } });
    if (!batch) {
      throw new NotFoundException(`Payroll batch with ID ${id} not found`);
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(batch.branchId);

    return this.prisma.$transaction(async (tx) => {
      await tx.payrollBatch.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
        },
      });

      if (dto.employeeIds !== undefined) {
        await tx.payrollBatchMember.deleteMany({
          where: { batchId: id },
        });

        const uniqueEmployeeIds = Array.from(new Set(dto.employeeIds));
        if (uniqueEmployeeIds.length > 0) {
          await this.assertEmployeesInBranch(tx, uniqueEmployeeIds, batch.branchId);
          await tx.payrollBatchMember.createMany({
            data: uniqueEmployeeIds.map((employeeId) => ({
              batchId: id,
              employeeId,
            })),
          });
        }
      }

      return tx.payrollBatch.findUnique({
        where: { id },
        include: {
          members: {
            include: {
              employee: true,
            },
          },
        },
      });
    });
  }

  async remove(id: string) {
    const batch = await this.prisma.payrollBatch.findUnique({ where: { id } });
    if (!batch) {
      throw new NotFoundException(`Payroll batch with ID ${id} not found`);
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(batch.branchId);

    await this.prisma.payrollBatch.delete({ where: { id } });
    return { success: true };
  }

  async addMembers(id: string, employeeIds: string[]) {
    const batch = await this.prisma.payrollBatch.findUnique({ where: { id } });
    if (!batch) {
      throw new NotFoundException(`Payroll batch with ID ${id} not found`);
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(batch.branchId);

    const uniqueEmployeeIds = Array.from(new Set(employeeIds));
    const existingMembers = await this.prisma.payrollBatchMember.findMany({
      where: {
        batchId: id,
        employeeId: { in: uniqueEmployeeIds },
      },
      select: { employeeId: true },
    });

    const existingEmpIds = new Set(existingMembers.map((m) => m.employeeId));
    const newEmpIds = uniqueEmployeeIds.filter((empId) => !existingEmpIds.has(empId));

    if (newEmpIds.length > 0) {
      await this.assertEmployeesInBranch(this.prisma, newEmpIds, batch.branchId);
      await this.prisma.payrollBatchMember.createMany({
        data: newEmpIds.map((employeeId) => ({
          batchId: id,
          employeeId,
        })),
      });
    }

    return this.findOne(id);
  }

  async removeMember(id: string, employeeId: string) {
    // The same object-level guard every sibling handler applies. The `findFirst`
    // below is auto-scoped through PayrollBatchMember's relation rule, so a
    // foreign member was already unreachable — but the batch itself was never
    // checked, so the refusal arrived as "not a member" rather than as a branch
    // decision, and a batch with no members at all leaked its existence.
    const batch = await this.prisma.payrollBatch.findUnique({ where: { id } });
    if (!batch) {
      throw new NotFoundException(`Payroll batch with ID ${id} not found`);
    }
    assertInBranch(batch.branchId);

    const member = await this.prisma.payrollBatchMember.findFirst({
      where: {
        batchId: id,
        employeeId,
      },
    });

    if (!member) {
      throw new NotFoundException(`Employee with ID ${employeeId} is not a member of this batch`);
    }

    await this.prisma.payrollBatchMember.delete({
      where: {
        id: member.id,
      },
    });

    return this.findOne(id);
  }
}
