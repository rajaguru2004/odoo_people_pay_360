import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCanAccessRequestOf,
  managerDepartmentIds,
} from '../common/utils/manager-scope.util';
import type { Principal } from '../auth/auth.service';
import {
  CreateLeaveAttachmentDto,
  MAX_ATTACHMENT_BYTES,
} from './dto/create-leave-attachment.dto';

const ATTACHMENT_INCLUDE = {
  uploader: {
    select: {
      id: true,
      email: true,
      employee: { select: { id: true, firstName: true, lastName: true } },
    },
  },
};

/**
 * Evidence attached to a leave request.
 *
 * These are medical certificates and court summonses, which is why every door
 * here authorises against the OWNER of the request rather than merely requiring
 * a signed-in caller: without that, any authenticated user could list the sick
 * notes of anybody whose request id they could guess.
 *
 * The binary upload is deferred — the platform has no storage module — so create
 * takes a caller-supplied `fileUrl`. See the DTO and
 * `docs/interconnections-leave-overtime.md`.
 */
@Injectable()
export class LeaveAttachmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async findByLeaveRequest(leaveRequestId: string, user: Principal) {
    await this.assertMayTouch(leaveRequestId, user, 'view');

    const data = await this.prisma.leaveAttachment.findMany({
      where: { leaveRequestId, deletedAt: null },
      include: ATTACHMENT_INCLUDE,
      orderBy: { uploadedAt: 'desc' },
    });

    return { success: true as const, data: data.map(serialize) };
  }

  async create(
    leaveRequestId: string,
    dto: CreateLeaveAttachmentDto,
    user: Principal,
  ) {
    await this.assertMayTouch(leaveRequestId, user, 'attach files to');

    if (dto.fileSize !== undefined && dto.fileSize > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('File size exceeds the 10 MB limit');
    }

    const attachment = await this.prisma.leaveAttachment.create({
      data: {
        leaveRequestId,
        fileName: dto.fileName,
        fileUrl: dto.fileUrl,
        fileSize: dto.fileSize === undefined ? null : BigInt(dto.fileSize),
        mimeType: dto.mimeType ?? null,
        uploadedBy: user.id,
      },
      include: ATTACHMENT_INCLUDE,
    });

    return {
      success: true as const,
      message: 'Attachment recorded',
      data: serialize(attachment),
    };
  }

  /**
   * Soft delete.
   *
   * The row is kept because the fact that a certificate WAS produced is part of
   * why the leave was approved — removing it would make an approved absence look
   * unsupported in hindsight.
   */
  async remove(id: string, user: Principal) {
    const attachment = await this.prisma.leaveAttachment.findFirst({
      where: { id, deletedAt: null },
      include: {
        leaveRequest: {
          include: {
            employee: {
              select: {
                id: true,
                departmentId: true,
                supervisorId: true,
              },
            },
          },
        },
      },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');

    const isUploader = attachment.uploadedBy === user.id;
    const isAdminOrHr =
      user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER;

    if (!isUploader && !isAdminOrHr) {
      const scope = await managerDepartmentIds(this.prisma, user);
      assertCanAccessRequestOf(
        user,
        attachment.leaveRequest.employee,
        scope,
        'delete attachments from',
      );
    }

    await this.prisma.leaveAttachment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { success: true as const, message: 'Attachment deleted' };
  }

  /**
   * Load the parent purely to authorise against it.
   *
   * A 404 for a request that does not exist rather than an empty list: an
   * attachment endpoint that answers 200 with `[]` for every id ever asked for
   * is an existence oracle with extra steps.
   */
  private async assertMayTouch(
    leaveRequestId: string,
    user: Principal,
    action: string,
  ) {
    const request = await this.prisma.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: {
        id: true,
        employee: {
          select: { id: true, departmentId: true, supervisorId: true },
        },
      },
    });
    if (!request) throw new NotFoundException('Leave request not found');

    if (user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER) {
      return;
    }
    const scope = await managerDepartmentIds(this.prisma, user);
    assertCanAccessRequestOf(user, request.employee, scope, action);
  }
}

/**
 * `fileSize` is a BigInt, which `JSON.stringify` refuses to serialize — leaving
 * it takes the whole response down with a TypeError rather than losing a field.
 */
function serialize<T extends { fileSize: bigint | null }>(row: T) {
  return {
    ...row,
    fileSize: row.fileSize === null ? null : Number(row.fileSize),
  };
}
