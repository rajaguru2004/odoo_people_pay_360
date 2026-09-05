import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ProjectAccessService } from '../projects/rbac/project-access.service';
import { PROJECT_PERMISSIONS } from '../projects/rbac/permissions.constants';
import { SecureFile } from '../storage/secure-download.registry';
import { CreateTaskAttachmentDto } from './dto/create-task-attachment.dto';
import {
  TASK_ATTACHMENT_ALLOWED_MIMES,
  TASK_ATTACHMENT_FOLDER,
  TASK_ATTACHMENT_MIME_MESSAGE,
} from './task-attachment.constants';

@Injectable()
export class TaskAttachmentsService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private access: ProjectAccessService,
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
      // A `private://` ref is deliberately not a URL and nothing may render it
      // (see StorageService.PRIVATE_REF_PREFIX). The authenticated route that
      // CAN serve it is named here so a client never has to build it, and rows
      // predating the private door keep serving their own public `fileUrl`.
      downloadUrl: StorageService.isPrivateRef(attachment.fileUrl)
        ? `/secure-files/task-attachment/${attachment.id}`
        : attachment.fileUrl,
    };
  }

  /**
   * A URL this module issued, and nothing else (finding R53).
   *
   * `POST /task-attachments` took `@IsString()` and wrote it verbatim, so an
   * attachment could be made to point at ANY string — including another
   * module's `private://` ref, which the frontend's `resolveFileUrl` would
   * happily render, and which `GET /secure-files/task-attachment/:id` would
   * then stream after authorising against the wrong project entirely.
   */
  private assertRegisterableUrl(fileUrl: string) {
    if (StorageService.isPrivateRef(fileUrl)) {
      throw new BadRequestException(
        'A private storage ref cannot be registered as a task attachment — upload the file through POST /task-attachments/upload/:taskId',
      );
    }
    const isHttp = /^https?:\/\/[^\s]+$/i.test(fileUrl);
    const isLocalUpload = /^\/uploads\/[^\s]+$/i.test(fileUrl);
    if (!isHttp && !isLocalUpload) {
      throw new BadRequestException(
        'fileUrl must be a storage URL issued by this application',
      );
    }
    // Narrower still: it has to live in this module's own folder. Registering
    // a payslip's object under a task is not a different kind of typo.
    if (!fileUrl.includes(`/${TASK_ATTACHMENT_FOLDER}/`)) {
      throw new BadRequestException(
        `fileUrl must point at an object this module uploaded (/${TASK_ATTACHMENT_FOLDER}/...)`,
      );
    }
  }

  private assertAllowedMime(mimeType?: string | null) {
    if (!mimeType) return;
    if (!TASK_ATTACHMENT_ALLOWED_MIMES.includes(mimeType as any)) {
      throw new BadRequestException(TASK_ATTACHMENT_MIME_MESSAGE);
    }
  }

  async uploadAndCreate(taskId: string, file: Express.Multer.File, user: any) {
    // Finding R53: `file.originalname` was dereferenced before anything was
    // checked, so a multipart request carrying no file at all — the shape a
    // form posts when the user forgets to pick one — answered 500.
    if (!file) {
      throw new BadRequestException('A file is required');
    }

    const task = await this.prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
    });
    if (!task) throw new NotFoundException('Task not found');

    // The interceptor's `fileFilter` is the real gate; this is the same rule
    // asked again for any caller that reaches the service directly.
    this.assertAllowedMime(file.mimetype);

    const safeName = file.originalname
      .replace(/[\\/]+/g, '_')
      .replace(/\s+/g, '_');
    const uniqueName = `${Date.now()}-${safeName}`;
    // Finding R53, the sharpest half: this was `uploadFile`, the PUBLIC door,
    // whose bucket carries an allow-all `s3:GetObject` policy — so `fileUrl`
    // was an unsigned URL and THE URL WAS THE ENTIRE CREDENTIAL for a member's
    // `severance-schedule-*.pdf`. Letters, grievance attachments and vault
    // documents have always taken the private door; this now does too, and is
    // read back through `GET /secure-files/task-attachment/:id`.
    const fileUrl = await this.storage.uploadPrivateFile(
      file.buffer,
      uniqueName,
      TASK_ATTACHMENT_FOLDER,
    );

    const attachment = await this.prisma.taskAttachment.create({
      data: {
        taskId,
        fileName: file.originalname,
        fileUrl,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        uploadedBy: user.id,
      },
      include: this.attachmentInclude,
    });

    await this.prisma.taskActivity.create({
      data: {
        taskId,
        actorId: user.id,
        activityType: 'ATTACHMENT_ADDED',
        description: `Attachment "${file.originalname}" added`,
      },
    });

    return {
      success: true,
      message: 'Attachment uploaded',
      data: this.serializeAttachment(attachment),
    };
  }

  async create(dto: CreateTaskAttachmentDto, user: any) {
    const task = await this.prisma.task.findFirst({
      where: { id: dto.taskId, deletedAt: null },
    });
    if (!task) throw new NotFoundException('Task not found');

    this.assertRegisterableUrl(dto.fileUrl);
    this.assertAllowedMime(dto.mimeType);

    const attachment = await this.prisma.taskAttachment.create({
      data: {
        taskId: dto.taskId,
        fileName: dto.fileName,
        fileUrl: dto.fileUrl,
        mimeType: dto.mimeType,
        uploadedBy: user.id,
      },
      include: this.attachmentInclude,
    });

    await this.prisma.taskActivity.create({
      data: {
        taskId: dto.taskId,
        actorId: user.id,
        activityType: 'ATTACHMENT_ADDED',
        description: `Attachment "${dto.fileName}" added`,
      },
    });

    return {
      success: true,
      message: 'Attachment added',
      data: this.serializeAttachment(attachment),
    };
  }

  async findByTask(taskId: string) {
    const attachments = await this.prisma.taskAttachment.findMany({
      where: { taskId, deletedAt: null },
      include: this.attachmentInclude,
      orderBy: { uploadedAt: 'desc' },
    });
    return {
      success: true,
      data: attachments.map((a) => this.serializeAttachment(a)),
    };
  }

  /**
   * Locate a task attachment's private object and decide access in one step —
   * the `SecureDownloadResolver` contract, and the same shape as
   * `LettersService.fileFor` (finding R53).
   *
   * Authorises on the PROJECT, exactly as `ProjectPermissionGuard` does for
   * `GET /task-attachments/task/:taskId`: membership (any project role, the
   * owner, or a global admin) is what it takes to read this project's work.
   * `/secure-files/:kind/:id` carries only JwtAuthGuard + RolesGuard, so this
   * method IS the authorisation — throwing is mandatory, because returning
   * null is read as "not found".
   */
  async fileFor(id: string, user: any): Promise<SecureFile | null> {
    const attachment = await this.prisma.taskAttachment
      .findFirst({
        where: { id, deletedAt: null },
        include: {
          task: { select: { projectId: true } },
          uploader: { select: { employeeId: true } },
        },
      })
      .catch(() => null);
    if (!attachment) return null;

    const projectId = attachment.task?.projectId ?? null;
    if (!projectId) {
      // A task outside every project has no membership to ask about. Only the
      // uploader and a global admin can have it.
      const isUploader = attachment.uploadedBy === user?.id;
      if (!isUploader && !['ADMIN', 'HR_MANAGER'].includes(user?.role)) {
        throw new ForbiddenException('Not permitted to download this file');
      }
    } else {
      const access = await this.access.getAccess(projectId, user);
      const isMember =
        access.isGlobalAdmin || access.isOwner || access.roleSlug !== null;
      if (!isMember) {
        throw new ForbiddenException('You must be a member of this project');
      }
    }

    if (!StorageService.isPrivateRef(attachment.fileUrl)) {
      // A row written before the private door existed. Its object is in the
      // public bucket and still readable at its own `fileUrl`; there is
      // nothing private here to stream, and pretending otherwise would 500
      // inside `readPrivateFile`.
      throw new NotFoundException(
        'This attachment predates private storage and is served from its own fileUrl',
      );
    }

    return {
      ref: attachment.fileUrl,
      fileName: attachment.fileName,
      ownerEmployeeId: attachment.uploader?.employeeId ?? null,
    };
  }

  async remove(id: string, user: any) {
    const attachment = await this.prisma.taskAttachment.findFirst({
      where: { id, deletedAt: null },
      include: { task: { select: { projectId: true } } },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');

    // Finding R54: this authorised on `uploadedBy` OR the caller's GLOBAL role,
    // and never on the project — so any MANAGER anywhere in the company could
    // delete a member's file out of a project they are not in. Somebody else's
    // file now needs authority over THIS project's work.
    const projectId = attachment.task?.projectId ?? null;
    const canManageProjectFiles =
      ['ADMIN', 'HR_MANAGER'].includes(user?.role) ||
      (!!projectId &&
        (await this.access.has(
          projectId,
          user,
          PROJECT_PERMISSIONS.TASK_DELETE,
        )));

    if (attachment.uploadedBy !== user.id && !canManageProjectFiles) {
      throw new ForbiddenException('You can only delete your own attachments');
    }

    // Delete from storage
    try {
      await this.storage.deleteFile(attachment.fileUrl);
    } catch {
      // Continue even if storage delete fails
    }

    await this.prisma.taskAttachment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.prisma.taskActivity.create({
      data: {
        taskId: attachment.taskId,
        actorId: user.id,
        activityType: 'ATTACHMENT_REMOVED',
        description: `Attachment "${attachment.fileName}" removed`,
      },
    });

    return { success: true, message: 'Attachment deleted' };
  }
}
