import { ConflictException, Logger } from '@nestjs/common';
import { LegalDocumentsService } from './legal-documents.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';

const prismaMock = () => ({
  employeeLegalDocument: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  employee: { findUnique: jest.fn() },
  $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
});

const settingsMock = () => ({ getNumber: jest.fn().mockResolvedValue(30) });

type PrismaMock = ReturnType<typeof prismaMock>;
type SettingsMock = ReturnType<typeof settingsMock>;

/** The first argument a mocked Prisma call received, typed for the assertion. */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as T[][])[0][0];
}

/** Midnight UTC `days` from today — the shape a `@db.Date` column comes back in. */
function utcDaysFromToday(days: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days),
  );
}

describe('LegalDocumentsService', () => {
  let prisma: PrismaMock;
  let settings: SettingsMock;
  let service: LegalDocumentsService;

  beforeEach(() => {
    prisma = prismaMock();
    settings = settingsMock();
    service = new LegalDocumentsService(
      prisma as unknown as PrismaService,
      settings as unknown as SystemSettingsService,
    );
  });

  describe('derived expiry fields', () => {
    it('counts forwards, backwards and to zero around today', async () => {
      prisma.employeeLegalDocument.findMany.mockResolvedValue([
        { id: 'doc-past', expiryDate: utcDaysFromToday(-5) },
        { id: 'doc-today', expiryDate: utcDaysFromToday(0) },
        { id: 'doc-soon', expiryDate: utcDaysFromToday(10) },
        { id: 'doc-far', expiryDate: utcDaysFromToday(200) },
      ]);
      prisma.employeeLegalDocument.count.mockResolvedValue(4);

      const result = await service.findAll({});

      expect(result.data.map((row) => row.daysUntilExpiry)).toEqual([
        -5, 0, 10, 200,
      ]);
      expect(result.data.map((row) => row.isExpiringSoon)).toEqual([
        false,
        true,
        true,
        false,
      ]);
    });

    it('widens the alert window when the setting says so', async () => {
      settings.getNumber.mockResolvedValue(90);
      prisma.employeeLegalDocument.findMany.mockResolvedValue([
        { id: 'doc-far', expiryDate: utcDaysFromToday(60) },
      ]);
      prisma.employeeLegalDocument.count.mockResolvedValue(1);

      const result = await service.findAll({});

      expect(result.data[0].isExpiringSoon).toBe(true);
    });
  });

  describe('create', () => {
    it('refuses a second current document in the same category', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'employee-1' });
      prisma.employeeLegalDocument.findFirst.mockResolvedValue({
        id: 'doc-existing',
        documentNumber: 'V-1',
      });

      await expect(
        service.create({
          employeeId: 'employee-1',
          documentNumber: 'V-2',
          country: 'Oman',
          issueDate: '2026-01-01',
          expiryDate: '2028-01-01',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.employeeLegalDocument.create).not.toHaveBeenCalled();
    });

    it('allows a second document when it is not marked current', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'employee-1' });
      prisma.employeeLegalDocument.create.mockResolvedValue({
        id: 'doc-2',
        expiryDate: utcDaysFromToday(400),
      });

      await service.create({
        employeeId: 'employee-1',
        documentNumber: 'V-2',
        country: 'Oman',
        issueDate: '2026-01-01',
        expiryDate: '2028-01-01',
        isCurrent: false,
      });

      expect(prisma.employeeLegalDocument.findFirst).not.toHaveBeenCalled();
      expect(prisma.employeeLegalDocument.create).toHaveBeenCalled();
    });
  });

  describe('renew', () => {
    const current = {
      id: 'doc-1',
      employeeId: 'employee-1',
      category: 'VISA',
      status: 'ACTIVE',
      documentNumber: 'V-1',
      documentType: 'Employment visa',
      country: 'Oman',
      nationality: 'IN',
      issuingAuthority: 'Royal Oman Police',
      placeOfIssue: 'Muscat',
      sponsor: 'People Pay 360',
      issueDate: new Date('2026-01-10'),
      expiryDate: new Date('2028-01-09'),
      isCurrent: true,
    };

    it('demotes the old row and links the replacement back to it', async () => {
      prisma.employeeLegalDocument.findUnique.mockResolvedValue(current);
      prisma.employeeLegalDocument.update.mockResolvedValue({
        ...current,
        status: 'RENEWED',
        isCurrent: false,
      });
      prisma.employeeLegalDocument.create.mockResolvedValue({
        id: 'doc-2',
        expiryDate: utcDaysFromToday(400),
      });

      const replacement = await service.renew('doc-1', {
        issueDate: '2028-01-10',
        expiryDate: '2030-01-09',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.employeeLegalDocument.update).toHaveBeenCalledWith({
        where: { id: 'doc-1' },
        data: { status: 'RENEWED', isCurrent: false },
      });
      expect(
        firstArg<{ data: Record<string, unknown> }>(
          prisma.employeeLegalDocument.create,
        ).data,
      ).toMatchObject({
        renewedFromId: 'doc-1',
        isCurrent: true,
        status: 'ACTIVE',
        employeeId: 'employee-1',
        category: 'VISA',
      });
      expect(replacement.id).toBe('doc-2');
    });

    it('carries over the details the caller did not restate', async () => {
      prisma.employeeLegalDocument.findUnique.mockResolvedValue(current);
      prisma.employeeLegalDocument.update.mockResolvedValue(current);
      prisma.employeeLegalDocument.create.mockResolvedValue({
        id: 'doc-2',
        expiryDate: utcDaysFromToday(400),
      });

      await service.renew('doc-1', {
        issueDate: '2028-01-10',
        expiryDate: '2030-01-09',
      });

      expect(
        firstArg<{ data: Record<string, unknown> }>(
          prisma.employeeLegalDocument.create,
        ).data,
      ).toMatchObject({
        documentNumber: 'V-1',
        sponsor: 'People Pay 360',
        issuingAuthority: 'Royal Oman Police',
      });
    });
  });

  describe('expireLapsedDocuments', () => {
    // The sweep reports what it did through the Nest logger; silencing it keeps
    // the run's output to test results.
    let log: jest.SpyInstance;

    beforeEach(() => {
      log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    });

    afterEach(() => log.mockRestore());

    it('only touches active rows whose date has passed', async () => {
      prisma.employeeLegalDocument.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.expireLapsedDocuments();

      const sweep = firstArg<{
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }>(prisma.employeeLegalDocument.updateMany);
      expect(sweep.where).toMatchObject({ status: 'ACTIVE' });
      expect(sweep.data).toEqual({ status: 'EXPIRED' });
      expect(result).toEqual({ expired: 3 });
    });
  });
});
