import { DepartmentsService } from './departments.service';

/**
 * These tests lock in the multi-department-manager feature: an employee who
 * already heads one department may be assigned as the head of another. Before
 * the feature, create()/update()/assignManager() each threw
 * `This employee is already managing <name>`.
 */
describe('DepartmentsService — one manager, many departments', () => {
  const activeManager = {
    id: 'emp-1',
    departmentId: 'dept-a',
    status: 'ACTIVE',
    user: { id: 'user-1', role: 'EMPLOYEE' },
  };

  const makePrisma = (overrides: any = {}) => ({
    department: {
      findUnique: jest.fn(),
      findFirst: jest.fn(), // must never be called for the removed guard
      create: jest.fn().mockResolvedValue({ id: 'dept-b', name: 'Dept B' }),
      update: jest.fn().mockResolvedValue({ id: 'dept-b', name: 'Dept B' }),
      ...(overrides.department || {}),
    },
    employee: {
      findUnique: jest.fn().mockResolvedValue(activeManager),
      ...(overrides.employee || {}),
    },
    user: {
      update: jest.fn().mockResolvedValue({ id: 'user-1', role: 'MANAGER' }),
      ...(overrides.user || {}),
    },
  });

  const svc = (prisma: any) => new DepartmentsService(prisma as any);

  it('create(): assigns a manager who already heads another department', async () => {
    const prisma = makePrisma({
      department: {
        findUnique: jest.fn().mockResolvedValue(null), // code is free
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'dept-b', name: 'Dept B' }),
      },
    });

    const res = await svc(prisma).create({
      code: 'DEPTB',
      name: 'Dept B',
      managerId: 'emp-1',
    } as any);

    expect(res.success).toBe(true);
    // The single-department guard used department.findFirst — it must be gone.
    expect(prisma.department.findFirst).not.toHaveBeenCalled();
    expect(prisma.department.create).toHaveBeenCalledTimes(1);
  });

  it('update(): re-points a department to a manager who already heads another', async () => {
    const prisma = makePrisma({
      department: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'dept-b',
          code: 'DEPTB',
          parentId: null,
          _count: { employees: 0 },
        }),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'dept-b' }),
      },
    });

    const res = await svc(prisma).update('dept-b', { managerId: 'emp-1' } as any);

    expect(res.success).toBe(true);
    expect(prisma.department.findFirst).not.toHaveBeenCalled();
    expect(prisma.department.update).toHaveBeenCalledTimes(1);
  });

  it('assignManager(): succeeds and auto-upgrades the role even when already managing elsewhere', async () => {
    const prisma = makePrisma({
      department: {
        findUnique: jest.fn().mockResolvedValue({ id: 'dept-b', name: 'Dept B' }),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'dept-b' }),
      },
    });

    const res = await svc(prisma).assignManager('dept-b', 'emp-1');

    expect(res.success).toBe(true);
    expect(prisma.department.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { role: 'MANAGER' },
    });
    expect(prisma.department.update).toHaveBeenCalledTimes(1);
  });

  it('assignManager(): still rejects an inactive employee', async () => {
    const prisma = makePrisma({
      department: {
        findUnique: jest.fn().mockResolvedValue({ id: 'dept-b', name: 'Dept B' }),
      },
      employee: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...activeManager, status: 'INACTIVE' }),
      },
    });

    await expect(svc(prisma).assignManager('dept-b', 'emp-1')).rejects.toThrow(
      'Manager must be an active employee',
    );
  });
});
