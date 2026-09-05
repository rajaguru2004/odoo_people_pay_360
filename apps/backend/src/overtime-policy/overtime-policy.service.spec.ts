import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../system-settings/system-settings.service';
import { OVERTIME_SETTING_DEFAULTS } from './overtime-config';
import { OvertimePolicyService } from './overtime-policy.service';
import { buildDefaultRules } from './overtime-policy.types';
import { writtenData } from '../common/testing/prisma-mock.util';

interface FakePolicy {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  employmentType: string | null;
  rules: Record<string, unknown>;
}

/** Settings that answer with the shipped defaults and nothing else. */
function makeSettings(overrides: Record<string, string> = {}) {
  return {
    get: jest.fn((key: string) =>
      Promise.resolve(overrides[key] ?? OVERTIME_SETTING_DEFAULTS[key]),
    ),
  } as unknown as SystemSettingsService;
}

function makePrisma(policies: FakePolicy[]) {
  const matches = (policy: FakePolicy, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'id' && typeof value === 'object' && value !== null) {
        return policy.id !== (value as { not: string }).not;
      }
      return (policy as unknown as Record<string, unknown>)[key] === value;
    });

  return {
    overtimePolicy: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(policies.find((p) => matches(p, where)) ?? null),
      ),
      findUnique: jest.fn(
        ({ where }: { where: { id?: string; name?: string } }) =>
          Promise.resolve(
            policies.find(
              (p) =>
                (where.id !== undefined && p.id === where.id) ||
                (where.name !== undefined && p.name === where.name),
            ) ?? null,
          ),
      ),
      findMany: jest.fn().mockResolvedValue(policies),
      create: jest.fn(({ data }: { data: Omit<FakePolicy, 'id'> }) =>
        Promise.resolve({ id: 'created', ...data }),
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: object }) =>
          Promise.resolve({
            ...(policies.find((p) => p.id === where.id) as FakePolicy),
            ...data,
          }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    employee: {
      findUnique: jest.fn().mockResolvedValue({ id: 'emp-1' }),
      update: jest.fn(({ data }: { data: object }) =>
        Promise.resolve({ id: 'emp-1', ...data }),
      ),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => {
      // The fake has no real transaction, so the callback runs against the same
      // client. Enough for the resolution rules under test, which never rely on
      // a rollback.
      return Promise.resolve(fn(makePrismaInner(policies)));
    }),
  } as unknown as PrismaService;
}

function makePrismaInner(policies: FakePolicy[]) {
  return {
    overtimePolicy: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn(({ data }: { data: Omit<FakePolicy, 'id'> }) =>
        Promise.resolve({ id: 'created', ...data }),
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: object }) =>
          Promise.resolve({
            ...(policies.find((p) => p.id === where.id) as FakePolicy),
            ...data,
          }),
      ),
    },
  };
}

const policy = (
  over: Partial<FakePolicy> & { id: string; name: string },
): FakePolicy => ({
  isActive: true,
  isDefault: false,
  employmentType: null,
  rules: {},
  ...over,
});

describe('the inheritance chain', () => {
  it('an employee override wins over everything', async () => {
    const policies = [
      policy({ id: 'override', name: 'Override', rules: { regularRate: 3 } }),
      policy({ id: 'type', name: 'Type', employmentType: 'Daily Wage' }),
      policy({ id: 'default', name: 'Company Default', isDefault: true }),
    ];
    const service = new OvertimePolicyService(
      makePrisma(policies),
      makeSettings(),
    );

    const resolved = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: 'override',
      employmentType: 'Daily Wage',
    });
    expect(resolved.source).toBe('EMPLOYEE_OVERRIDE');
    expect(resolved.policy?.id).toBe('override');
  });

  it('falls to the employment type when there is no override', async () => {
    const policies = [
      policy({ id: 'type', name: 'Type', employmentType: 'Daily Wage' }),
      policy({ id: 'default', name: 'Company Default', isDefault: true }),
    ];
    const service = new OvertimePolicyService(
      makePrisma(policies),
      makeSettings(),
    );

    const resolved = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: null,
      employmentType: 'Daily Wage',
    });
    expect(resolved.source).toBe('EMPLOYMENT_TYPE');
  });

  it('falls to the company default when neither applies', async () => {
    const service = new OvertimePolicyService(
      makePrisma([
        policy({ id: 'default', name: 'Company Default', isDefault: true }),
      ]),
      makeSettings(),
    );

    const resolved = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: null,
      employmentType: null,
    });
    expect(resolved.source).toBe('COMPANY_DEFAULT');
  });

  it('falls to the global settings only when NO policy exists at all', async () => {
    const service = new OvertimePolicyService(makePrisma([]), makeSettings());

    const resolved = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: null,
      employmentType: null,
    });
    expect(resolved.source).toBe('LEGACY_GLOBAL');
    expect(resolved.policy).toBeNull();

    const cfg = await service.resolveOvertimeConfig({
      overtimePolicyId: null,
      employmentType: null,
    });
    expect(cfg.policyId).toBeNull();
    expect(cfg.regularRate).toBe(1.25);
  });

  it('ignores an INACTIVE override rather than treating it as a kill switch', async () => {
    const policies = [
      policy({ id: 'override', name: 'Override', isActive: false }),
      policy({ id: 'default', name: 'Company Default', isDefault: true }),
    ];
    const service = new OvertimePolicyService(
      makePrisma(policies),
      makeSettings(),
    );

    const resolved = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: 'override',
      employmentType: null,
    });
    expect(resolved.source).toBe('COMPANY_DEFAULT');
  });
});

describe('configForPolicyId', () => {
  it('honours a snapshot even when the policy has since been retired', async () => {
    // A request approved in March must monetize against the rules that
    // classified its hours, not against whatever is active in June.
    const retired = policy({
      id: 'old',
      name: 'Old',
      isActive: false,
      rules: { regularRate: 3 },
    });
    const service = new OvertimePolicyService(
      makePrisma([retired]),
      makeSettings(),
    );

    const cfg = await service.configForPolicyId('old');
    expect(cfg.regularRate).toBe(3);
    expect(cfg.policyId).toBe('old');
  });

  it('falls back to the globals for a deleted policy rather than throwing', async () => {
    // A deleted policy must not make a historical payslip unreadable.
    const service = new OvertimePolicyService(makePrisma([]), makeSettings());
    const cfg = await service.configForPolicyId('gone');
    expect(cfg.policyId).toBeNull();
    expect(cfg.regularRate).toBe(1.25);
  });

  it('a null snapshot is the globals', async () => {
    const service = new OvertimePolicyService(makePrisma([]), makeSettings());
    await expect(service.configForPolicyId(null)).resolves.toMatchObject({
      policyId: null,
    });
  });
});

describe('protecting the default', () => {
  it('refuses to deactivate the only active default', async () => {
    const active = policy({
      id: 'default',
      name: 'Company Default',
      isDefault: true,
    });
    const service = new OvertimePolicyService(
      makePrisma([active]),
      makeSettings(),
    );

    // Losing it drops every uncovered employee onto the raw globals, silently.
    await expect(service.setActive('default', false)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.update('default', { isActive: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update('default', { isDefault: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove('default')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('employment-type exclusivity', () => {
  it('refuses a second ACTIVE policy for the same type', async () => {
    // Two active policies for one type resolve to whichever row the planner
    // returns first, so the same employee gets different rates on different
    // requests and nothing in the data says which was right.
    const service = new OvertimePolicyService(
      makePrisma([
        policy({ id: 'a', name: 'A', employmentType: 'Daily Wage' }),
      ]),
      makeSettings(),
    );

    await expect(
      service.create({ name: 'B', employmentType: 'Daily Wage' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows a second INACTIVE one, which is how a rule set is replaced', async () => {
    const service = new OvertimePolicyService(
      makePrisma([
        policy({ id: 'a', name: 'A', employmentType: 'Daily Wage' }),
      ]),
      makeSettings(),
    );

    await expect(
      service.create({
        name: 'B',
        employmentType: 'Daily Wage',
        isActive: false,
      }),
    ).resolves.toMatchObject({ success: true });
  });
});

describe('rule validation', () => {
  const service = () =>
    new OvertimePolicyService(makePrisma([]), makeSettings());

  it('refuses a zero multiplier', async () => {
    await expect(
      service().create({ name: 'Zero', rules: { regularRate: 0 } }),
    ).rejects.toThrow('regularRate must be greater than 0');
  });

  it('refuses a threshold that is not a wall clock', async () => {
    await expect(
      service().create({
        name: 'Bad clock',
        rules: { lateThreshold: '10 pm' },
      }),
    ).rejects.toThrow('lateThreshold must be a time in HH:MM format');
  });

  it('refuses a weekday cap above the rest-day cap', async () => {
    await expect(
      service().create({
        name: 'Backwards caps',
        rules: { maxHoursPerDay: 14, maxHoursPerDoubleDay: 12 },
      }),
    ).rejects.toThrow('maxHoursPerDay cannot exceed maxHoursPerDoubleDay');
  });

  it('accepts a payload naming only one field', async () => {
    await expect(
      service().create({
        name: 'Partial',
        rules: { regularRate: 1.75 },
      }),
    ).resolves.toMatchObject({ success: true });
  });
});

describe('ensureCompanyDefault', () => {
  it('creates one mirroring the globals when none exists', async () => {
    const prisma = makePrisma([]);
    const service = new OvertimePolicyService(prisma, makeSettings());

    const result = await service.ensureCompanyDefault();
    expect(result.created).toBe(true);
    // Mirroring the globals is what makes introducing the engine a no-op.
    const created = (
      prisma as unknown as {
        $transaction: jest.Mock;
      }
    ).$transaction.mock.results[0];
    expect(created).toBeDefined();
  });

  it('is a no-op when an active default is already there', async () => {
    const service = new OvertimePolicyService(
      makePrisma([
        policy({ id: 'default', name: 'Company Default', isDefault: true }),
      ]),
      makeSettings(),
    );
    await expect(service.ensureCompanyDefault()).resolves.toEqual({
      created: false,
      policyId: 'default',
    });
  });
});

describe('assignment', () => {
  it('clears the override when the payload names a null', async () => {
    // `hasOwnProperty`, not truthiness: an explicit null is the whole point of
    // the field — it drops the employee back through the chain.
    const prisma = makePrisma([]);
    const service = new OvertimePolicyService(prisma, makeSettings());

    await service.assign({ employeeId: 'emp-1', overtimePolicyId: null });
    const update = (prisma as unknown as { employee: { update: jest.Mock } })
      .employee.update;
    expect(writtenData(update).overtimePolicy).toEqual({ disconnect: true });
  });

  it('leaves the override alone when the payload omits it', async () => {
    const prisma = makePrisma([]);
    const service = new OvertimePolicyService(prisma, makeSettings());

    await service.assign({ employeeId: 'emp-1', employmentType: 'Daily Wage' });
    const update = (prisma as unknown as { employee: { update: jest.Mock } })
      .employee.update;
    expect(writtenData(update).overtimePolicy).toBeUndefined();
    expect(writtenData(update).employmentType).toBe('Daily Wage');
  });
});

describe('the resolved default rules', () => {
  it('are exactly the shipped global defaults', async () => {
    const settings = makeSettings();
    const service = new OvertimePolicyService(makePrisma([]), settings);
    const cfg = await service.resolveOvertimeConfig({
      overtimePolicyId: null,
      employmentType: null,
    });
    expect(buildDefaultRules(cfg).lateThreshold).toBe('22:00');
    // The tiers fall through to the flat double rate when the setting is blank,
    // which is the common case and is what the defaults express.
    expect(cfg.sunday).toEqual({
      regularRate: 2,
      lateRate: 2,
      lateThreshold: '22:00',
    });
  });
});
