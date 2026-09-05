import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssetStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginated } from '../common/utils/pagination.util';
import { withFullName } from '../common/utils/employee-name.util';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';

/** Statuses an asset may be handed out from. */
const ASSIGNABLE_STATUSES = new Set<AssetStatus>([AssetStatus.AVAILABLE]);

const HOLDER_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

const LIST_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  assignments: {
    where: { returnedAt: null },
    take: 1,
    include: { employee: { select: HOLDER_SELECT } },
  },
} satisfies Prisma.AssetItemInclude;

type AssetRow = Prisma.AssetItemGetPayload<{ include: typeof LIST_INCLUDE }>;

@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Flatten the single open assignment into `currentHolder`.
   *
   * The register's whole question is "who has this right now", and answering it
   * from an array the caller has to search is how two screens end up disagreeing
   * about whether an asset is out.
   */
  private serialize(asset: AssetRow) {
    const { assignments, ...rest } = asset;
    const open = assignments[0] ?? null;
    return {
      ...rest,
      currentHolder: open
        ? {
            assignmentId: open.id,
            assignedAt: open.assignedAt,
            acknowledgedAt: open.acknowledgedAt,
            employee: withFullName(open.employee),
          }
        : null,
    };
  }

  /**
   * Name the branch in a duplicate-tag refusal.
   *
   * `assetTag` is unique PER BRANCH, so a collision is always with a row in one
   * named branch. Saying only that the tag is taken sends the reader hunting
   * through a register that does not contain it; naming the branch turns the
   * refusal into an instruction.
   */
  private async tagConflict(assetTag: string, branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { code: true, name: true },
    });
    const where = branch ? `${branch.name} (${branch.code})` : 'that branch';
    return new ConflictException(
      `Asset tag "${assetTag}" is already in use in ${where}. Tags are unique per branch, ` +
        'so another branch may still register the same one.',
    );
  }

  async create(dto: CreateAssetDto) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');

    try {
      const asset = await this.prisma.assetItem.create({
        data: {
          assetTag: dto.assetTag.trim(),
          category: dto.category,
          name: dto.name,
          serialNumber: dto.serialNumber ?? null,
          branchId: dto.branchId,
          status: dto.status ?? AssetStatus.AVAILABLE,
          purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : null,
          purchaseCost: dto.purchaseCost ?? null,
          warrantyExpiry: dto.warrantyExpiry
            ? new Date(dto.warrantyExpiry)
            : null,
          notes: dto.notes ?? null,
        },
        include: LIST_INCLUDE,
      });
      return this.serialize(asset);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw await this.tagConflict(dto.assetTag.trim(), dto.branchId);
      }
      throw error;
    }
  }

  async findAll(query: QueryAssetsDto) {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(query.limit ?? 25, 200);

    const where: Prisma.AssetItemWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.category) where.category = query.category;
    if (query.branchId) where.branchId = query.branchId;
    if (query.search?.trim()) {
      const search = query.search.trim();
      const insensitive = Prisma.QueryMode.insensitive;
      where.OR = [
        { assetTag: { contains: search, mode: insensitive } },
        { name: { contains: search, mode: insensitive } },
        { serialNumber: { contains: search, mode: insensitive } },
      ];
    }
    // "Nobody holds it" is not the same as status AVAILABLE — an asset in
    // repair is also held by no one.
    if (query.unassignedOnly) {
      where.assignments = { none: { returnedAt: null } };
    }

    const [rows, total] = await Promise.all([
      this.prisma.assetItem.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: [{ status: 'asc' }, { assetTag: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.assetItem.count({ where }),
    ]);

    return paginated(
      rows.map((row) => this.serialize(row)),
      total,
      page,
      limit,
    );
  }

  async findOne(id: string) {
    const asset = await this.prisma.assetItem.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        assignments: {
          orderBy: { assignedAt: 'desc' },
          include: {
            employee: { select: HOLDER_SELECT },
            assignedBy: { select: { id: true, email: true } },
            returnedTo: { select: { id: true, email: true } },
          },
        },
      },
    });
    if (!asset) throw new NotFoundException('Asset not found');

    const history = asset.assignments.map((row) => ({
      ...row,
      employee: withFullName(row.employee),
    }));
    const open = history.find((row) => row.returnedAt === null) ?? null;

    const { assignments: _assignments, ...rest } = asset;
    return {
      ...rest,
      currentHolder: open
        ? {
            assignmentId: open.id,
            assignedAt: open.assignedAt,
            acknowledgedAt: open.acknowledgedAt,
            employee: open.employee,
          }
        : null,
      // The full custody trail, newest first. It is the evidence the register
      // exists for.
      history,
    };
  }

  async update(id: string, dto: UpdateAssetDto) {
    const existing = await this.prisma.assetItem.findUnique({
      where: { id },
      // Both halves of the unique pair are read back for the conflict message:
      // a duplicate here can be caused by renaming the tag OR by moving the
      // asset into a branch that already has one.
      select: { id: true, assetTag: true, branchId: true, status: true },
    });
    if (!existing) throw new NotFoundException('Asset not found');

    // ASSIGNED is derived from custody, never set by hand — clearing it would
    // orphan an open assignment and quietly clear somebody's clearance.
    if (
      dto.status === AssetStatus.ASSIGNED &&
      existing.status !== AssetStatus.ASSIGNED
    ) {
      throw new BadRequestException(
        'Set an asset to ASSIGNED by assigning it to an employee, not by editing its status',
      );
    }
    if (
      dto.status &&
      existing.status === AssetStatus.ASSIGNED &&
      dto.status !== AssetStatus.ASSIGNED
    ) {
      throw new BadRequestException(
        'This asset is currently held by an employee. Record its return before changing its status.',
      );
    }

    try {
      const asset = await this.prisma.assetItem.update({
        where: { id },
        data: {
          ...(dto.assetTag !== undefined && { assetTag: dto.assetTag.trim() }),
          ...(dto.category !== undefined && { category: dto.category }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.serialNumber !== undefined && {
            serialNumber: dto.serialNumber,
          }),
          ...(dto.branchId !== undefined && { branchId: dto.branchId }),
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.purchaseDate !== undefined && {
            purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : null,
          }),
          ...(dto.purchaseCost !== undefined && {
            purchaseCost: dto.purchaseCost,
          }),
          ...(dto.warrantyExpiry !== undefined && {
            warrantyExpiry: dto.warrantyExpiry
              ? new Date(dto.warrantyExpiry)
              : null,
          }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
        include: LIST_INCLUDE,
      });
      return this.serialize(asset);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Either half of the pair may have moved, and `dto.assetTag` alone is
        // undefined when the edit was a branch transfer.
        throw await this.tagConflict(
          (dto.assetTag ?? existing.assetTag).trim(),
          dto.branchId ?? existing.branchId,
        );
      }
      throw error;
    }
  }

  async remove(id: string) {
    const existing = await this.prisma.assetItem.findUnique({
      where: { id },
      select: {
        id: true,
        assetTag: true,
        _count: { select: { assignments: true } },
        assignments: { where: { returnedAt: null }, select: { id: true }, take: 1 },
      },
    });
    if (!existing) throw new NotFoundException('Asset not found');

    if (existing.assignments.length > 0) {
      throw new BadRequestException(
        'This asset is currently held by an employee. Record its return before deleting it.',
      );
    }

    // A CLOSED history is no safer to destroy. `AssetAssignment.assetId`
    // cascades, so deleting an asset that has been handed out, signed for and
    // handed back takes every custody row with it — the acknowledgement that
    // proved receipt and the return that cleared an offboarding. Nothing else
    // reconstructs that, so an asset anybody has ever held is a permanent
    // record: retire it instead.
    if (existing._count.assignments > 0) {
      throw new BadRequestException(
        `Asset ${existing.assetTag} has ${existing._count.assignments} custody record(s) and cannot be deleted — ` +
          'deleting it would erase the history that proves who held it and when it came back. ' +
          'Retire it instead by setting its status to RETIRED.',
      );
    }

    await this.prisma.assetItem.delete({ where: { id } });
    return { deleted: true };
  }

  /** The four figures the register's tiles print. */
  async getSummary() {
    const [byStatus, held, unacknowledged] = await Promise.all([
      this.prisma.assetItem.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.assetAssignment.count({ where: { returnedAt: null } }),
      this.prisma.assetAssignment.count({
        where: { returnedAt: null, acknowledgedAt: null },
      }),
    ]);

    return {
      byStatus: Object.fromEntries(
        byStatus.map((row) => [row.status, row._count._all]),
      ),
      total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
      held,
      unacknowledged,
    };
  }

  static isAssignable(status: AssetStatus): boolean {
    return ASSIGNABLE_STATUSES.has(status);
  }
}
