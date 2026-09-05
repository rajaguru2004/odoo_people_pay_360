import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { extname, join } from 'path';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/auth.service';

/** A sick note is a scan or a photograph, and nothing else. */
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
];

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Where uploads land, under the directory `main.ts` already serves at
 * `/uploads/`. One subdirectory per kind of attachment, so a stray file is
 * traceable to the feature that wrote it.
 */
const UPLOAD_SUBDIR = 'leave-attachments';

const ATTACHMENT_INCLUDE = {
  uploader: {
    select: {
      id: true,
      email: true,
      employee: {
        select: { firstName: true, lastName: true, avatarUrl: true },
      },
    },
  },
} satisfies Prisma.LeaveAttachmentInclude;

type AttachmentRow = Prisma.LeaveAttachmentGetPayload<{
  include: typeof ATTACHMENT_INCLUDE;
}>;

@Injectable()
export class LeaveAttachmentsService {
  private readonly logger = new Logger(LeaveAttachmentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `fileSize` is a BigInt column and JSON cannot carry one, so it is narrowed
   * on the way out. The upload limit is well inside a safe integer.
   */
  private present(row: AttachmentRow) {
    const uploader = row.uploader;
    return {
      ...row,
      fileSize: row.fileSize === null ? null : Number(row.fileSize),
      uploader: uploader
        ? {
            id: uploader.id,
            email: uploader.email,
            fullName: uploader.employee
              ? [uploader.employee.firstName, uploader.employee.lastName]
                  .filter(Boolean)
                  .join(' ')
              : null,
            avatarUrl: uploader.employee?.avatarUrl ?? null,
          }
        : null,
    };
  }

  /**
   * Who may see or add to one request's files.
   *
   * These are medical certificates. Branch or department membership alone is
   * not enough — a colleague sitting in the same department has no business
   * reading somebody's sick note.
   */
  private async assertCanAccess(
    leaveRequestId: string,
    user: Principal,
    verb: string,
  ) {
    const request = await this.prisma.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: {
        id: true,
        employeeId: true,
        employee: { select: { departmentId: true } },
      },
    });
    if (!request) throw new NotFoundException('Leave request not found');

    if (user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER) {
      return request;
    }
    if (user.employeeId && user.employeeId === request.employeeId) {
      return request;
    }
    if (
      user.role === UserRole.MANAGER &&
      request.employee.departmentId &&
      request.employee.departmentId === user.departmentId
    ) {
      return request;
    }
    throw new ForbiddenException(
      `You do not have permission to ${verb} this request's attachments`,
    );
  }

  async findByLeaveRequest(leaveRequestId: string, user: Principal) {
    await this.assertCanAccess(leaveRequestId, user, 'view');
    const rows = await this.prisma.leaveAttachment.findMany({
      where: { leaveRequestId, deletedAt: null },
      include: ATTACHMENT_INCLUDE,
      orderBy: { uploadedAt: 'desc' },
    });
    return rows.map((row) => this.present(row));
  }

  async upload(
    leaveRequestId: string,
    file: Express.Multer.File | undefined,
    user: Principal,
  ) {
    if (!file) throw new BadRequestException('A file is required');
    await this.assertCanAccess(leaveRequestId, user, 'attach files to');

    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException('File size exceeds the 10 MB limit');
    }
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Only PDF and JPG/PNG images may be attached',
      );
    }

    // The stored name is generated, never the caller's. An original name goes
    // into the database for display and never into a path, so a crafted
    // filename cannot escape the upload directory or overwrite a neighbour.
    const storedName = `${randomUUID()}${extname(file.originalname).toLowerCase()}`;
    const directory = join(process.cwd(), 'uploads', UPLOAD_SUBDIR);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, storedName), file.buffer);

    const created = await this.prisma.leaveAttachment.create({
      data: {
        leaveRequestId,
        fileName: file.originalname,
        fileUrl: `/uploads/${UPLOAD_SUBDIR}/${storedName}`,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        uploadedBy: user.id,
      },
      include: ATTACHMENT_INCLUDE,
    });

    return {
      success: true as const,
      data: this.present(created),
      message: 'Attachment uploaded',
    };
  }

  /**
   * Remove an attachment.
   *
   * Soft-deleted, then unlinked. The row is what a leave request's history
   * refers to, so it stays; the file is what carries the medical detail, so it
   * goes. A failed unlink is logged rather than thrown — the record already
   * says the attachment is gone, and answering 500 would leave the caller
   * believing it is still there.
   */
  async remove(id: string, user: Principal) {
    const attachment = await this.prisma.leaveAttachment.findFirst({
      where: { id, deletedAt: null },
      include: {
        leaveRequest: {
          select: { employee: { select: { departmentId: true } } },
        },
      },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');

    const isOwner = attachment.uploadedBy === user.id;
    const isAdminOrHr =
      user.role === UserRole.ADMIN || user.role === UserRole.HR_MANAGER;
    const isDepartmentHead =
      user.role === UserRole.MANAGER &&
      !!attachment.leaveRequest.employee.departmentId &&
      attachment.leaveRequest.employee.departmentId === user.departmentId;

    if (!isOwner && !isAdminOrHr && !isDepartmentHead) {
      throw new ForbiddenException(
        'You do not have permission to delete this attachment',
      );
    }

    await this.prisma.leaveAttachment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    const storedName = attachment.fileUrl.split('/').pop();
    if (storedName) {
      await unlink(
        join(process.cwd(), 'uploads', UPLOAD_SUBDIR, storedName),
      ).catch((error: Error) =>
        this.logger.warn(
          `Attachment ${id} soft-deleted but its file could not be removed: ${error.message}`,
        ),
      );
    }

    return {
      success: true as const,
      data: { id },
      message: 'Attachment deleted',
    };
  }
}
