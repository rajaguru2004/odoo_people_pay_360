import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ReimbursementAttachmentsService } from './reimbursement-attachments.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/**
 * Coverage for reimbursement supporting-document handling:
 *   - uploadAndCreate(): parent existence, owner/HR authorization,
 *     owner-only-while-PENDING rule, size + mime validation, storage folder
 *   - findByReimbursement(): soft-deleted rows excluded, BigInt serialization
 *   - remove(): owner / HR / dept-manager authorization, storage delete
 *     tolerance, soft delete
 */
describe('ReimbursementAttachmentsService', () => {
  let service: ReimbursementAttachmentsService;

  let prisma: any;
  let storage: any;

  const EMPLOYEE_ID = 'emp-1';
  const DEPT_ID = 'dept-1';

  const OWNER = { id: 'user-emp', role: 'EMPLOYEE', employeeId: EMPLOYEE_ID, departmentId: DEPT_ID };
  const HR = { id: 'user-hr', role: 'HR_MANAGER', employeeId: 'emp-hr', departmentId: null };
  const SAME_DEPT_MANAGER = { id: 'user-mgr', role: 'MANAGER', employeeId: 'emp-mgr', departmentId: DEPT_ID };
  const OTHER_DEPT_MANAGER = { id: 'user-mgr2', role: 'MANAGER', employeeId: 'emp-mgr2', departmentId: 'dept-2' };

  const file = (overrides: any = {}): any => ({
    originalname: 'invoice one.pdf',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('pdf'),
    ...overrides,
  });

  const parent = (overrides: any = {}) => ({
    id: 'reimb-1',
    employeeId: EMPLOYEE_ID,
    status: 'PENDING',
    employee: { id: EMPLOYEE_ID, departmentId: DEPT_ID },
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      reimbursement: { findUnique: jest.fn() },
      reimbursementAttachment: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
    storage = {
      uploadFile: jest.fn().mockResolvedValue('https://s3/x/invoice.pdf'),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReimbursementAttachmentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = moduleRef.get(ReimbursementAttachmentsService);
  });

  // ── uploadAndCreate() ───────────────────────────────────────────────────────
  describe('uploadAndCreate', () => {
    const primeUpload = (parentOverrides: any = {}) => {
      prisma.reimbursement.findUnique.mockResolvedValue(parent(parentOverrides));
      prisma.reimbursementAttachment.create.mockResolvedValue({
        id: 'att-1',
        fileName: 'invoice one.pdf',
        fileSize: BigInt(1024),
        uploader: null,
      });
    };

    it('throws NotFound for a missing reimbursement', async () => {
      prisma.reimbursement.findUnique.mockResolvedValue(null);
      await expect(
        service.uploadAndCreate('missing', file(), OWNER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forbids a non-owner non-HR user', async () => {
      primeUpload();
      await expect(
        service.uploadAndCreate('reimb-1', file(), {
          ...OWNER,
          employeeId: 'someone-else',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('blocks the owner from attaching once the request is no longer PENDING', async () => {
      primeUpload({ status: 'APPROVED' });
      await expect(
        service.uploadAndCreate('reimb-1', file(), OWNER),
      ).rejects.toThrow(/pending/);
    });

    it('allows HR to attach even after approval', async () => {
      primeUpload({ status: 'APPROVED' });
      await expect(
        service.uploadAndCreate('reimb-1', file(), HR),
      ).resolves.toMatchObject({ success: true });
    });

    it('rejects a missing file', async () => {
      primeUpload();
      await expect(
        service.uploadAndCreate('reimb-1', undefined as any, OWNER),
      ).rejects.toThrow(/No file/);
    });

    it('rejects files over 10 MB', async () => {
      primeUpload();
      await expect(
        service.uploadAndCreate('reimb-1', file({ size: 11 * 1024 * 1024 }), OWNER),
      ).rejects.toThrow(/10 MB/);
      expect(storage.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects disallowed mime types', async () => {
      primeUpload();
      await expect(
        service.uploadAndCreate(
          'reimb-1',
          file({ mimetype: 'application/x-msdownload', originalname: 'evil.exe' }),
          OWNER,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.uploadFile).not.toHaveBeenCalled();
    });

    it.each(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'])(
      'accepts %s',
      async (mimetype) => {
        primeUpload();
        await expect(
          service.uploadAndCreate('reimb-1', file({ mimetype }), OWNER),
        ).resolves.toMatchObject({ success: true });
      },
    );

    it('uploads into the reimbursement-attachments storage folder with a de-spaced name', async () => {
      primeUpload();
      await service.uploadAndCreate('reimb-1', file(), OWNER);
      expect(storage.uploadFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.stringMatching(/invoice_one\.pdf$/),
        'reimbursement-attachments',
      );
    });

    it('persists the DB row with url, size and uploader, serializing BigInt size', async () => {
      primeUpload();
      const result = await service.uploadAndCreate('reimb-1', file(), OWNER);
      expect(prisma.reimbursementAttachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reimbursementId: 'reimb-1',
            fileName: 'invoice one.pdf',
            fileUrl: 'https://s3/x/invoice.pdf',
            uploadedBy: OWNER.id,
          }),
        }),
      );
      expect(result.data!.fileSize).toBe(1024);
    });
  });

  // ── findByReimbursement() ───────────────────────────────────────────────────
  describe('findByReimbursement', () => {
    const primeList = () => {
      prisma.reimbursement.findUnique.mockResolvedValue(parent());
      prisma.reimbursementAttachment.findMany.mockResolvedValue([
        { id: 'att-1', fileSize: BigInt(2048), uploader: null },
      ]);
    };

    it('lists only non-deleted attachments, newest first, with numeric sizes', async () => {
      primeList();
      const result = await service.findByReimbursement('reimb-1', OWNER);
      expect(prisma.reimbursementAttachment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { reimbursementId: 'reimb-1', deletedAt: null },
          orderBy: { uploadedAt: 'desc' },
        }),
      );
      expect(result.data[0]!.fileSize).toBe(2048);
    });

    it('refuses a caller who may not read the claim', async () => {
      // Listing receipts is exactly as sensitive as reading the claim: a
      // receipt names an amount, a merchant and a date. This used to take no
      // `user` at all and check nothing.
      primeList();
      await expect(
        service.findByReimbursement('reimb-1', OTHER_DEPT_MANAGER),
      ).rejects.toThrow(/permission to view this request/i);
      expect(prisma.reimbursementAttachment.findMany).not.toHaveBeenCalled();
    });

    it('admits HR and the department manager alongside the owner', async () => {
      for (const who of [HR, SAME_DEPT_MANAGER]) {
        prisma.reimbursementAttachment.findMany.mockClear();
        primeList();
        await expect(
          service.findByReimbursement('reimb-1', who),
        ).resolves.toBeDefined();
      }
    });

    it('404s on an unknown claim before it looks for attachments', async () => {
      prisma.reimbursement.findUnique.mockResolvedValue(null);
      await expect(
        service.findByReimbursement('missing', OWNER),
      ).rejects.toThrow(/not found/i);
    });
  });

  // ── remove() ────────────────────────────────────────────────────────────────
  describe('remove', () => {
    const primeRemove = (overrides: any = {}) => {
      prisma.reimbursementAttachment.findFirst.mockResolvedValue({
        id: 'att-1',
        uploadedBy: OWNER.id,
        fileUrl: 'https://s3/x/invoice.pdf',
        reimbursement: parent(),
        ...overrides,
      });
      prisma.reimbursementAttachment.update.mockResolvedValue({});
    };

    it('throws NotFound for a missing or already-deleted attachment', async () => {
      prisma.reimbursementAttachment.findFirst.mockResolvedValue(null);
      await expect(service.remove('att-1', HR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([
      ['uploader', OWNER],
      ['HR manager', HR],
      ['same-dept manager', SAME_DEPT_MANAGER],
    ])('allows the %s to delete', async (_label, user) => {
      primeRemove();
      await expect(service.remove('att-1', user)).resolves.toMatchObject({
        success: true,
      });
    });

    it('forbids a manager from another department', async () => {
      primeRemove();
      await expect(
        service.remove('att-1', OTHER_DEPT_MANAGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('soft deletes the row (never a hard delete)', async () => {
      primeRemove();
      await service.remove('att-1', HR);
      expect(prisma.reimbursementAttachment.update).toHaveBeenCalledWith({
        where: { id: 'att-1' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('still soft deletes when the storage delete fails', async () => {
      primeRemove();
      storage.deleteFile.mockRejectedValue(new Error('minio down'));
      await expect(service.remove('att-1', HR)).resolves.toMatchObject({
        success: true,
      });
      expect(prisma.reimbursementAttachment.update).toHaveBeenCalled();
    });
  });
});
