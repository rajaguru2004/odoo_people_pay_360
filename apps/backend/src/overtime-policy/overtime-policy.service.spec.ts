import { Test, TestingModule } from '@nestjs/testing';
import { OvertimePolicyService } from './overtime-policy.service';
import { PrismaService } from '../prisma/prisma.service';

/** Settings rows that produce a known company config. */
const SETTINGS = [
  { key: 'overtime_late_threshold', value: '22:00' },
  { key: 'overtime_regular_rate', value: '1.5' },
  { key: 'overtime_late_rate', value: '1.5' },
  { key: 'overtime_double_rate', value: '2.0' },
  { key: 'overtime_max_hours_per_day', value: '4' },
  { key: 'overtime_max_hours_per_double_day', value: '12' },
];

const policy = (over: Record<string, unknown> = {}) => ({
  id: 'p',
  name: 'P',
  isActive: true,
  isDefault: false,
  employmentType: null,
  schemaVersion: 1,
  rules: {},
  ...over,
});

describe('OvertimePolicyService — resolution chain', () => {
  let service: OvertimePolicyService;
  let prisma: {
    overtimePolicy: { findFirst: jest.Mock; findUnique: jest.Mock };
    systemSetting: { findMany: jest.Mock };
    contract: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      overtimePolicy: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      systemSetting: { findMany: jest.fn().mockResolvedValue(SETTINGS) },
      contract: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimePolicyService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(OvertimePolicyService);
  });

  it('falls back to the company settings when no policy exists at all', async () => {
    const emp = { overtimePolicyId: 'x', employmentType: 'PART_TIME' };
    const res = await service.resolveEffectivePolicyWithSource(emp);
    expect(res.policy).toBeNull();
    expect(res.source).toBe('LEGACY_GLOBAL');

    const cfg = await service.resolveOvertimeConfig(emp);
    expect(cfg.policyId).toBeNull();
    expect(cfg.holidayBehavior).toBe('STANDARD');
    expect(cfg.regularRate).toBe(1.5);
    // The whole chain is queried; there is no short circuit.
    expect(prisma.overtimePolicy.findFirst).toHaveBeenCalled();
  });

  it('lets an employee override beat both the type and the default', async () => {
    prisma.overtimePolicy.findFirst.mockImplementation(
      (args: { where: { id?: string } }) =>
        Promise.resolve(
          args.where.id === 'override'
            ? policy({ id: 'override', name: 'Override' })
            : policy({ id: 'other' }),
        ),
    );
    const res = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: 'override',
      employmentType: 'PART_TIME',
    });
    expect(res.policy?.id).toBe('override');
    expect(res.source).toBe('EMPLOYEE_OVERRIDE');
  });

  it('falls to the employment type when there is no override', async () => {
    prisma.overtimePolicy.findFirst.mockImplementation(
      (args: { where: { employmentType?: string } }) =>
        Promise.resolve(
          args.where.employmentType === 'PART_TIME'
            ? policy({ id: 'type', employmentType: 'PART_TIME' })
            : null,
        ),
    );
    const res = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: null,
      employmentType: 'PART_TIME',
    });
    expect(res.policy?.id).toBe('type');
    expect(res.source).toBe('EMPLOYMENT_TYPE');
  });

  it('falls to the company default when neither the override nor the type match', async () => {
    prisma.overtimePolicy.findFirst.mockImplementation(
      (args: { where: { isDefault?: boolean } }) =>
        Promise.resolve(
          args.where.isDefault ? policy({ id: 'def', isDefault: true }) : null,
        ),
    );
    const res = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: null,
      employmentType: 'CONSULTANT',
    });
    expect(res.policy?.id).toBe('def');
    expect(res.source).toBe('COMPANY_DEFAULT');
  });

  it('falls through an unset employment type to the company default', async () => {
    // Null is not a stop: an employee nobody has typed still has to get the
    // company rate card, or overtime silently stops working for most of them.
    prisma.overtimePolicy.findFirst.mockImplementation(
      (args: { where: { isDefault?: boolean; employmentType?: string } }) =>
        Promise.resolve(
          args.where.isDefault ? policy({ id: 'def', isDefault: true }) : null,
        ),
    );
    const res = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: null,
      employmentType: null,
    });
    expect(res.policy?.id).toBe('def');
    expect(res.source).toBe('COMPANY_DEFAULT');
    // The type tier is skipped entirely rather than queried with a null.
    const queried = prisma.overtimePolicy.findFirst.mock.calls.flat() as {
      where: Record<string, unknown>;
    }[];
    expect(
      queried.filter((args) => args.where.employmentType !== undefined),
    ).toHaveLength(0);
  });

  it('merges the policy rules over the company config', async () => {
    prisma.overtimePolicy.findFirst.mockResolvedValue(
      policy({
        id: 'dw',
        name: 'Part-time OT',
        employmentType: 'PART_TIME',
        rules: { holidayBehavior: 'IGNORE', regularRate: 1.25 },
      }),
    );
    const cfg = await service.resolveOvertimeConfig({
      overtimePolicyId: null,
      employmentType: 'PART_TIME',
    });
    expect(cfg.holidayBehavior).toBe('IGNORE');
    expect(cfg.regularRate).toBe(1.25); // the policy's
    expect(cfg.lateRate).toBe(1.5); // inherited
    expect(cfg.policyId).toBe('dw');
    expect(cfg.policyName).toBe('Part-time OT');
  });

  it('honours the policy snapshot a decided request carries', async () => {
    prisma.overtimePolicy.findUnique.mockResolvedValue(
      policy({ id: 'snap', rules: { regularRate: 3 } }),
    );
    const cfg = await service.configForPolicyId('snap');
    expect(cfg.policyId).toBe('snap');
    expect(cfg.regularRate).toBe(3);
  });

  it('falls back to the company config for a missing or deleted snapshot', async () => {
    const legacy = await service.configForPolicyId(null);
    expect(legacy.policyId).toBeNull();
    expect(legacy.regularRate).toBe(1.5);

    prisma.overtimePolicy.findUnique.mockResolvedValue(null);
    const gone = await service.configForPolicyId('deleted');
    expect(gone.policyId).toBeNull();
    expect(gone.regularRate).toBe(1.5);
  });
});

describe('OvertimePolicyService — the chain inputs', () => {
  let service: OvertimePolicyService;
  let employee: { findUnique: jest.Mock };

  beforeEach(async () => {
    employee = { findUnique: jest.fn() };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimePolicyService,
        {
          provide: PrismaService,
          useValue: {
            employee,
            overtimePolicy: {
              findFirst: jest.fn().mockResolvedValue(null),
              findUnique: jest.fn().mockResolvedValue(null),
            },
            systemSetting: { findMany: jest.fn().mockResolvedValue(SETTINGS) },
          },
        },
      ],
    }).compile();
    service = mod.get(OvertimePolicyService);
  });

  it('reads both tiers off the employee record in one query', async () => {
    employee.findUnique.mockResolvedValue({
      overtimePolicyId: 'pol-1',
      employmentType: 'Daily Wage',
    });
    await expect(service.resolvableFor('emp-1')).resolves.toEqual({
      overtimePolicyId: 'pol-1',
      employmentType: 'Daily Wage',
    });
    expect(employee.findUnique).toHaveBeenCalledTimes(1);
  });

  it('reports an unset employment type as null, not as a refusal', async () => {
    employee.findUnique.mockResolvedValue({
      overtimePolicyId: null,
      employmentType: null,
    });
    await expect(service.resolvableFor('emp-1')).resolves.toEqual({
      overtimePolicyId: null,
      employmentType: null,
    });
  });

  it('is null on both tiers for an employee that no longer exists', async () => {
    employee.findUnique.mockResolvedValue(null);
    await expect(service.resolvableFor('gone')).resolves.toEqual({
      overtimePolicyId: null,
      employmentType: null,
    });
  });
});
