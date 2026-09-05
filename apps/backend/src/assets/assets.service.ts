import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssetStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  assertBranchAssignable,
  assertInBranch,
} from '../common/branch/branch-scope.util';
import { getBranchContext } from '../common/branch/branch-context';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';

/**
 * The five statuses, as a literal tuple — `z.enum()` in the MCP tools and
 * Swagger's `enum:` both need one, and `Object.values(AssetStatus)` is a plain
 * `string[]`.
 *
 * R15 — the DATABASE is the authority now (`enum AssetStatus` in
 * schema.prisma), not this constant. It used to be the only authority, which is
 * why a value the DTO refused could still be written by a seed, a backfill or
 * an MCP tool, served back by the API, counted in `/assets/summary` and then be
 * unfilterable through `?status=`. The two locks below make the tuple and the
 * enum unable to drift apart in either direction, at compile time:
 * `satisfies` catches a value that is not in the enum, and the conditional type
 * catches an enum member that is missing from the tuple.
 */
export const ASSET_STATUSES = [
  'AVAILABLE',
  'ASSIGNED',
  'IN_REPAIR',
  'LOST',
  'RETIRED',
] as const satisfies readonly AssetStatus[];

type _EveryAssetStatusIsListed =
  Exclude<AssetStatus, (typeof ASSET_STATUSES)[number]> extends never
    ? true
    : ['ASSET_STATUSES is missing an AssetStatus member'];

/** Statuses from which an asset may be handed to an employee. */
const ASSIGNABLE_STATUSES = new Set<AssetStatus>(['AVAILABLE']);

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private readonly listInclude = {
    branch: { select: { id: true, code: true, name: true } },
    assignments: {
      where: { returnedAt: null },
      take: 1,
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
          },
        },
      },
    },
  } as const;

  /** Flatten the single open assignment into `currentHolder` for the UI. */
  private serialize(asset: any) {
    if (!asset) return asset;
    const open = asset.assignments?.[0] ?? null;
    const { assignments, ...rest } = asset;
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
    };
  }

  /**
   * R2 — `asset_tag` is unique PER BRANCH (`@@unique([branchId, assetTag])`),
   * not globally, so a collision is always with a row in one NAMED branch.
   *
   * The branch has to be in the message. While the constraint was global, this
   * error said only that the tag was taken, and the colliding row could sit in
   * a branch the Prisma branch middleware hides from the reader: they were told
   * to pick another tag, searched for the one they were quoted, found nothing,
   * and had no action left. Naming the branch discloses nothing new — the
   * caller has already passed `assertBranchAssignable` for it, so it is inside
   * their own envelope by construction — and it turns the refusal into an
   * instruction: go and look at THAT branch's register.
   */
  private async tagConflict(assetTag: string, branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { code: true, name: true },
    });
    const where = branch ? `branch ${branch.name} (${branch.code})` : 'this branch';
    return new ConflictException(
      `Asset tag "${assetTag}" is already in use in ${where}. ` +
        'Asset tags are unique per branch, so another branch may still register the same tag.',
    );
  }

  async create(dto: CreateAssetDto, userId: string) {
    // Writes are not auto-scoped, and the UI's branch selector must not be able
    // to place an asset in a branch the caller cannot reach.
    assertBranchAssignable(dto.branchId);

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
          status: dto.status ?? 'AVAILABLE',
          purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : null,
          purchaseCost: dto.purchaseCost ?? null,
          warrantyExpiry: dto.warrantyExpiry ? new Date(dto.warrantyExpiry) : null,
          notes: dto.notes ?? null,
        },
        include: this.listInclude,
      });

      await this.audit.log({
        userId,
        action: 'ASSET_CREATED',
        resourceType: 'AssetItem',
        resourceId: asset.id,
        newData: { assetTag: asset.assetTag, name: asset.name },
        branchId: getBranchContext()?.effectiveBranchId ?? null,
      });
      return { success: true, data: this.serialize(asset) };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw await this.tagConflict(dto.assetTag.trim(), dto.branchId);
      }
      throw e;
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
      where.OR = [
        { assetTag: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { serialNumber: { contains: search, mode: 'insensitive' } },
      ];
    }
    // `unassignedOnly` means "no open assignment", which is not the same as
    // status AVAILABLE — an IN_REPAIR asset is also not held by anyone.
    if (query.unassignedOnly) {
      where.assignments = { none: { returnedAt: null } };
    }

    const [rows, total] = await Promise.all([
      this.prisma.assetItem.findMany({
        where,
        include: this.listInclude,
        orderBy: [{ status: 'asc' }, { assetTag: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.assetItem.count({ where }),
    ]);

    return {
      success: true,
      data: rows.map((r) => this.serialize(r)),
      meta: { total, page, limit },
    };
  }

  async findOne(id: string) {
    const asset = await this.prisma.assetItem.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        assignments: {
          orderBy: { assignedAt: 'desc' },
          include: {
            employee: {
              select: {
                id: true,
                employeeCode: true,
                fullName: true,
                department: { select: { name: true } },
              },
            },
            assignedBy: { select: { id: true, email: true } },
            returnedTo: { select: { id: true, email: true } },
          },
        },
      },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    // findUnique bypasses the auto-scoping middleware.
    assertInBranch(asset.branchId);

    const open = asset.assignments.find((a) => a.returnedAt === null) ?? null;
    return {
      success: true,
      data: {
        ...asset,
        currentHolder: open
          ? {
              assignmentId: open.id,
              assignedAt: open.assignedAt,
              acknowledgedAt: open.acknowledgedAt,
              employee: open.employee,
            }
          : null,
        // Full custody trail, newest first.
        history: asset.assignments,
      },
    };
  }

  async update(id: string, dto: UpdateAssetDto, userId: string) {
    const existing = await this.prisma.assetItem.findUnique({
      where: { id },
      // assetTag and branchId are both read back for the conflict message: a
      // duplicate here can now be caused by editing EITHER half of the pair —
      // renaming the tag, or moving the asset to a branch that already has one.
      select: { id: true, assetTag: true, branchId: true, status: true },
    });
    if (!existing) throw new NotFoundException('Asset not found');
    assertInBranch(existing.branchId);
    if (dto.branchId) assertBranchAssignable(dto.branchId);

    // ASSIGNED is derived from custody, not set by hand — letting an admin
    // clear it would orphan an open assignment and break clearance.
    if (dto.status && dto.status === 'ASSIGNED' && existing.status !== 'ASSIGNED') {
      throw new BadRequestException(
        'Set an asset to ASSIGNED by assigning it to an employee, not by editing its status',
      );
    }
    if (dto.status && existing.status === 'ASSIGNED' && dto.status !== 'ASSIGNED') {
      throw new BadRequestException(
        'This asset is currently held by an employee. Record its return before changing status.',
      );
    }

    try {
      const asset = await this.prisma.assetItem.update({
        where: { id },
        data: {
          ...(dto.assetTag !== undefined && { assetTag: dto.assetTag.trim() }),
          ...(dto.category !== undefined && { category: dto.category }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.serialNumber !== undefined && { serialNumber: dto.serialNumber }),
          ...(dto.branchId !== undefined && { branchId: dto.branchId }),
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.purchaseDate !== undefined && {
            purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : null,
          }),
          ...(dto.purchaseCost !== undefined && { purchaseCost: dto.purchaseCost }),
          ...(dto.warrantyExpiry !== undefined && {
            warrantyExpiry: dto.warrantyExpiry
              ? new Date(dto.warrantyExpiry)
              : null,
          }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
        include: this.listInclude,
      });

      await this.audit.log({
        userId,
        action: 'ASSET_UPDATED',
        resourceType: 'AssetItem',
        resourceId: id,
        newData: dto as any,
        branchId: getBranchContext()?.effectiveBranchId ?? null,
      });
      return { success: true, data: this.serialize(asset) };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // Either half of the pair may have moved, and `dto.assetTag` alone is
        // undefined when the edit was a branch transfer — which used to make
        // this message read `Asset tag "undefined" is already in use`.
        throw await this.tagConflict(
          (dto.assetTag ?? existing.assetTag).trim(),
          dto.branchId ?? existing.branchId,
        );
      }
      throw e;
    }
  }

  async remove(id: string, userId: string) {
    const existing = await this.prisma.assetItem.findUnique({
      where: { id },
      select: {
        id: true,
        assetTag: true,
        branchId: true,
        // Total custody rows, open and closed. Nested counts are not seen by
        // the branch middleware, so this is the true history, not the caller's
        // view of it.
        _count: { select: { assignments: true } },
        // Presence of an OPEN one, for the more specific message below.
        assignments: {
          where: { returnedAt: null },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!existing) throw new NotFoundException('Asset not found');
    assertInBranch(existing.branchId);

    // Deleting cascades the assignments, which would silently clear someone's
    // clearance obligation.
    if (existing.assignments.length > 0) {
      throw new BadRequestException(
        'This asset is currently held by an employee. Record its return before deleting it.',
      );
    }

    // R3 — and a CLOSED history is no safer to destroy. `asset_assignments
    // .asset_id` is `onDelete: Cascade`, so deleting an asset that has been
    // handed out, signed for and handed back takes every custody row with it:
    // the acknowledgement that proved the employee received it, and the return
    // that cleared their offboarding. That evidence is the whole point of the
    // register, and nothing else in the system reconstructs it — the surviving
    // `ASSET_DELETED` audit row carries only the tag. An asset that has ever
    // been in someone's hands is therefore a permanent record: retire it
    // instead, which keeps the row and its trail while taking it out of the
    // assignable pool.
    if (existing._count.assignments > 0) {
      throw new BadRequestException(
        `Asset ${existing.assetTag} has ${existing._count.assignments} custody record(s) and cannot be deleted — ` +
          'deleting it would erase the history that proves who held it and when it came back. ' +
          'Retire it instead (set its status to RETIRED).',
      );
    }

    await this.prisma.assetItem.delete({ where: { id } });
    await this.audit.log({
      userId,
      action: 'ASSET_DELETED',
      resourceType: 'AssetItem',
      resourceId: id,
      newData: { assetTag: existing.assetTag },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });
    return { success: true, message: 'Asset deleted' };
  }

  /** Register totals for the dashboard cards. */
  async getSummary() {
    const byStatus = await this.prisma.assetItem.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const held = await this.prisma.assetAssignment.count({
      where: { returnedAt: null },
    });
    const unacknowledged = await this.prisma.assetAssignment.count({
      where: { returnedAt: null, acknowledgedAt: null },
    });

    return {
      success: true,
      data: {
        byStatus: Object.fromEntries(
          byStatus.map((r) => [r.status, r._count._all]),
        ),
        total: byStatus.reduce((sum, r) => sum + r._count._all, 0),
        held,
        unacknowledged,
      },
    };
  }

  static isAssignable(status: AssetStatus): boolean {
    return ASSIGNABLE_STATUSES.has(status);
  }
}
