import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DepartmentChangeType,
  Prisma,
  RequestStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  paginated,
  resolvePagination,
} from '../../common/utils/pagination.util';
import type { Principal } from '../../auth/auth.service';
import { CreateDepartmentChangeRequestDto } from './dto/create-department-change-request.dto';
import { ListDepartmentChangeRequestsDto } from './dto/list-department-change-requests.dto';
import {
  ChangeRequestReviewAction,
  ReviewDepartmentChangeRequestDto,
} from './dto/review-department-change-request.dto';

const CHANGE_REQUEST_INCLUDE = {
  department: { select: { id: true, code: true, name: true } },
  requestedBy: {
    select: {
      id: true,
      email: true,
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  reviewedBy: {
    select: {
      id: true,
      email: true,
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  oldManager: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
  },
  newManager: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
  },
  oldParent: { select: { id: true, code: true, name: true } },
  newParent: { select: { id: true, code: true, name: true } },
} satisfies Prisma.DepartmentChangeRequestInclude;

/** Which `new*` column each change type is allowed to carry. */
const TARGET_FIELD = {
  [DepartmentChangeType.MANAGER]: 'newManagerId',
  [DepartmentChangeType.PARENT]: 'newParentId',
  [DepartmentChangeType.RENAME]: 'newName',
  [DepartmentChangeType.DEACTIVATE]: null,
} as const satisfies Record<DepartmentChangeType, string | null>;

const TARGET_FIELDS = ['newManagerId', 'newParentId', 'newName'] as const;

/** `@IsOptional()` lets an explicit null through, so absence is both of these. */
const isSet = (value: unknown) => value !== undefined && value !== null;

@Injectable()
export class DepartmentChangeRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListDepartmentChangeRequestsDto) {
    const { page, limit, skip, take } = resolvePagination(query);

    const where: Prisma.DepartmentChangeRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.departmentChangeRequest.findMany({
        where,
        include: CHANGE_REQUEST_INCLUDE,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.departmentChangeRequest.count({ where }),
    ]);

    return paginated(data, total, page, limit);
  }

  /**
   * One request, with the blast radius of approving it computed live.
   *
   * The counts are deliberately NOT snapshotted at creation time the way the
   * old/new values are: a reviewer needs to know how many people the change
   * moves TODAY, not how many it would have moved when somebody typed it.
   */
  async findOne(id: string) {
    const request = await this.prisma.departmentChangeRequest.findUnique({
      where: { id },
      include: CHANGE_REQUEST_INCLUDE,
    });
    if (!request) throw new NotFoundException('Change request not found');

    const departmentId = request.departmentId;
    const [
      affectedEmployees,
      affectedTeams,
      affectedChildDepartments,
      pendingCorrections,
    ] = await Promise.all([
      // Active staff only. A terminated record still carries the department it
      // left, and counting it would overstate who the reorganisation touches.
      this.prisma.employee.count({
        where: { departmentId, status: 'ACTIVE' },
      }),
      this.prisma.team.count({ where: { departmentId, isActive: true } }),
      this.prisma.department.count({
        where: { parentId: departmentId, isActive: true },
      }),
      this.prisma.attendanceCorrection.count({
        where: {
          status: RequestStatus.PENDING,
          employee: { departmentId },
        },
      }),
    ]);

    return {
      ...request,
      impact: {
        affectedEmployees,
        affectedTeams,
        affectedChildDepartments,
        pendingCorrections,
      },
    };
  }

  /**
   * Raise a request. Any authenticated caller may; only a reviewer may apply it.
   *
   * The department's CURRENT manager, parent and name are copied onto the row
   * here. That snapshot is the point of the model: the queue screen renders
   * "Finance → Operations" from these columns, and it has to keep rendering the
   * value as it stood when the request was raised even if somebody edits the
   * department in the meantime.
   */
  async create(dto: CreateDepartmentChangeRequestDto, user: Principal) {
    const department = await this.prisma.department.findUnique({
      where: { id: dto.departmentId },
      select: {
        id: true,
        name: true,
        managerId: true,
        parentId: true,
        isActive: true,
      },
    });
    if (!department) throw new NotFoundException('Department not found');

    this.assertTargetMatchesType(dto);

    switch (dto.changeType) {
      case DepartmentChangeType.MANAGER: {
        const managerId = dto.newManagerId!;
        if (managerId === department.managerId) {
          throw new BadRequestException(
            'That employee already heads this department',
          );
        }
        const manager = await this.prisma.employee.findUnique({
          where: { id: managerId },
          select: { status: true },
        });
        if (!manager) throw new NotFoundException('Proposed head not found');
        if (manager.status === 'TERMINATED') {
          throw new BadRequestException(
            'That employee has left and cannot be made head of a department',
          );
        }
        break;
      }

      case DepartmentChangeType.PARENT: {
        const parentId = dto.newParentId!;
        if (parentId === department.id) {
          throw new BadRequestException(
            'A department cannot sit inside itself',
          );
        }
        if (parentId === department.parentId) {
          throw new BadRequestException(
            'This department already sits under that parent',
          );
        }
        await this.assertDepartmentExists(this.prisma, parentId);
        await this.assertNoHierarchyCycle(this.prisma, department.id, parentId);
        break;
      }

      case DepartmentChangeType.RENAME: {
        if (dto.newName === department.name) {
          throw new BadRequestException('That is already the department name');
        }
        break;
      }

      case DepartmentChangeType.DEACTIVATE: {
        if (!department.isActive) {
          throw new BadRequestException('This department is already inactive');
        }
        break;
      }
    }

    return this.prisma.departmentChangeRequest.create({
      data: {
        departmentId: department.id,
        changeType: dto.changeType,
        reason: dto.reason,
        effectiveDate: new Date(dto.effectiveDate),
        requestedById: user.id,
        oldManagerId: department.managerId,
        oldParentId: department.parentId,
        oldName: department.name,
        newManagerId: dto.newManagerId ?? null,
        newParentId: dto.newParentId ?? null,
        newName: dto.newName ?? null,
      },
      include: CHANGE_REQUEST_INCLUDE,
    });
  }

  async review(
    id: string,
    dto: ReviewDepartmentChangeRequestDto,
    user: Principal,
  ) {
    const request = await this.requirePending(id, 'reviewed');

    const stamp = (status: RequestStatus) => ({
      status,
      reviewedById: user.id,
      reviewedAt: new Date(),
      reviewNote: dto.reviewNote ?? null,
    });

    if (dto.action === ChangeRequestReviewAction.REJECT) {
      return this.prisma.departmentChangeRequest.update({
        where: { id },
        data: stamp(RequestStatus.REJECTED),
        include: CHANGE_REQUEST_INCLUDE,
      });
    }

    // The department edit and the stamp go together. Half of this — a renamed
    // department whose request is still PENDING, or an APPROVED request that
    // changed nothing — is a queue that lies about the state of the org chart.
    return this.prisma.$transaction(async (tx) => {
      await this.applyChange(tx, request);
      return tx.departmentChangeRequest.update({
        where: { id },
        data: stamp(RequestStatus.APPROVED),
        include: CHANGE_REQUEST_INCLUDE,
      });
    });
  }

  /**
   * Withdraw a request. The person who raised it may take it back; an admin may
   * clear anyone's. A reviewer's REJECT is a decision and stays on the record,
   * which is why this is a separate verb rather than a rejection with a note.
   */
  async cancel(id: string, user: Principal) {
    const request = await this.requirePending(id, 'cancelled');

    const isOwner = request.requestedById === user.id;
    if (!isOwner && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only the person who raised this request can cancel it',
      );
    }

    return this.prisma.departmentChangeRequest.update({
      where: { id },
      data: { status: RequestStatus.CANCELLED },
      include: CHANGE_REQUEST_INCLUDE,
    });
  }

  private async requirePending(id: string, verb: 'reviewed' | 'cancelled') {
    const request = await this.prisma.departmentChangeRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException('Change request not found');

    if (request.status === RequestStatus.CANCELLED) {
      throw new BadRequestException('This request was cancelled');
    }
    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `This request has already been reviewed and cannot be ${verb} again`,
      );
    }
    return request;
  }

  /**
   * A request must carry the one `new*` value its type applies, and no other.
   *
   * The stray-field half matters as much as the missing one: a MANAGER request
   * that also stored a `newParentId` would render a parent move in the queue
   * that approving it will never perform.
   */
  private assertTargetMatchesType(dto: CreateDepartmentChangeRequestDto) {
    const required = TARGET_FIELD[dto.changeType];

    if (required && !isSet(dto[required])) {
      throw new BadRequestException(
        `A ${dto.changeType} request needs ${required}`,
      );
    }

    const strays = TARGET_FIELDS.filter(
      (field) => field !== required && isSet(dto[field]),
    );
    if (strays.length) {
      throw new BadRequestException(
        `A ${dto.changeType} request cannot carry ${strays.join(', ')}`,
      );
    }
  }

  private async applyChange(
    tx: Prisma.TransactionClient,
    request: {
      departmentId: string;
      changeType: DepartmentChangeType;
      newManagerId: string | null;
      newParentId: string | null;
      newName: string | null;
    },
  ) {
    const data: Prisma.DepartmentUncheckedUpdateInput = {};

    switch (request.changeType) {
      case DepartmentChangeType.MANAGER: {
        if (!request.newManagerId) {
          throw new BadRequestException('This request has no head to apply');
        }
        const manager = await tx.employee.findUnique({
          where: { id: request.newManagerId },
          select: { id: true },
        });
        if (!manager) {
          throw new BadRequestException(
            'The proposed head no longer exists. Raise the request again.',
          );
        }
        data.managerId = request.newManagerId;
        break;
      }

      case DepartmentChangeType.PARENT: {
        if (!request.newParentId) {
          throw new BadRequestException('This request has no parent to apply');
        }
        // Re-checked here, not just at creation. The hierarchy can have moved
        // under the request while it sat in the queue, and the walk has to run
        // against the tree being written — which is why it runs on `tx`.
        await this.assertDepartmentExists(tx, request.newParentId);
        await this.assertNoHierarchyCycle(
          tx,
          request.departmentId,
          request.newParentId,
        );
        data.parentId = request.newParentId;
        break;
      }

      case DepartmentChangeType.RENAME: {
        if (!request.newName) {
          throw new BadRequestException(
            'This request has no new name to apply',
          );
        }
        data.name = request.newName;
        break;
      }

      case DepartmentChangeType.DEACTIVATE:
        data.isActive = false;
        break;
    }

    await tx.department.update({ where: { id: request.departmentId }, data });
  }

  private async assertDepartmentExists(
    client: Prisma.TransactionClient,
    id: string,
  ) {
    const found = await client.department.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Parent department not found');
  }

  /**
   * Walk up from the proposed parent; meeting `id` means a cycle.
   *
   * The same guard DepartmentsService applies to a direct edit. It is repeated
   * rather than shared because it has to be able to run on a transaction client
   * — a cycle written inside the approval transaction is a tree no org-chart
   * walk can terminate on.
   */
  private async assertNoHierarchyCycle(
    client: Prisma.TransactionClient,
    id: string,
    parentId: string,
  ) {
    const seen = new Set<string>();
    let cursor: string | null = parentId;

    while (cursor && !seen.has(cursor)) {
      if (cursor === id) {
        throw new BadRequestException(
          'That parent already sits below this department',
        );
      }
      seen.add(cursor);
      const next: { parentId: string | null } | null =
        await client.department.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = next?.parentId ?? null;
    }
  }
}
