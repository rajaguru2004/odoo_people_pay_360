import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { assertCanAccessEmployeeRecord } from '../common/services/record-access.util';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class LeaveAttachmentsService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  private attachmentInclude = {
    uploader: {
      select: {
        id: true,
        email: true,
        employee: { select: { fullName: true, avatarUrl: true } },
      },
    },
  };

  private serializeAttachment(attachment: any) {
    if (!attachment) return null;
    return {
      ...attachment,
      fileSize:
        attachment.fileSize !== null && attachment.fileSize !== undefined
          ? Number(attachment.fileSize)
          : null,
    };
  }

  async uploadAndCreate(leaveRequestId: string, file: Express.Multer.File, user: any) {
    if (!file) {
      throw new BadRequestException('A file is required');
    }

    const leaveRequest = await this.prisma.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      include: {
        employee: {
          select: {
            id: true,
            departmentId: true,
            branchId: true,
          },
        },
      },
    });
    if (!leaveRequest) {
      throw new NotFoundException('Leave request not found');
    }

    // These are medical certificates. Until this check existed, ANY
    // authenticated user could attach a file to ANY leave request, in any
    // branch — while `remove()` a few lines below authorised correctly.
    assertCanAccessEmployeeRecord(
      user,
      leaveRequest.employee,
      'attach files to',
    );

    // Validate size (max 10MB)
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      throw new BadRequestException('File size exceeds the 10 MB limit');
    }

    // Validate mime types (PDF, JPG, PNG)
    const ALLOWED_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Only PDF and JPG/PNG images are allowed');
    }

    const uniqueName = `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
    const fileUrl = await this.storage.uploadFile(
      file.buffer,
      uniqueName,
      'leave-attachments',
    );

    const attachment = await this.prisma.leaveAttachment.create({
      data: {
        leaveRequestId,
        fileName: file.originalname,
        fileUrl,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        uploadedBy: user.id,
      },
      include: this.attachmentInclude,
    });

    return {
      success: true,
      message: 'Attachment uploaded successfully',
      data: this.serializeAttachment(attachment),
    };
  }

  async findByLeaveRequest(leaveRequestId: string, user?: any) {
    // The parent is loaded purely to authorise: `LeaveAttachment` is now in
    // BRANCH_SCOPE, but branch scoping alone would still let a colleague in the
    // same branch read someone else's certificate.
    if (user) {
      const leaveRequest = await this.prisma.leaveRequest.findUnique({
        where: { id: leaveRequestId },
        include: {
          employee: {
            select: { id: true, departmentId: true, branchId: true },
          },
        },
      });
      // A request that does not exist has no attachments to hide; keep the
      // empty-list answer rather than inventing a 404 the door never gave.
      if (leaveRequest) {
        assertCanAccessEmployeeRecord(user, leaveRequest.employee, 'view');
      }
    }

    const attachments = await this.prisma.leaveAttachment.findMany({
      where: { leaveRequestId, deletedAt: null },
      include: this.attachmentInclude,
      orderBy: { uploadedAt: 'desc' },
    });
    return {
      success: true,
      data: attachments.map((a) => this.serializeAttachment(a)),
    };
  }

  async remove(id: string, user: any) {
    const attachment = await this.prisma.leaveAttachment.findFirst({
      where: { id, deletedAt: null },
      include: {
        leaveRequest: {
          include: {
            employee: {
              select: {
                id: true,
                departmentId: true,
              },
            },
          },
        },
      },
    });
    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }

    // Authorization: owner, admin, hr manager, or manager of employee's department
    const isOwner = attachment.uploadedBy === user.id;
    const isAdminOrHR = ['ADMIN', 'HR_MANAGER'].includes(user.role);
    const isDeptManager =
      user.role === 'MANAGER' &&
      isDeptInManagerScope(user, attachment.leaveRequest.employee.departmentId);

    if (!isOwner && !isAdminOrHR && !isDeptManager) {
      throw new ForbiddenException('You do not have permission to delete this attachment');
    }

    // Delete from storage
    try {
      await this.storage.deleteFile(attachment.fileUrl);
    } catch (err) {
      console.warn('Failed to delete file from MinIO storage:', err.message);
    }

    await this.prisma.leaveAttachment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { success: true, message: 'Attachment deleted successfully' };
  }
}
