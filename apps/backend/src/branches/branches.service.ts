import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertBranchVisible,
  getEnvelopeBranchIds,
} from '../common/branch/branch-scope.util';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class BranchesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Restricts a query to the branches the caller may reach at all.
   *
   * `Branch` is the one model the branch-scope map cannot cover — the map's
   * rules filter on a `branchId` column, and a branch's identity IS the branch.
   * Without this, a branch-scoped HR manager saw, edited and deleted branches
   * outside their grant: the single record the branch engine did not protect.
   */
  private envelopeWhere(): { id?: { in: string[] } } {
    const envelope = getEnvelopeBranchIds();
    return envelope === null ? {} : { id: { in: envelope } };
  }

  /**
   * Canonicalise `weeklyOffDays` before it reaches the database.
   *
   * Every day named here is read back by `holidaysService.getWeeklyOffDays()`
   * and classified as a REST DAY, which overtime pays at the double
   * multiplier. That makes this one CSV the highest-leverage field on the
   * branch: a Head Office saved as `"1,2,3,4,5,6"` turned every Mon–Sat
   * overtime request into rest-day work at 2x, and nothing downstream could
   * tell that apart from a deliberate roster.
   *
   * So: duplicates and whitespace are dropped (`"0,0,6"` must not read as
   * three off days), the list is sorted for a stable stored form, and a set
   * covering all seven days is refused outright — a branch with no working day
   * cannot be a real roster, only a mis-click.
   *
   * A 5- or 6-day set is still allowed: it is legal, if unusual, so the branch
   * form warns about the overtime consequence instead of blocking the save.
   */
  private normalizeWeeklyOffDays(dto: {
    weeklyOffDays?: string | null;
  }): void {
    if (dto.weeklyOffDays === undefined) return;

    // Empty means "inherit the company default", which the column stores as
    // NULL — an empty string would be read as a real zero-off-day week.
    if (dto.weeklyOffDays === null || dto.weeklyOffDays.trim() === '') {
      dto.weeklyOffDays = null;
      return;
    }

    const days = [
      ...new Set(
        dto.weeklyOffDays
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number),
      ),
    ]
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
      .sort((a, b) => a - b);

    if (days.length >= 7) {
      throw new BadRequestException(
        'weeklyOffDays cannot cover all seven days — a branch must keep at least one working day',
      );
    }

    dto.weeklyOffDays = days.length ? days.join(',') : null;
  }

  /**
   * @param includeInactive  Retired branches are hidden from every list and
   *   every picker, and `findOne` 404s on them as well — so a branch switched
   *   off by mistake had no route back through the UI at all: it could not be
   *   listed, opened, or edited. This is the one door that can see them, and it
   *   stays shut unless the caller explicitly asks and holds a role that may
   *   also switch them back on.
   */
  async findAll(includeInactive = false) {
    const branches = await this.prisma.branch.findMany({
      where: {
        ...(includeInactive ? {} : { isActive: true }),
        ...this.envelopeWhere(),
      },
      include: {
        manager: { select: { id: true, fullName: true, employeeCode: true } },
        _count: { select: { employees: true } },
      },
      orderBy: { code: 'asc' },
    });
    return { success: true, data: branches };
  }

  async findOne(id: string) {
    assertBranchVisible(id);

    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: {
        manager: { select: { id: true, fullName: true, employeeCode: true } },
        _count: { select: { employees: true } },
      },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found');
    }
    // A retired branch is gone from every list and every picker. Still serving
    // it by id meant a stale link kept working and an edit form kept saving to
    // somewhere nobody could see.
    if (!branch.isActive) {
      throw new NotFoundException('Branch not found');
    }
    return { success: true, data: branch };
  }

  async create(dto: CreateBranchDto, actorUserId?: string) {
    this.normalizeWeeklyOffDays(dto);

    const existing = await this.prisma.branch.findUnique({
      where: { code: dto.code },
    });
    if (existing) {
      throw new ConflictException('Branch code already exists');
    }

    if (dto.managerId) {
      const manager = await this.prisma.employee.findUnique({
        where: { id: dto.managerId },
      });
      if (!manager) {
        throw new BadRequestException('Manager not found');
      }
    }

    // The `findUnique` above is a READ, and a read-then-write is not a guard: two
    // callers creating the same code at once both passed it, and the loser hit
    // the database's unique index with nothing catching it — answering **500
    // Internal server error** instead of the clean 409 a sequential duplicate
    // gets. Client input then decided whether the server reported a fault of its
    // own, which is the rule Phase 4's F31 fixed for payroll's by-id doors.
    //
    // Same shape as the duplicate-payroll protection, which needed a real index
    // behind it for the same reason.
    let branch: Awaited<ReturnType<typeof this.prisma.branch.create>>;
    try {
      branch = await this.prisma.branch.create({ data: dto });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Branch code already exists');
      }
      throw e;
    }

    // A scoped caller who opens a new site has to be able to run it. Without
    // this the branch they just created falls outside their envelope and
    // vanishes from their own list — a create that visibly does nothing.
    //
    // It does not widen their reach over anything that already existed: the
    // branch is new and empty, and they already held the permission to create
    // one at all.
    if (getEnvelopeBranchIds() !== null && actorUserId) {
      await this.prisma.userBranchAccess.upsert({
        where: {
          userId_branchId: { userId: actorUserId, branchId: branch.id },
        },
        create: { userId: actorUserId, branchId: branch.id },
        update: {},
      });
    }

    return {
      success: true,
      message: 'Branch created successfully',
      data: branch,
    };
  }

  async update(id: string, dto: UpdateBranchDto) {
    assertBranchVisible(id);
    this.normalizeWeeklyOffDays(dto);

    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) {
      throw new NotFoundException('Branch not found');
    }

    if (dto.code && dto.code !== branch.code) {
      const dup = await this.prisma.branch.findUnique({
        where: { code: dto.code },
      });
      if (dup) {
        throw new ConflictException('Branch code already exists');
      }
    }

    if (dto.managerId) {
      const manager = await this.prisma.employee.findUnique({
        where: { id: dto.managerId },
      });
      if (!manager) {
        throw new BadRequestException('Manager not found');
      }
    }

    const updated = await this.prisma.branch.update({
      where: { id },
      data: dto,
    });
    return {
      success: true,
      message: 'Branch updated successfully',
      data: updated,
    };
  }

  async delete(id: string) {
    assertBranchVisible(id);

    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: { _count: { select: { employees: true, assets: true } } },
    });
    if (!branch) {
      throw new NotFoundException('Branch not found');
    }
    if (branch._count.employees > 0) {
      throw new BadRequestException('Cannot delete branch with employees');
    }
    // R65 — `asset_items.branch_id` is a required relation, so Prisma declares
    // `onDelete: Restrict` and Postgres enforces it. But this is a SOFT delete,
    // so the constraint was never reached: a branch holding assets retired with
    // a 200, the assets stayed pointing at a branch that had left every list
    // and every picker, and clearance kept counting them for somewhere nobody
    // could see. The employees rule one line up is the live control for exactly
    // this shape (asserted by XM-API-15d); assets get the same clean 400 rather
    // than a leaked P2003 or a silent success.
    if (branch._count.assets > 0) {
      throw new BadRequestException('Cannot delete branch with assets');
    }

    // Soft delete
    await this.prisma.branch.update({
      where: { id },
      data: { isActive: false },
    });

    return { success: true, message: 'Branch deleted successfully' };
  }
}
