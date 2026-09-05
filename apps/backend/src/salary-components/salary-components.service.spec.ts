import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { SalaryComponentsService } from './salary-components.service';

const component = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  code: 'HRA',
  name: 'Housing Allowance',
  type: 'EARNING',
  isGratuityBase: false,
  isTaxable: true,
  sequence: 20,
  isActive: true,
  ...overrides,
});

interface ListArgs {
  where: {
    type?: string;
    isActive?: boolean;
    OR?: Array<Record<string, unknown>>;
  };
  orderBy?: unknown;
  skip?: number;
  take?: number;
}

function build(
  options: {
    existing?: Record<string, unknown> | null;
    clash?: Record<string, unknown> | null;
    structureLineCount?: number;
  } = {},
) {
  const rows = [component()];
  const findMany = jest.fn((args: ListArgs) => {
    void args;
    return Promise.resolve(rows);
  });
  const create = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'new', ...args.data }),
  );
  const update = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...component(), ...args.data }),
  );

  const prismaMock = {
    salaryComponent: {
      findMany,
      // `findUnique` answers the code-clash lookup on create and the id lookup
      // everywhere else, so the fixture decides which by argument.
      findUnique: jest.fn((args: { where: { id?: string; code?: string } }) =>
        Promise.resolve(
          args.where.code !== undefined
            ? (options.clash ?? null)
            : options.existing === undefined
              ? component()
              : options.existing,
        ),
      ),
      count: jest.fn(() => Promise.resolve(rows.length)),
      create,
      update,
    },
    salaryStructureLine: {
      count: jest.fn(() => Promise.resolve(options.structureLineCount ?? 0)),
    },
  };

  const prisma = prismaMock as unknown as PrismaService;
  return {
    service: new SalaryComponentsService(prisma),
    mocks: { findMany, create, update },
  };
}

describe('create', () => {
  it('uppercases the code, so one allowance cannot become two rules', async () => {
    const { service, mocks } = build({ clash: null });
    await service.create({
      code: ' hra ',
      name: 'Housing',
      type: 'EARNING',
    } as never);
    expect(mocks.create.mock.calls[0][0].data.code).toBe('HRA');
  });

  it('trims the name and applies the documented defaults', async () => {
    const { service, mocks } = build({ clash: null });
    await service.create({
      code: 'HRA',
      name: '  Housing  ',
      type: 'EARNING',
    } as never);
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({
      name: 'Housing',
      isGratuityBase: false,
      isTaxable: true,
      sequence: 100,
    });
  });

  it('refuses a duplicate code with a sentence, not a constraint name', async () => {
    // The person reading this is a payroll clerk, not a DBA.
    const { service } = build({ clash: component() });
    await expect(
      service.create({
        code: 'hra',
        name: 'Housing',
        type: 'EARNING',
      } as never),
    ).rejects.toThrow(
      new ConflictException(
        'A salary component with the code HRA already exists.',
      ),
    );
  });
});

describe('findAll', () => {
  it('orders by sequence, then code — the order a payslip prints in', async () => {
    const { service, mocks } = build();
    await service.findAll({});
    expect(mocks.findMany.mock.calls[0][0].orderBy).toEqual([
      { sequence: 'asc' },
      { code: 'asc' },
    ]);
  });

  it('reads isActive as a boolean, not as the string it arrives as', async () => {
    const { service, mocks } = build();
    await service.findAll({ isActive: 'false' });
    expect(mocks.findMany.mock.calls[0][0].where.isActive).toBe(false);
  });

  it('searches code and name together', async () => {
    const { service, mocks } = build();
    await service.findAll({ search: 'hous' });
    expect(mocks.findMany.mock.calls[0][0].where.OR).toEqual([
      { code: { contains: 'hous', mode: 'insensitive' } },
      { name: { contains: 'hous', mode: 'insensitive' } },
    ]);
  });

  it('counts in the database rather than off the page', async () => {
    const { service } = build();
    const result = await service.findAll({ limit: 1 });
    expect(result.meta.total).toBe(1);
  });
});

describe('update', () => {
  it('never writes code or type', async () => {
    // Both are joined on by payslip lines that already exist: renaming a code
    // orphans every report grouped by it, and turning an earning into a
    // deduction changes the meaning of money already paid.
    const { service, mocks } = build();
    await service.update('c1', {
      name: 'Housing Allowance (revised)',
      sequence: 25,
    });
    const data = mocks.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('code');
    expect(data).not.toHaveProperty('type');
    expect(data).toMatchObject({
      name: 'Housing Allowance (revised)',
      sequence: 25,
    });
  });

  it('404s for a component that is not there', async () => {
    const { service } = build({ existing: null });
    await expect(service.update('missing', {})).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('deactivate', () => {
  it('retires rather than deletes', async () => {
    // There is no delete: a component behind a payslip line must keep
    // resolving, which is why PayslipLine declares onDelete: SetNull.
    const { service, mocks } = build();
    await service.deactivate('c1');
    expect(mocks.update.mock.calls[0][0].data).toEqual({ isActive: false });
  });

  it('says how many structures still carry it, so nobody assumes it was removed', async () => {
    const { service } = build({ structureLineCount: 4 });
    const result = await service.deactivate('c1');
    expect(result.message).toContain(
      '4 existing salary structures still use it',
    );
  });

  it('says nothing about structures when none use it', async () => {
    const { service } = build({ structureLineCount: 0 });
    const result = await service.deactivate('c1');
    expect(result.message).toBe('Salary component deactivated');
  });

  it('404s for a component that is not there', async () => {
    const { service } = build({ existing: null });
    await expect(service.deactivate('missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('activate', () => {
  it('puts a retired component back in the catalogue', async () => {
    const { service, mocks } = build();
    await service.activate('c1');
    expect(mocks.update.mock.calls[0][0].data).toEqual({ isActive: true });
  });
});

describe('the service exposes no delete at all', () => {
  it('has no remove method', () => {
    const { service } = build();
    expect(
      (service as unknown as Record<string, unknown>).remove,
    ).toBeUndefined();
  });
});
