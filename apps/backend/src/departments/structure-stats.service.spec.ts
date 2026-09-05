import { DepartmentsService } from './departments.service';

/**
 * Governance of the structure, rather than the size of it.
 *
 * The Organization hub used to lead with "Departments: 7" and "Branches: 9" —
 * inventory that is the same number every week and that nobody acts on. These
 * are the structural facts somebody has to fix, and the consequence spelled
 * out: a department with no head leaves its people with no escalation path.
 */
describe('DepartmentsService.structureStats', () => {
  let departments: any[];
  let spanRows: any[];
  let supervisors: any[];

  const prisma: any = {
    department: {
      count: jest.fn(async () => departments.filter((d) => d.isActive).length),
      findMany: jest.fn(async ({ where }: any) =>
        departments.filter((d) => d.isActive && (where.managerId === null ? !d.managerId : true)),
      ),
    },
    employee: {
      groupBy: jest.fn(async () => spanRows),
      findMany: jest.fn(async ({ where }: any) =>
        supervisors.filter((s) => where.id.in.includes(s.id)),
      ),
    },
  };

  const service = new DepartmentsService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    departments = [
      { id: 'd1', name: 'Engineering', isActive: true, managerId: 'e-lead', _count: { employees: 12 } },
      { id: 'd2', name: 'Operations', isActive: true, managerId: null, _count: { employees: 8 } },
      { id: 'd3', name: 'Facilities', isActive: true, managerId: null, _count: { employees: 3 } },
    ];
    spanRows = [
      { supervisorId: 's1', _count: { _all: 14 } },
      { supervisorId: 's2', _count: { _all: 4 } },
    ];
    supervisors = [
      { id: 's1', fullName: 'Asha Rahman', department: { name: 'Engineering' } },
      { id: 's2', fullName: 'Karim Idris', department: null },
    ];
  });

  it('counts the departments nobody is heading', async () => {
    const res: any = await service.structureStats();
    expect(res.data.withoutHead).toBe(2);
  });

  it('spells out the headcount left without an escalation path', async () => {
    // The consequence, not the count: eleven people whose department has no
    // head have nobody to approve anything routed by department.
    const res: any = await service.structureStats();
    expect(res.data.unmanagedHeadcount).toBe(11);
  });

  it('names the headless departments so the list is actionable', async () => {
    const res: any = await service.structureStats();
    expect(res.data.headlessDepartments.map((d: any) => d.name)).toEqual(['Operations', 'Facilities']);
  });

  it('ranks the widest spans of control by name, not by id', async () => {
    // Fourteen direct reports is an org-design problem no headcount shows.
    const res: any = await service.structureStats();
    expect(res.data.spanOfControl[0]).toMatchObject({ name: 'Asha Rahman', reports: 14 });
  });
});
