import { IdEnricherService } from './id-enricher.service';

const EMP_A = '1ca1dc19-2305-4e3d-b108-d0b928338f79';
const EMP_B = '2ca1dc19-2305-4e3d-b108-d0b928338f79';
const DEPT = '3ca1dc19-2305-4e3d-b108-d0b928338f79';
const BRANCH = '4ca1dc19-2305-4e3d-b108-d0b928338f79';

describe('IdEnricherService', () => {
  let prisma: any;
  let service: IdEnricherService;

  beforeEach(() => {
    prisma = {
      employee: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: EMP_A,
            fullName: 'Aarav Sharma',
            employeeCode: 'SMP-EMP-001',
            position: 'Engineer',
            department: { name: 'Engineering' },
          },
        ]),
      },
      department: { findMany: jest.fn().mockResolvedValue([{ id: DEPT, name: 'Finance' }]) },
      branch: { findMany: jest.fn().mockResolvedValue([{ id: BRANCH, name: 'Head Office' }]) },
      project: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new IdEnricherService(prisma);
  });

  it('injects employee name/code/department next to employeeId — deep and in arrays', async () => {
    const payload: any = {
      data: {
        schedules: [
          { id: 'x', employeeId: EMP_A, date: '2026-07-01', shiftType: 'FULL_DAY' },
          { id: 'y', employeeId: EMP_B, date: '2026-07-02', shiftType: 'FULL_DAY' },
        ],
      },
    };
    const out: any = await service.enrich(payload);
    const [a, b] = out.data.schedules;
    expect(a.employeeName).toBe('Aarav Sharma');
    expect(a.employeeCode).toBe('SMP-EMP-001');
    expect(a.departmentName).toBe('Engineering');
    // unknown id -> untouched, no crash
    expect(b.employeeName).toBeUndefined();
    expect(b.employeeId).toBe(EMP_B);
  });

  it('resolves department/branch keys and respects existing fields', async () => {
    const payload: any = {
      departmentId: DEPT,
      branchId: BRANCH,
      managerId: EMP_A,
      managerName: 'Already Set',
    };
    const out: any = await service.enrich(payload);
    expect(out.departmentName).toBe('Finance');
    expect(out.branchName).toBe('Head Office');
    expect(out.managerName).toBe('Already Set'); // never overwrites
    expect(out.managerCode).toBe('SMP-EMP-001');
  });

  it('is a no-op without matching ids and never throws on lookup failure', async () => {
    expect(await service.enrich({ a: 1, b: 'text' })).toEqual({ a: 1, b: 'text' });
    prisma.employee.findMany.mockRejectedValue(new Error('db down'));
    const payload = { employeeId: EMP_A };
    expect(await service.enrich(payload)).toEqual(payload); // best-effort
  });
});
