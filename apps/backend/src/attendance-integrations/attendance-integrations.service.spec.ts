import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceIntegrationsService } from './attendance-integrations.service';
import { ProviderRegistry } from './providers/provider.registry';

/**
 * Employee-mapping behaviour.
 *
 * The name matcher exists to make linking ~90 people practical, but a wrong
 * link silently attributes one person's attendance to another and that flows
 * into payroll. So the contract under test is as much about what it REFUSES to
 * call confident as about what it matches.
 */
describe('AttendanceIntegrationsService — mapping', () => {
  let service: AttendanceIntegrationsService;
  let prisma: any;

  const INTEGRATION_ID = '11111111-1111-4111-8111-111111111111';
  const BRANCH_ID = '22222222-2222-4222-8222-222222222222';

  /** Names taken from the live Taageer roster. */
  const roster = [
    { id: 'e1', employeeCode: 'T001', fullName: 'Mahran Al Balushi', position: 'Officer' },
    { id: 'e2', employeeCode: 'T002', fullName: 'Rabha Al Suleimany', position: 'Officer' },
    { id: 'e3', employeeCode: 'T003', fullName: 'Maryam Alawi Al Gilani', position: 'Analyst' },
    { id: 'e4', employeeCode: 'T004', fullName: 'Deepak Devassy', position: 'Engineer' },
  ];

  const unmappedDetails = (rows: { externalEmployeeId: string; externalEmployeeName?: string }[]) => [
    {
      startedAt: new Date(),
      details: rows.map((r) => ({ ...r, outcome: 'UNMAPPED' })),
    },
  ];

  beforeEach(async () => {
    prisma = {
      attendanceIntegration: {
        findUnique: jest.fn().mockResolvedValue({
          id: INTEGRATION_ID,
          branchId: BRANCH_ID,
          provider: 'mock',
        }),
      },
      attendanceSyncRun: { findMany: jest.fn().mockResolvedValue([]) },
      employee: {
        findMany: jest.fn().mockResolvedValue(roster),
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceIntegrationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProviderRegistry, useValue: { get: jest.fn(), list: jest.fn(() => []) } },
      ],
    }).compile();

    service = module.get(AttendanceIntegrationsService);
  });

  describe('suggestions', () => {
    it('matches an exact name with confidence', async () => {
      prisma.attendanceSyncRun.findMany.mockResolvedValue(
        unmappedDetails([
          { externalEmployeeId: 'employee-taageer-672', externalEmployeeName: 'Mahran Al Balushi' },
        ]),
      );

      const [s] = await service.suggestMappings(INTEGRATION_ID);

      expect(s.confident).toBe(true);
      expect(s.suggestions[0].employeeCode).toBe('T001');
      expect(s.suggestions[0].score).toBe(1);
    });

    it('matches across a transliteration difference (Balushi/Bulushi)', async () => {
      prisma.attendanceSyncRun.findMany.mockResolvedValue(
        unmappedDetails([
          { externalEmployeeId: 'x1', externalEmployeeName: 'Mahran Al Bulushi' },
        ]),
      );

      const [s] = await service.suggestMappings(INTEGRATION_ID);
      expect(s.suggestions[0].employeeCode).toBe('T001');
      expect(s.confident).toBe(true);
    });

    it('ignores the Al/bin particles rather than treating them as names', async () => {
      prisma.attendanceSyncRun.findMany.mockResolvedValue(
        unmappedDetails([{ externalEmployeeId: 'x1', externalEmployeeName: 'Rabha Suleimany' }]),
      );

      const [s] = await service.suggestMappings(INTEGRATION_ID);
      expect(s.suggestions[0].employeeCode).toBe('T002');
    });

    it('is NOT confident when the provider sends no name', async () => {
      prisma.attendanceSyncRun.findMany.mockResolvedValue(
        unmappedDetails([{ externalEmployeeId: 'employee-taageer-999' }]),
      );

      const [s] = await service.suggestMappings(INTEGRATION_ID);
      expect(s.confident).toBe(false);
      expect(s.suggestions).toHaveLength(0);
    });

    it('is NOT confident when nothing on the roster resembles the name', async () => {
      prisma.attendanceSyncRun.findMany.mockResolvedValue(
        unmappedDetails([{ externalEmployeeId: 'x1', externalEmployeeName: 'Zhang Wei' }]),
      );

      const [s] = await service.suggestMappings(INTEGRATION_ID);
      expect(s.confident).toBe(false);
    });

    it('never proposes the same employee for two external ids', async () => {
      prisma.attendanceSyncRun.findMany.mockResolvedValue(
        unmappedDetails([
          { externalEmployeeId: 'x1', externalEmployeeName: 'Deepak Devassy' },
          { externalEmployeeId: 'x2', externalEmployeeName: 'Deepak Devassy' },
        ]),
      );

      const out = await service.suggestMappings(INTEGRATION_ID);
      const confidentPicks = out
        .filter((s) => s.confident)
        .map((s) => s.suggestions[0].employeeId);

      expect(new Set(confidentPicks).size).toBe(confidentPicks.length);
      expect(confidentPicks).toHaveLength(1); // the second must be left to a human
    });
  });

  describe('bulk mapping', () => {
    beforeEach(() => {
      prisma.employee.findUnique.mockImplementation(({ where }: any) => {
        const e = roster.find((r) => r.id === where.id);
        return Promise.resolve(e ? { ...e, branchId: BRANCH_ID } : null);
      });
    });

    it('links every valid entry', async () => {
      const res = await service.bulkMapEmployees(INTEGRATION_ID, [
        { externalId: 'x1', employeeId: 'e1' },
        { externalId: 'x2', employeeId: 'e2' },
      ]);

      expect(res.linked).toBe(2);
      expect(res.failed).toBe(0);
      expect(prisma.employee.update).toHaveBeenCalledTimes(2);
    });

    it('reports a bad entry without failing the rest of the batch', async () => {
      prisma.employee.findUnique.mockImplementation(({ where }: any) =>
        where.id === 'ghost'
          ? Promise.resolve(null)
          : Promise.resolve({ ...roster[0], id: where.id, branchId: BRANCH_ID }),
      );

      const res = await service.bulkMapEmployees(INTEGRATION_ID, [
        { externalId: 'x1', employeeId: 'e1' },
        { externalId: 'x2', employeeId: 'ghost' },
        { externalId: 'x3', employeeId: 'e3' },
      ]);

      expect(res.linked).toBe(2);
      expect(res.failed).toBe(1);
      expect(res.results.find((r) => r.employeeId === 'ghost')?.message).toMatch(/not found/i);
    });

    it('rejects an employee used twice in one batch', async () => {
      const res = await service.bulkMapEmployees(INTEGRATION_ID, [
        { externalId: 'x1', employeeId: 'e1' },
        { externalId: 'x2', employeeId: 'e1' },
      ]);

      expect(res.linked).toBe(1);
      expect(res.results[1].message).toMatch(/already used in this batch/i);
    });

    it('rejects a duplicated external id in one batch', async () => {
      const res = await service.bulkMapEmployees(INTEGRATION_ID, [
        { externalId: 'x1', employeeId: 'e1' },
        { externalId: 'x1', employeeId: 'e2' },
      ]);

      expect(res.linked).toBe(1);
      expect(res.results[1].message).toMatch(/duplicate external id/i);
    });

    it('refuses an employee from another branch', async () => {
      prisma.employee.findUnique.mockResolvedValue({
        ...roster[0],
        branchId: 'some-other-branch',
      });

      const res = await service.bulkMapEmployees(INTEGRATION_ID, [
        { externalId: 'x1', employeeId: 'e1' },
      ]);

      expect(res.linked).toBe(0);
      expect(res.results[0].message).toMatch(/different branch/i);
    });
  });
});
