import { Test, TestingModule } from '@nestjs/testing';
import { OvertimePolicyService } from './overtime-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';

const GLOBAL = {
  enabled: true,
  lateThreshold: '22:00',
  foodAllowanceEnabled: true,
  foodAllowanceThreshold: '22:00',
  foodAllowanceAmount: 150,
  regularRate: 1.5,
  lateRate: 1.5,
  doubleOtEnabled: true,
  doubleRate: 2,
  sunday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  holiday: { regularRate: 2, lateRate: 2, lateThreshold: '22:00' },
  shiftEndTime: '17:00',
  doubleFoodAllowanceAnyTime: false,
  doubleOtAllowAnytime: true,
  maxHoursPerDay: 4,
  maxHoursPerDoubleDay: 12,
  maxHoursPerMonth: 30,
  maxHoursPerYear: 200,
  requireManagerApproval: true,
  allowEmployeeSubmit: true,
};

const policy = (over: any = {}) => ({
  id: 'p',
  name: 'P',
  isActive: true,
  isDefault: false,
  employmentType: null,
  schemaVersion: 1,
  rules: {},
  ...over,
});

describe('OvertimePolicyService — resolution', () => {
  let service: OvertimePolicyService;
  let prisma: any;
  let settings: any;

  const build = async () => {
    prisma = {
      overtimePolicy: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    settings = { getOvertimeConfig: jest.fn().mockResolvedValue({ ...GLOBAL }) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimePolicyService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: settings },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn() } },
      ],
    }).compile();
    service = mod.get(OvertimePolicyService);
  };

  it('no policies exist → LEGACY_GLOBAL fallback with global config', async () => {
    await build();
    const emp = { overtimePolicyId: 'x', employmentType: 'Daily Wage' };
    const res = await service.resolveEffectivePolicyWithSource(emp);
    expect(res.policy).toBeNull();
    expect(res.source).toBe('LEGACY_GLOBAL');
    // The engine still hands back the global config as the ultimate fallback.
    const cfg = await service.resolveOvertimeConfig(emp);
    expect(cfg.policyId).toBeNull();
    expect(cfg.holidayBehavior).toBe('STANDARD');
    expect(cfg.regularRate).toBe(1.5);
    // The engine always queries the chain (no kill-switch short-circuit).
    expect(prisma.overtimePolicy.findFirst).toHaveBeenCalled();
  });

  it('Employee Override wins over employment type and default', async () => {
    await build();
    prisma.overtimePolicy.findFirst.mockImplementation((args: any) =>
      Promise.resolve(
        args.where.id === 'override'
          ? policy({ id: 'override', name: 'Override' })
          : policy({ id: 'other' }),
      ),
    );
    const res = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: 'override',
      employmentType: 'DAILY_WAGE' as any,
    });
    expect(res.policy?.id).toBe('override');
    expect(res.source).toBe('EMPLOYEE_OVERRIDE');
  });

  it('falls to Employment Type when there is no override', async () => {
    await build();
    prisma.overtimePolicy.findFirst.mockImplementation((args: any) =>
      Promise.resolve(
        args.where.employmentType === 'DAILY_WAGE'
          ? policy({ id: 'type', employmentType: 'DAILY_WAGE' })
          : null,
      ),
    );
    const res = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: null,
      employmentType: 'DAILY_WAGE' as any,
    });
    expect(res.policy?.id).toBe('type');
    expect(res.source).toBe('EMPLOYMENT_TYPE');
  });

  it('falls to Company Default when neither override nor type match', async () => {
    await build();
    prisma.overtimePolicy.findFirst.mockImplementation((args: any) =>
      Promise.resolve(
        args.where.isDefault ? policy({ id: 'def', isDefault: true }) : null,
      ),
    );
    const res = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: null,
      employmentType: 'CONTRACT' as any,
    });
    expect(res.policy?.id).toBe('def');
    expect(res.source).toBe('COMPANY_DEFAULT');
  });

  it('legacy global when nothing matches', async () => {
    await build();
    const res = await service.resolveEffectivePolicyWithSource({
      overtimePolicyId: null,
      employmentType: null,
    });
    expect(res.policy).toBeNull();
    expect(res.source).toBe('LEGACY_GLOBAL');
  });

  it('resolved config merges policy rules over global (IGNORE + partial override)', async () => {
    await build();
    prisma.overtimePolicy.findFirst.mockResolvedValue(
      policy({
        id: 'dw',
        name: 'Daily Wage OT',
        employmentType: 'DAILY_WAGE',
        rules: { holidayBehavior: 'IGNORE', regularRate: 1.25 },
      }),
    );
    const cfg = await service.resolveOvertimeConfig({
      overtimePolicyId: null,
      employmentType: 'DAILY_WAGE' as any,
    });
    expect(cfg.holidayBehavior).toBe('IGNORE');
    expect(cfg.regularRate).toBe(1.25); // overridden by policy
    expect(cfg.lateRate).toBe(1.5); // inherited from global
    expect(cfg.policyId).toBe('dw');
    expect(cfg.policyName).toBe('Daily Wage OT');
  });

  it('configForPolicyId honors the row snapshot', async () => {
    await build(); // a row already carries a policy snapshot
    prisma.overtimePolicy.findUnique.mockResolvedValue(
      policy({ id: 'snap', rules: { regularRate: 3 } }),
    );
    const cfg = await service.configForPolicyId('snap');
    expect(cfg.policyId).toBe('snap');
    expect(cfg.regularRate).toBe(3);
  });

  it('configForPolicyId(null) and missing policy → legacy global', async () => {
    await build();
    const legacy = await service.configForPolicyId(null);
    expect(legacy.policyId).toBeNull();
    expect(legacy.regularRate).toBe(1.5);

    prisma.overtimePolicy.findUnique.mockResolvedValue(null);
    const gone = await service.configForPolicyId('deleted');
    expect(gone.policyId).toBeNull();
    expect(gone.regularRate).toBe(1.5);
  });
});
