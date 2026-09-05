import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertInBranch } from '../common/branch/branch-scope.util';
import { getBranchContext } from '../common/branch/branch-context';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { LoanAccessService } from './loan-access.service';

@Injectable()
export class AdvanceLoanAttachmentsService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private audit: AuditService,
    private access: LoanAccessService,
  ) {}

  /**
   * The attachment half of a loan's audit trail (§10).
   *
   * Keyed to the LOAN, never to the attachment: "what happened to this loan"
   * is the question an auditor asks, and a row filed under an attachment id is
   * invisible to it. `resourceType` is 'AdvanceLoan' — the value the whole
   * module is standardising on (§9) — so these rows sit in the same stream as
   * the lifecycle rows rather than starting a fourth one.
   *
   * The interceptor's own CREATE / DELETE row for the same request is the
   * envelope (actor, IP, user agent); this one carries the identity of the file,
   * which the interceptor has no way to see: Multer has already consumed the
   * multipart body by the time it reads `request.body`, and a DELETE has no
   * body to read.
   */
  private async trail(
    action: 'LOAN_ATTACHMENT_UPLOADED' | 'LOAN_ATTACHMENT_DELETED',
    loan: { id: string; employee?: { branchId?: string | null } | null },
    attachment: {
      id: string;
      fileName: string;
      fileUrl: string;
      mimeType?: string | null;
      fileSize?: bigint | number | null;
    },
    user: any,
  ) {
    const detail = {
      attachmentId: attachment.id,
      requestId: loan.id,
      fileName: attachment.fileName,
      fileUrl: attachment.fileUrl,
      mimeType: attachment.mimeType ?? null,
      // BigInt does not survive JSON.stringify, which is how the audit row is
      // written — Number is safe here, the upload cap is 10 MB.
      fileSize:
        attachment.fileSize === null || attachment.fileSize === undefined
          ? null
          : Number(attachment.fileSize),
    };
    await this.audit.log({
      userId: user?.id,
      action,
      resourceType: 'AdvanceLoan',
      resourceId: loan.id,
      // A delete removes the evidence, so the row has to carry what was there;
      // an upload adds it, so the row carries what arrived.
      oldData: action === 'LOAN_ATTACHMENT_DELETED' ? detail : null,
      newData: action === 'LOAN_ATTACHMENT_UPLOADED' ? detail : null,
      branchId:
        getBranchContext()?.effectiveBranchId ??
        loan.employee?.branchId ??
        null,
    });
  }

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
    requestId: string,
    file: Express.Multer.File,
    user: any,
  ) {
    const request = await this.prisma.advanceLoanRequest.findUnique({
      where: { id: requestId },
      include: {
        employee: { select: { id: true, departmentId: true, branchId: true } },
      },
    });
    if (!request) {
      throw new NotFoundException('Advance/loan request not found');
    }

    // Object-level branch guard (findUnique bypasses auto-scoping).
    assertInBranch(request.employee.branchId);

    // Owners may attach documents only while the request is still pending;
    // HR/Admin can attach at any stage.
    const isOwner = request.employeeId === user.employeeId;
    const isAdminOrHR = ['ADMIN', 'HR_MANAGER'].includes(user.role);
    if (!isOwner && !isAdminOrHR) {
      throw new ForbiddenException(
        'You do not have permission to attach files to this request',
      );
    }
    if (isOwner && !isAdminOrHR && request.status !== 'PENDING') {
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
      'advance-loan-attachments',
    );

    const attachment = await this.prisma.advanceLoanAttachment.create({
      data: {
        requestId,
        fileName: file.originalname,
        fileUrl,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        uploadedBy: user.id,
      },
      include: this.attachmentInclude,
    });

    // After the row exists, so an audited upload is one that actually happened.
    await this.trail('LOAN_ATTACHMENT_UPLOADED', request, attachment, user);

    return {
      success: true,
      message: 'Attachment uploaded successfully',
      data: this.serializeAttachment(attachment),
    };
  }

  /**
   * List a request's attachments.
   *
   * `user` is REQUIRED. Without it this route was an intra-branch horizontal
   * privilege escalation: any authenticated employee holding a loan id could
   * list a colleague's attachment filenames and URLs. Branch scoping alone did
   * not cover it, and loan attachments are served from public storage, so the
   * returned URL is fetchable without a token.
   */
  async findByRequest(requestId: string, user: any) {
    const request = await this.prisma.advanceLoanRequest.findUnique({
      where: { id: requestId },
      select: {
        employeeId: true,
        employee: { select: { branchId: true, departmentId: true } },
      },
    });
    if (!request) {
      throw new NotFoundException('Advance/Loan request not found');
    }
    // 404 (not 403) on a foreign branch so existence is never leaked.
    assertInBranch(request.employee.branchId);
    await this.access.assertCanViewLoan(request, user);

    const attachments = await this.prisma.advanceLoanAttachment.findMany({
      where: { requestId, deletedAt: null },
      include: this.attachmentInclude,
      orderBy: { uploadedAt: 'desc' },
    });
    return {
      success: true,
      data: attachments.map((a) => this.serializeAttachment(a)),
    };
  }

  async remove(id: string, user: any) {
    const attachment = await this.prisma.advanceLoanAttachment.findFirst({
      where: { id, deletedAt: null },
      include: {
        request: {
          include: {
            employee: {
              select: { id: true, departmentId: true, branchId: true },
            },
          },
        },
      },
    });
    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }

    // Object-level branch guard: findFirst bypasses the auto-scoping middleware,
    // so without this a cross-branch HR_MANAGER passed on isAdminOrHR alone.
    assertInBranch(attachment.request.employee.branchId);

    // Authorization: owner, admin, hr manager, or manager of employee's department
    const isOwner = attachment.uploadedBy === user.id;
    const isAdminOrHR = ['ADMIN', 'HR_MANAGER'].includes(user.role);
    const isDeptManager =
      user.role === 'MANAGER' &&
      isDeptInManagerScope(user, attachment.request.employee.departmentId);

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

    await this.prisma.advanceLoanAttachment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    // The file is gone from storage by now, so this row is the only remaining
    // record that it was ever attached to this loan.
    await this.trail(
      'LOAN_ATTACHMENT_DELETED',
      attachment.request,
      attachment,
      user,
    );

    return { success: true, message: 'Attachment deleted successfully' };
  }
}
