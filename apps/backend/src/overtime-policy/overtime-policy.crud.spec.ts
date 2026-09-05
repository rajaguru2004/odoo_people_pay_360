import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

const p2002 = (target: string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target: [target] },
  });

describe('OvertimePolicyService — CRUD, validation & assignment', () => {
  let service: OvertimePolicyService;
  let prisma: any;
  let notifications: any;

  beforeEach(async () => {
    prisma = {
      overtimePolicy: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async (a: any) => ({ id: 'new', ...a.data })),
        update: jest.fn().mockImplementation(async (a: any) => ({ id: a.where.id, ...a.data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({}),
      },
      employee: {
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(async (a: any) => ({ id: a.where.id, ...a.data })),
      },
      // Run interactive transactions against the same mock object.
      $transaction: jest.fn().mockImplementation(async (arg: any) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
      ),
    };
    notifications = { notifyUser: jest.fn().mockResolvedValue(undefined) };
    const settings = { getOvertimeConfig: jest.fn().mockResolvedValue({ ...GLOBAL }) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        OvertimePolicyService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: settings },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(OvertimePolicyService);
  });

  // ── create ────────────────────────────────────────────────────────────────
  it('create composes a full rules blob from global defaults + the partial payload', async () => {
    const res = await service.create({ name: 'Daily Wage OT', rules: { holidayBehavior: 'IGNORE' as any, regularRate: 1.25 } });
    expect(res.success).toBe(true);
    const data = prisma.overtimePolicy.create.mock.calls[0][0].data;
    expect(data.rules.holidayBehavior).toBe('IGNORE');
    expect(data.rules.regularRate).toBe(1.25); // from payload
    expect(data.rules.lateRate).toBe(1.5); // inherited from global
    expect(data.rules.eligible).toBe(true); // default
    expect(data.schemaVersion).toBe(1);
  });

  it('create as default deactivates any prior default (in a transaction)', async () => {
    await service.create({ name: 'Default', isDefault: true });
    expect(prisma.overtimePolicy.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true },
      data: { isDefault: false },
    });
  });

  it('create rejects a second active policy for the same employment type', async () => {
    prisma.overtimePolicy.findFirst.mockResolvedValue({ id: 'x', name: 'Existing DW' });
    await expect(
      service.create({ name: 'DW2', employmentType: 'Daily Wage' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('create maps a unique-name DB error to a friendly conflict', async () => {
    prisma.overtimePolicy.create.mockRejectedValue(p2002('name'));
    await expect(service.create({ name: 'Dup' })).rejects.toThrow(/name already exists/i);
  });

  it('create rejects rules with a non-positive rate', async () => {
    await expect(
      service.create({ name: 'Bad', rules: { regularRate: 0 } as any }),
    ).rejects.toThrow(/regularRate must be greater than 0/);
  });

  it('create rejects maxHoursPerDay greater than maxHoursPerDoubleDay', async () => {
    await expect(
      service.create({ name: 'Bad caps', rules: { maxHoursPerDay: 20 } as any }),
    ).rejects.toThrow(/maxHoursPerDay cannot exceed maxHoursPerDoubleDay/);
  });

  // ── update ──────────────────────────────────────────────────────────────────
  it('update throws NotFound for an unknown id', async () => {
    prisma.overtimePolicy.findUnique.mockResolvedValue(null);
    await expect(service.update('nope', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update overlays a partial rules edit, preserving the other fields', async () => {
    prisma.overtimePolicy.findUnique.mockResolvedValue({
      id: 'p1',
      name: 'P1',
      description: null,
      isActive: true,
      isDefault: false,
      employmentType: null,
      rules: { ...GLOBAL, eligible: true, holidayBehavior: 'STANDARD', dayEndBoundary: null, regularRate: 1.5 },
    });
    await service.update('p1', { rules: { regularRate: 1.75 } as any });
    const data = prisma.overtimePolicy.update.mock.calls[0][0].data;
    expect(data.rules.regularRate).toBe(1.75); // edited
    expect(data.rules.lateRate).toBe(1.5); // preserved
    expect(data.rules.holidayBehavior).toBe('STANDARD'); // preserved
  });

  it('update to default deactivates other defaults but not itself', async () => {
    prisma.overtimePolicy.findUnique.mockResolvedValue({
      id: 'p1', name: 'P1', description: null, isActive: true, isDefault: false, employmentType: null, rules: {},
    });
    await service.update('p1', { isDefault: true });
    expect(prisma.overtimePolicy.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, id: { not: 'p1' } },
      data: { isDefault: false },
    });
  });

  it('update lets a policy keep its own employment type (clash check excludes self)', async () => {
    prisma.overtimePolicy.findUnique.mockResolvedValue({
      id: 'p1', name: 'P1', description: null, isActive: true, isDefault: false, employmentType: 'Daily Wage', rules: {},
    });
    // findFirst (clash check) would only find OTHER policies; returns null here.
    prisma.overtimePolicy.findFirst.mockResolvedValue(null);
    await expect(service.update('p1', { rules: { regularRate: 2 } as any })).resolves.toBeDefined();
    expect(prisma.overtimePolicy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'p1' } }) }),
    );
  });

  // ── setDefault / setActive / remove ─────────────────────────────────────────
  it('setDefault deactivates other defaults and activates the target', async () => {
    prisma.overtimePolicy.findUnique.mockResolvedValue({ id: 'p1' });
    await service.setDefault('p1');
    expect(prisma.overtimePolicy.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, id: { not: 'p1' } },
      data: { isDefault: false },
    });
    expect(prisma.overtimePolicy.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { isDefault: true, isActive: true },
    });
  });

  it('setActive reactivating a type-scoped policy rejects on a clash', async () => {
    prisma.overtimePolicy.findUnique.mockResolvedValue({ id: 'p1', employmentType: 'Daily Wage' });
    prisma.overtimePolicy.findFirst.mockResolvedValue({ id: 'other', name: 'Other DW' });
    await expect(service.setActive('p1', true)).rejects.toBeInstanceOf(ConflictException);
  });

  it('remove blocks deleting the active default', async () => {
    prisma.overtimePolicy.findUnique.mockResolvedValue({ id: 'p1', isDefault: true, isActive: true });
    await expect(service.remove('p1')).rejects.toThrow(/Cannot delete the active default/);
    expect(prisma.overtimePolicy.delete).not.toHaveBeenCalled();
  });

  it('remove deletes a non-default policy', async () => {
    prisma.overtimePolicy.findUnique.mockResolvedValue({ id: 'p2', isDefault: false, isActive: true });
    const res = await service.remove('p2');
    expect(res.success).toBe(true);
    expect(prisma.overtimePolicy.delete).toHaveBeenCalledWith({ where: { id: 'p2' } });
  });

  // ── assign ──────────────────────────────────────────────────────────────────
  it('assign sets employment type + connects a policy, and notifies the employee', async () => {
    prisma.employee.findUnique.mockResolvedValue({ id: 'e1', branchId: null, user: { id: 'u1' } });
    prisma.overtimePolicy.findUnique.mockResolvedValue({ id: 'pol1' });
    await service.assign({ employeeId: 'e1', employmentType: 'Daily Wage', overtimePolicyId: 'pol1' });
    const data = prisma.employee.update.mock.calls[0][0].data;
    expect(data.employmentType).toBe('Daily Wage');
    expect(data.overtimePolicy).toEqual({ connect: { id: 'pol1' } });
    expect(notifications.notifyUser).toHaveBeenCalled();
  });

  it('assign with overtimePolicyId:null clears the override (disconnect)', async () => {
    prisma.employee.findUnique.mockResolvedValue({ id: 'e1', branchId: null, user: null });
    await service.assign({ employeeId: 'e1', overtimePolicyId: null });
    const data = prisma.employee.update.mock.calls[0][0].data;
    expect(data.overtimePolicy).toEqual({ disconnect: true });
  });

  it('assign rejects an unknown employee / unknown policy', async () => {
    prisma.employee.findUnique.mockResolvedValue(null);
    await expect(service.assign({ employeeId: 'nope' })).rejects.toBeInstanceOf(NotFoundException);

    prisma.employee.findUnique.mockResolvedValue({ id: 'e1', branchId: null, user: null });
    prisma.overtimePolicy.findUnique.mockResolvedValue(null);
    await expect(
      service.assign({ employeeId: 'e1', overtimePolicyId: 'ghost' }),
    ).rejects.toThrow(/policy not found/i);
  });

  // ── ensureCompanyDefault ─────────────────────────────────────────────────────
  it('ensureCompanyDefault is a no-op when an active default already exists', async () => {
    prisma.overtimePolicy.findFirst.mockResolvedValue({ id: 'def' });
    const res = await service.ensureCompanyDefault();
    expect(res).toEqual({ created: false, policyId: 'def' });
    expect(prisma.overtimePolicy.create).not.toHaveBeenCalled();
  });

  it('ensureCompanyDefault promotes an existing inactive "Company Default"', async () => {
    prisma.overtimePolicy.findFirst.mockResolvedValue(null); // no active default
    prisma.overtimePolicy.findUnique.mockResolvedValue({ id: 'cd', name: 'Company Default' });
    const res = await service.ensureCompanyDefault();
    expect(res.created).toBe(false);
    expect(res.policyId).toBe('cd');
    expect(prisma.overtimePolicy.update).toHaveBeenCalledWith({
      where: { id: 'cd' },
      data: { isDefault: true, isActive: true },
    });
  });

  it('ensureCompanyDefault creates a default cloned from global when none exists', async () => {
    prisma.overtimePolicy.findFirst.mockResolvedValue(null);
    prisma.overtimePolicy.findUnique.mockResolvedValue(null);
    const res = await service.ensureCompanyDefault();
    expect(res.created).toBe(true);
    const data = prisma.overtimePolicy.create.mock.calls[0][0].data;
    expect(data.name).toBe('Company Default');
    expect(data.isDefault).toBe(true);
    expect(data.employmentType).toBeNull();
    expect(data.rules.regularRate).toBe(GLOBAL.regularRate);
  });

  // ── the default may never be orphaned ───────────────────────────────────────
  // Losing the active default silently drops every employee without an override
  // or an employment-type policy onto the raw global settings — a config surface
  // the admin UI no longer exposes. All three ways to lose it are blocked.
  describe('the active default cannot be orphaned', () => {
    const activeDefault = {
      id: 'def',
      name: 'Company Default',
      description: null,
      isActive: true,
      isDefault: true,
      employmentType: null,
      rules: {},
    };

    it('update cannot deactivate it', async () => {
      prisma.overtimePolicy.findUnique.mockResolvedValue(activeDefault);
      await expect(service.update('def', { isActive: false })).rejects.toThrow(
        /Cannot deactivate the active default/,
      );
      expect(prisma.overtimePolicy.update).not.toHaveBeenCalled();
    });

    it('update cannot clear its default flag', async () => {
      prisma.overtimePolicy.findUnique.mockResolvedValue(activeDefault);
      await expect(service.update('def', { isDefault: false })).rejects.toThrow(
        /Cannot clear the default flag/,
      );
    });

    it('setActive(false) cannot deactivate it', async () => {
      prisma.overtimePolicy.findUnique.mockResolvedValue(activeDefault);
      await expect(service.setActive('def', false)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.overtimePolicy.update).not.toHaveBeenCalled();
    });

    it('an ordinary rules edit on the default still goes through', async () => {
      prisma.overtimePolicy.findUnique.mockResolvedValue(activeDefault);
      await expect(
        service.update('def', { rules: { regularRate: 1.75 } as any }),
      ).resolves.toBeDefined();
    });

    it('a NON-default policy may still be deactivated', async () => {
      prisma.overtimePolicy.findUnique.mockResolvedValue({
        ...activeDefault,
        id: 'p2',
        isDefault: false,
      });
      await expect(service.setActive('p2', false)).resolves.toBeDefined();
    });
  });

  // ── boot-time guarantee ─────────────────────────────────────────────────────
  describe('onModuleInit', () => {
    it('seeds the Company Default on boot when none exists', async () => {
      prisma.overtimePolicy.findFirst.mockResolvedValue(null);
      prisma.overtimePolicy.findUnique.mockResolvedValue(null);
      await service.onModuleInit();
      expect(prisma.overtimePolicy.create).toHaveBeenCalled();
    });

    it('is a no-op when a default already exists', async () => {
      prisma.overtimePolicy.findFirst.mockResolvedValue({ id: 'def' });
      await service.onModuleInit();
      expect(prisma.overtimePolicy.create).not.toHaveBeenCalled();
    });

    it('never breaks boot when the table is not migrated yet', async () => {
      prisma.overtimePolicy.findFirst.mockRejectedValue(
        new Error('relation "overtime_policies" does not exist'),
      );
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });
});
