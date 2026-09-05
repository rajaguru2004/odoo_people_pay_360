import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { assertInBranch } from '../common/branch/branch-scope.util';

const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

@Injectable()
export class LegalDocumentAttachmentsService {
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  private uploaderInclude = {
    uploadedBy: {
      select: {
        id: true,
        email: true,
        employee: { select: { fullName: true, avatarUrl: true } },
      },
    },
  };

  private serialize(attachment: any) {
    if (!attachment) return null;
    return {
      ...attachment,
      fileSize: attachment.fileSize != null ? Number(attachment.fileSize) : null,
    };
  }

  async uploadAndCreate(
    legalDocumentId: string,
    file: Express.Multer.File,
    user: any,
  ) {
    const doc = await this.prisma.employeeLegalDocument.findUnique({
      where: { id: legalDocumentId },
      include: { employee: { select: { id: true, branchId: true } } },
    });
    if (!doc) throw new NotFoundException('Legal document not found');
    assertInBranch(doc.employee.branchId);

    if (file.size > MAX_SIZE) {
      throw new BadRequestException('File size exceeds the 10 MB limit');
    }
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Invalid file type. Only PDF, JPG/PNG images and Word documents are allowed',
      );
    }

    const uniqueName = `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
    const fileUrl = await this.storage.uploadFile(
      file.buffer,
      uniqueName,
      'legal-document-attachments',
    );

    const attachment = await this.prisma.legalDocumentAttachment.create({
      data: {
        legalDocumentId,
        fileName: file.originalname,
        fileUrl,
        fileSize: BigInt(file.size),
        mimeType: file.mimetype,
        uploadedById: user?.id ?? null,
      },
      include: this.uploaderInclude,
    });

    return {
      success: true,
      message: 'Attachment uploaded successfully',
      data: this.serialize(attachment),
    };
  }

  async findByDocument(legalDocumentId: string) {
    const attachments = await this.prisma.legalDocumentAttachment.findMany({
      where: { legalDocumentId },
      include: this.uploaderInclude,
      orderBy: { uploadedAt: 'desc' },
    });
    return { success: true, data: attachments.map((a) => this.serialize(a)) };
  }

  async remove(id: string) {
    const attachment = await this.prisma.legalDocumentAttachment.findUnique({
      where: { id },
      include: {
        legalDocument: {
          include: { employee: { select: { branchId: true } } },
        },
      },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');
    assertInBranch(attachment.legalDocument.employee.branchId);

    await this.prisma.legalDocumentAttachment.delete({ where: { id } });

    // Best-effort storage cleanup — DB row is the source of truth.
    try {
      await this.storage.deleteFile(attachment.fileUrl);
    } catch {
      // ignore storage cleanup failures
    }

    return { success: true, message: 'Attachment deleted' };
  }
}
