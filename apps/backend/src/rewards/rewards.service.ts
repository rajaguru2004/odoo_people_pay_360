import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { CreateRewardDto } from './dto/create-reward.dto';

const DEPT_SCOPE_ERROR =
  'You do not have permission to perform this action outside your department.';

@Injectable()
export class RewardsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateRewardDto, createdBy: string, user?: any) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employeeId },
      select: { id: true, departmentId: true, branchId: true },
    });
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Branch guard: a scoped caller cannot reward an out-of-branch employee.
    assertInBranch(employee.branchId);

    // MANAGER scope: can only reward employees in own department
    if (
      user?.role === 'MANAGER' &&
      !isDeptInManagerScope(user, employee.departmentId)
    ) {
      throw new ForbiddenException(DEPT_SCOPE_ERROR);
    }

    const reward = await this.prisma.reward.create({
      data: {
        employeeId: dto.employeeId,
        reason: dto.reason,
        amount: dto.amount,
        rewardDate: new Date(dto.rewardDate),
        rewardType: dto.rewardType,
        createdBy,
      },
      include: {
        employee: {
          select: { id: true, employeeCode: true, fullName: true },
        },
      },
    });

    return { success: true, message: 'Reward created', data: reward };
  }

  async findAll(query: { employeeId?: string; page?: number; limit?: number }) {
    const { employeeId } = query;
    const page = Number(query.page) || 1;
    const limit = Math.min(Number(query.limit) || 10, 500); // Max 500
    const skip = (page - 1) * limit;
    const where: any = {};
    if (employeeId) where.employeeId = employeeId;

    const [rewards, total] = await Promise.all([
      this.prisma.reward.findMany({
        where,
        skip,
        take: limit,
        include: {
          employee: {
            select: { id: true, employeeCode: true, fullName: true },
          },
          creator: { select: { id: true, email: true } },
        },
        orderBy: { rewardDate: 'desc' },
      }),
      this.prisma.reward.count({ where }),
    ]);

    return { success: true, data: rewards, meta: { total, page, limit } };
  }

  async findByEmployee(employeeId: string) {
    const rewards = await this.prisma.reward.findMany({
      where: { employeeId },
      orderBy: { rewardDate: 'desc' },
    });
    return { success: true, data: rewards };
  }

  async delete(id: string) {
    const reward = await this.prisma.reward.findUnique({
      where: { id },
      include: { employee: { select: { branchId: true } } },
    });
    if (!reward) throw new NotFoundException('Reward not found');

    // Object-level branch guard (findUnique + delete bypass auto-scoping).
    assertInBranch(reward.employee.branchId);

    await this.prisma.reward.delete({ where: { id } });
    return { success: true, message: 'Reward deleted' };
  }
}
