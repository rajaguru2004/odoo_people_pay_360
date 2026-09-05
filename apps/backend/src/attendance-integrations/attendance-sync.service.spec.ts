import { Test, TestingModule } from '@nestjs/testing';
import { AttendancesService } from '../attendances/attendances.service';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceIntegrationsService } from './attendance-integrations.service';
import { AttendanceSyncService } from './attendance-sync.service';
import { ProviderRegistry } from './providers/provider.registry';
import { AttendanceProvider } from './types/attendance-provider.interface';
import { NormalizedAttendanceRecord } from './types/normalized-attendance';

/**
 * Sync engine behaviour, with the provider and Prisma faked.
 *
 * The contract under test is the part that protects existing data: which rows
 * the conflict guard refuses to touch, how an external id resolves to an
 * employee, and that a dry run writes nothing.
 */
describe('AttendanceSyncService', () => {
  let service: AttendanceSyncService;
  let prisma: any;
  let attendances: any;
  let fetched: NormalizedAttendanceRecord[];

  const INTEGRATION_ID = '11111111-1111-4111-8111-111111111111';
  const BRANCH_ID = '22222222-2222-4222-8222-222222222222';

  const integrationRow = {
    id: INTEGRATION_ID,
    branchId: BRANCH_ID,
    provider: 'mock',
    displayName: 'Mock Provider',
    enabled: true,
    baseUrl: 'https://example.test',
    authScheme: 'header',
    authHeaderName: 'x-key',
    authSecretEnc: 'plaintext-key', // exercises the not-encrypted fallback path
    externalBranchId: 'MOCK-BR',
    externalTenantId: null,
    options: {},
    conflictPolicy: 'PROVIDER_WINS_SAFE',
    syncIntervalMinutes: 15,
    lookbackDays: 3,
    autoCreateAbsent: false,
    lastSyncAt: null,
  };

  const employee = {
    id: 'emp-1',
    employeeCode: 'EMP001',
    fullName: 'Asha Rao',
    status: 'ACTIVE',
    branchId: BRANCH_ID,
    timezone: null,
    startDate: new Date(Date.UTC(2020, 0, 1)),
  };

  const mockProvider: AttendanceProvider = {
    key: 'mock',
    displayName: 'Mock',
    description: 'test double',
    configSchema: [],
    testConnection: jest.fn(),
    fetchRange: jest.fn(async () => fetched),
  };

  beforeEach(async () => {
    fetched = [];

    prisma = {
      attendanceIntegration: {
        findUnique: jest.fn().mockResolvedValue(integrationRow),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      attendanceSyncRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      employee: {
        findFirst: jest.fn().mockResolvedValue(employee),
        update: jest.fn().mockResolvedValue({}),
      },
      attendance: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      attendanceCorrection: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    attendances = {
      applySyncedAttendance: jest.fn().mockResolvedValue({}),
      // Identity-ish stub: the real one applies the tz + day-end boundary.
      resolveAttendanceDateKey: jest.fn(async (instant: Date) => {
        return new Date(
          Date.UTC(
            instant.getUTCFullYear(),
            instant.getUTCMonth(),
            instant.getUTCDate(),
          ),
        );
      }),
    };

    const registry = {
      get: jest.fn(() => mockProvider),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceSyncService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProviderRegistry, useValue: registry },
        { provide: AttendancesService, useValue: attendances },
        {
          provide: AttendanceIntegrationsService,
          useValue: {
            resolveRow: (row: any) => ({
              id: row.id,
              provider: row.provider,
              branchId: row.branchId,
              baseUrl: row.baseUrl,
              authScheme: row.authScheme,
              authHeaderName: row.authHeaderName,
              authSecret: 'secret',
              externalBranchId: row.externalBranchId,
              externalTenantId: row.externalTenantId,
              options: row.options ?? {},
              autoCreateAbsent: row.autoCreateAbsent,
            }),
          },
        },
      ],
    }).compile();

    service = module.get(AttendanceSyncService);
  });

  const record = (
    over: Partial<NormalizedAttendanceRecord> = {},
  ): NormalizedAttendanceRecord => ({
    externalEmployeeId: 'EMP001',
    businessDate: '2026-07-20',
    checkIn: new Date('2026-07-20T03:30:00.000Z'),
    checkOut: new Date('2026-07-20T12:30:00.000Z'),
    ...over,
  });

  describe('writes', () => {
    it('creates a row when none exists', async () => {
      fetched = [record()];

      const summary = await service.runManualSync(
        INTEGRATION_ID,
        '2026-07-20',
        '2026-07-20',
      );

      expect(attendances.applySyncedAttendance).toHaveBeenCalledTimes(1);
      expect(summary.created).toBe(1);
      expect(summary.status).toBe('OK');
    });

    it('marks the run PARTIAL when an external id has no employee', async () => {
      prisma.employee.findFirst.mockResolvedValue(null);
      fetched = [record({ externalEmployeeId: 'GHOST' })];

      const summary = await service.runManualSync(
        INTEGRATION_ID,
        '2026-07-20',
        '2026-07-20',
      );

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
      expect(summary.unmapped).toBe(1);
      expect(summary.status).toBe('PARTIAL');
      expect(summary.records[0].outcome).toBe('UNMAPPED');
    });

    it('does not rewrite a row the provider already agrees with', async () => {
      const r = record();
      prisma.attendance.findUnique.mockResolvedValue({
        id: 'att-1',
        status: 'PRESENT',
        source: 'SYNC',
        notes: null,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
      });
      fetched = [r];

      const summary = await service.runManualSync(
        INTEGRATION_ID,
        '2026-07-20',
        '2026-07-20',
      );

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
      expect(summary.created + summary.updated).toBe(0);
    });
  });

  describe('conflict guard (PROVIDER_WINS_SAFE)', () => {
    const existing = (over: Record<string, unknown>) => ({
      id: 'att-1',
      status: 'PRESENT',
      source: null,
      notes: null,
      checkIn: null,
      checkOut: null,
      ...over,
    });

    it('never overwrites an approved leave day', async () => {
      prisma.attendance.findUnique.mockResolvedValue(existing({ status: 'LEAVE' }));
      fetched = [record()];

      const summary = await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
      expect(summary.records.length + summary.skipped).toBeGreaterThan(0);
      expect(summary.created + summary.updated).toBe(0);
    });

    it('never overwrites a manual admin entry', async () => {
      prisma.attendance.findUnique.mockResolvedValue(existing({ source: 'MANUAL' }));
      fetched = [record()];

      await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
    });

    it('protects legacy manual rows that predate the source column', async () => {
      // source IS NULL, identified only by the note createManualAttendance writes.
      prisma.attendance.findUnique.mockResolvedValue(
        existing({ source: null, notes: 'Manually entered by admin' }),
      );
      fetched = [record()];

      await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
    });

    it('never overwrites a day with an approved correction', async () => {
      prisma.attendance.findUnique.mockResolvedValue(existing({ source: 'ESS' }));
      prisma.attendanceCorrection.findFirst.mockResolvedValue({ id: 'corr-1' });
      fetched = [record()];

      await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
    });

    it('DOES overwrite an auto-marked absence — the device is the better witness', async () => {
      prisma.attendance.findUnique.mockResolvedValue(
        existing({ status: 'ABSENT', source: 'AUTO' }),
      );
      fetched = [record()];

      const summary = await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).toHaveBeenCalledTimes(1);
      expect(summary.updated).toBe(1);
    });

    it('DOES overwrite an ESS punch', async () => {
      prisma.attendance.findUnique.mockResolvedValue(existing({ source: 'ESS' }));
      fetched = [record()];

      await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).toHaveBeenCalledTimes(1);
    });
  });

  describe('employee resolution', () => {
    it('backfills attendanceExternalId after matching on employeeCode', async () => {
      // First lookup (by external id) misses, second (by code) hits.
      prisma.employee.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(employee);
      fetched = [record()];

      await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(prisma.employee.update).toHaveBeenCalledWith({
        where: { id: 'emp-1' },
        data: { attendanceExternalId: 'EMP001' },
      });
    });

    it('skips a non-ACTIVE employee', async () => {
      prisma.employee.findFirst.mockResolvedValue({ ...employee, status: 'TERMINATED' });
      fetched = [record()];

      const summary = await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
      expect(summary.skipped).toBe(1);
    });

    it('skips a date before the employee started', async () => {
      prisma.employee.findFirst.mockResolvedValue({
        ...employee,
        startDate: new Date(Date.UTC(2026, 11, 1)),
      });
      fetched = [record()];

      const summary = await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
      expect(summary.skipped).toBe(1);
    });

    it('resolves each external id once per run, however many days it appears on', async () => {
      fetched = [
        record({ businessDate: '2026-07-20' }),
        record({
          businessDate: '2026-07-21',
          checkIn: new Date('2026-07-21T03:30:00.000Z'),
          checkOut: new Date('2026-07-21T12:30:00.000Z'),
        }),
      ];

      await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-21');

      expect(prisma.employee.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe('dry run', () => {
    it('writes nothing at all — not the attendance, not the id backfill', async () => {
      prisma.employee.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(employee);
      fetched = [record()];

      const summary = await service.preview(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
      expect(prisma.employee.update).not.toHaveBeenCalled();
      expect(prisma.attendanceIntegration.update).not.toHaveBeenCalled();
      expect(summary.created).toBe(1); // "would create"
      expect(summary.records[0].outcome).toBe('WOULD_CREATE');
    });

    it('returns every record so the operator can review before going live', async () => {
      fetched = [
        record(),
        record({ externalEmployeeId: 'EMP002', businessDate: '2026-07-20' }),
      ];

      const summary = await service.preview(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(summary.records).toHaveLength(2);
    });
  });

  describe('date key', () => {
    it('derives our attendance day from the punch instant, not the provider date', async () => {
      // Provider says the 19th; the instant belongs to the 20th.
      fetched = [
        record({
          businessDate: '2026-07-19',
          checkIn: new Date('2026-07-20T02:00:00.000Z'),
        }),
      ];

      await service.runManualSync(INTEGRATION_ID, '2026-07-19', '2026-07-20');

      expect(attendances.resolveAttendanceDateKey).toHaveBeenCalledWith(
        new Date('2026-07-20T02:00:00.000Z'),
        null,
      );
      const call = attendances.applySyncedAttendance.mock.calls[0][0];
      expect(call.dateKey.toISOString().slice(0, 10)).toBe('2026-07-20');
    });
  });

  describe('empty window', () => {
    it('does NOT report OK when the provider returned nothing', async () => {
      // The dangerous case: a wrong external branch id is accepted by the
      // provider and answers an empty list, so the connection would look
      // healthy forever while importing nothing.
      fetched = [];

      const summary = await service.runManualSync(
        INTEGRATION_ID,
        '2026-07-20',
        '2026-07-20',
      );

      expect(summary.fetched).toBe(0);
      expect(summary.status).toBe('PARTIAL');
      expect(summary.message).toMatch(/no attendance at all/i);
      expect(summary.message).toMatch(/external branch id/i);
    });

    it('records that message on the integration so the UI can surface it', async () => {
      fetched = [];
      await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      const stamp = prisma.attendanceIntegration.update.mock.calls.at(-1)[0];
      expect(stamp.data.lastSyncStatus).toBe('PARTIAL');
      expect(stamp.data.lastSyncError).toMatch(/no attendance at all/i);
    });

    it('still reports OK when records were fetched and all applied', async () => {
      fetched = [record()];
      const summary = await service.runManualSync(
        INTEGRATION_ID,
        '2026-07-20',
        '2026-07-20',
      );
      expect(summary.status).toBe('OK');
      expect(summary.message).toBeUndefined();
    });
  });

  describe('window validation', () => {
    it('rejects a range wider than 31 days', async () => {
      await expect(
        service.runManualSync(INTEGRATION_ID, '2026-01-01', '2026-03-01'),
      ).rejects.toThrow(/exceeds the 31-day limit/);
    });

    it('rejects an inverted range', async () => {
      await expect(
        service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-01'),
      ).rejects.toThrow(/cannot be earlier/);
    });
  });

  describe('records with nothing to say', () => {
    it('skips a day with no punch and no explicit absence', async () => {
      fetched = [record({ checkIn: null, checkOut: null, status: undefined })];

      const summary = await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).not.toHaveBeenCalled();
      expect(summary.skipped).toBe(1);
    });

    it('still writes an explicit ABSENT with no punch', async () => {
      fetched = [record({ checkIn: null, checkOut: null, status: 'ABSENT' })];

      await service.runManualSync(INTEGRATION_ID, '2026-07-20', '2026-07-20');

      expect(attendances.applySyncedAttendance).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ABSENT' }),
      );
    });
  });
});
