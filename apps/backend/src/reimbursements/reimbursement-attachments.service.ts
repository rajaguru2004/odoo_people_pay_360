import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class ReimbursementAttachmentsService {
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

  async uploadAndCreate(
    reimbursementId: string,
    file: Express.Multer.File,
    user: any,
  ) {
    const reimbursement = await this.prisma.reimbursement.findUnique({
      where: { id: reimbursementId },
      include: {
        employee: { select: { id: true, departmentId: true, branchId: true } },
      },
    });
    if (!reimbursement) {
      throw new NotFoundException('Reimbursement request not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(reimbursement.employee.branchId);

    // Owners may attach documents only while the request is still pending;
    // HR/Admin can attach at any stage.
    const isOwner = reimbursement.employeeId === user.employeeId;
    const isAdminOrHR = ['ADMIN', 'HR_MANAGER'].includes(user.role);
    if (!isOwner && !isAdminOrHR) {
      throw new ForbiddenException(
        'You do not have permission to attach files to this request',
      );
    }
    if (isOwner && !isAdminOrHR && reimbursement.status !== 'PENDING') {
      throw new BadRequestException(
        'Attachments can only be added while the request is pending',
      );
    }

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Validate size (max 10MB)
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      throw new BadRequestException('File size exceeds the 10 MB limit');
    }

    // Validate mime types (PDF, JPG, PNG)
    const ALLOWED_MIMES = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/jpg',
    ];
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Only PDF and JPG/PNG images are allowed',
      );
    }

    const uniqueName = `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
    const fileUrl = await this.storage.uploadFile(
      file.buffer,
      uniqueName,
      'reimbursement-attachments',
    );

    const attachment = await this.prisma.reimbursementAttachment.create({
      data: {
        reimbursementId,
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

  /**
   * Attachments for one claim.
   *
   * `user` is required: a receipt names an amount, a merchant and a date, and
   * listing them is exactly as sensitive as reading the claim itself. This
   * mirrors `AdvanceLoanAttachmentsService.findByRequest`, which has always
   * performed the same two checks — the omission here was the asymmetry, not
   * a policy.
   */
  async findByReimbursement(reimbursementId: string, user: any) {
    const reimbursement = await this.prisma.reimbursement.findUnique({
      where: { id: reimbursementId },
      select: {
        employeeId: true,
        employee: { select: { branchId: true, departmentId: true } },
      },
    });
    if (!reimbursement) {
      throw new NotFoundException('Reimbursement request not found');
    }
    // 404 (not 403) on a foreign branch so existence is never leaked.
    assertInBranch(reimbursement.employee.branchId);

    const isOwner = reimbursement.employeeId === user?.employeeId;
    const isAdminOrHR = ['ADMIN', 'HR_MANAGER'].includes(user?.role);
    const isDeptManager =
      user?.role === 'MANAGER' &&
      isDeptInManagerScope(user, reimbursement.employee.departmentId);
    if (!isOwner && !isAdminOrHR && !isDeptManager) {
      throw new ForbiddenException(
        'You do not have permission to view this request',
      );
    }

    const attachments = await this.prisma.reimbursementAttachment.findMany({
      where: { reimbursementId, deletedAt: null },
      include: this.attachmentInclude,
      orderBy: { uploadedAt: 'desc' },
    });
    return {
      success: true,
      data: attachments.map((a) => this.serializeAttachment(a)),
    };
  }

  async remove(id: string, user: any) {
    const attachment = await this.prisma.reimbursementAttachment.findFirst({
      where: { id, deletedAt: null },
      include: {
        reimbursement: {
          include: {
            employee: { select: { id: true, departmentId: true } },
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
      isDeptInManagerScope(user, attachment.reimbursement.employee.departmentId);

    if (!isOwner && !isAdminOrHR && !isDeptManager) {
      throw new ForbiddenException(
        'You do not have permission to delete this attachment',
      );
    }

    // Delete from storage
    try {
      await this.storage.deleteFile(attachment.fileUrl);
    } catch (err) {
      console.warn('Failed to delete file from storage:', err.message);
    }

    await this.prisma.reimbursementAttachment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { success: true, message: 'Attachment deleted successfully' };
  }
}
