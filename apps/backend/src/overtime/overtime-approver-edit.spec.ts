import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { OvertimeService } from './overtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { ApprovalEngineService } from '../approvals/approval-engine.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HolidaysService } from '../holidays/holidays.service';
import { OvertimePolicyService } from '../overtime-policy/overtime-policy.service';
import { AuditService } from '../audit/audit.service';

/**
 * An approver correcting an overtime request while approving it.
 *
 * The two behaviours this file exists to pin, because both are silent when
 * broken and neither is visible from the response of a single call:
 *
 *   1. The correction is persisted BEFORE the decision is recorded. An
 *      intermediate approver in a chain returns with the request still PENDING
 *      and never reaches finalizeOvertimeApproval(), so an edit deferred to
 *      there is lost on every step but the last — the request goes to the next
 *      approver showing the numbers the employee filed.
 *   2. `siteAllowance` survives approval. finalizeOvertimeApproval() recomputes
 *      and overwrites every derived column from the policy; a site allowance is
 *      approver-granted with nothing to recompute it from, so naming it in that
 *      update payload would zero it on the way through.
 *
 * The engine, Prisma, mail and settings are mocked; the real service logic runs.
 */

const CFG = {
  enabled: true,
  eligible: true,
  lateThreshold: '22:00',
  foodAllowanceEnabled: true,
  foodAllowanceThreshold: '22:00',
  foodAllowanceAmount: 150,
  regularRate: 1.5,
  lateRate: 1.5,
  doubleOtEnabled: true,
  doubleRate: 2,
  shiftEndTime: '17:00',
  doubleFoodAllowanceAnyTime: false,
  doubleOtAllowAnytime: true,
  maxHoursPerDay: 8,
  maxHoursPerDoubleDay: 12,
  maxHoursPerMonth: 40,
  maxHoursPerYear: 200,
  allowEmployeeSubmit: true,
  holidayBehavior: 'STANDARD',
  dayEndBoundary: null,
  policyId: null,
  policyName: null,
  sunday: null,
  holiday: null,
};

const SUPERVISOR = { id: 'user-sup', role: 'EMPLOYEE' };

/** A weekday request, 17:00–21:00: 4h REGULAR, no food allowance. */
const baseRow = () => ({
  id: 'ot-1',
  employeeId: 'emp-1',
  date: new Date('2026-08-20T00:00:00Z'),
  startTime: new Date('2026-08-20T17:00:00Z'),
  endTime: new Date('2026-08-20T21:00:00Z'),
  hours: 4,
  regularHours: 4,
  lateHours: 0,
  doubleHours: 0,
  doubleLateHours: 0,
  dayType: 'WEEKDAY',
  foodAllowance: 0,
  foodAllowanceOverride: null,
  siteAllowance: 0,
  siteAllowanceNote: null,
  approverNote: null,
  editedById: null,
  editedAt: null,
  originalStartTime: null,
  originalEndTime: null,
  otType: 'REGULAR',
  overtimePolicyId: null,
  reason: 'Client cutover',
  status: 'PENDING',
  updatedAt: new Date('2026-08-20T11:00:00Z'),
  employee: {
    id: 'emp-1',
    employeeCode: 'E-1',
    fullName: 'Priya R',
    email: 'priya@example.com',
    departmentId: 'dept-1',
    branchId: null,
    baseSalary: 60000,
    employmentType: null,
    overtimePolicyId: null,
    salaryType: 'MONTHLY',
    department: { id: 'dept-1', name: 'Ops' },
    user: { id: 'user-emp' },
  },
});

interface Harness {
  service: OvertimeService;
  prisma: any;
  engine: any;
  audit: any;
  settings: any;
  row: any;
}

async function harness(
  opts: {
    row?: any;
    settings?: Record<string, string>;
    canAct?: boolean;
    engaged?: boolean;
    /** decide() finalizing => the last step; false => an intermediate step. */
    finalized?: boolean;
  } = {},
): Promise<Harness> {
  const row = opts.row ?? baseRow();
  const store = {
    attendance_day_end_time: '23:59',
    office_start_time: '08:00',
    overtime_approver_edit_enabled: 'true',
    overtime_site_allowance_enabled: 'true',
    overtime_site_allowance_max: '0',
    ...(opts.settings ?? {}),
  } as Record<string, string>;

  const prisma = {
    overtimeRequest: {
      findUnique: jest.fn().mockImplementation(async () => ({ ...row })),
      update: jest.fn().mockImplementation(async ({ data }: any) => {
        Object.assign(row, data);
        return { ...row };
      }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { hours: 0 } }),
    },
    employee: {
      findUnique: jest.fn().mockResolvedValue({
        branchId: null,
        departmentId: 'dept-1',
        employmentType: null,
        overtimePolicyId: null,
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
  };

  const engine = {
    trailFor: jest.fn().mockResolvedValue({
      engaged: opts.engaged ?? true,
      steps: [],
      activeStep: 1,
      canAct: opts.canAct ?? true,
    }),
    decide: jest.fn().mockResolvedValue({
      engaged: opts.engaged ?? true,
      finalized: opts.finalized ?? false,
    }),
    isChainParticipant: jest.fn().mockResolvedValue(true),
  };
  const audit = { log: jest.fn() };

  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      OvertimeService,
      { provide: PrismaService, useValue: prisma },
      { provide: MailService, useValue: { sendOvertimeApproved: jest.fn() } },
      {
        provide: SystemSettingsService,
        useValue: {
          getSetting: jest
            .fn()
            .mockImplementation(async (k: string, d?: string) => store[k] ?? d),
          getOvertimeConfig: jest.fn().mockResolvedValue({ ...CFG }),
        },
      },
      { provide: ApprovalEngineService, useValue: engine },
      {
        provide: NotificationsService,
        useValue: {
          notifyUser: jest.fn().mockResolvedValue(undefined),
          notifyUsers: jest.fn().mockResolvedValue(undefined),
        },
      },
      {
        provide: HolidaysService,
        useValue: {
          isHoliday: jest.fn().mockResolvedValue(false),
          isWeeklyOff: jest.fn().mockResolvedValue(false),
        },
      },
      {
        provide: OvertimePolicyService,
        useValue: {
          resolveOvertimeConfig: jest.fn().mockResolvedValue({ ...CFG }),
          configForPolicyId: jest.fn().mockResolvedValue({ ...CFG }),
        },
      },
      { provide: AuditService, useValue: audit },
    ],
  }).compile();

  return {
    service: moduleRef.get(OvertimeService),
    prisma,
    engine,
    audit,
    settings: store,
    row,
  };
}

/** The single update() the edit performs, i.e. not the finalize one. */
const editWrite = (prisma: any) =>
  prisma.overtimeRequest.update.mock.calls.find(
    (c: any[]) => c[0].data.editedAt !== undefined,
  )?.[0].data;

describe('OvertimeService — approver edit at approval', () => {
  describe('persistence ordering', () => {
    it('writes the correction BEFORE the decision is recorded', async () => {
      const h = await harness();
      const order: string[] = [];
      h.prisma.overtimeRequest.update.mockImplementation(async () => {
        order.push('write');
        return { ...h.row };
      });
      h.engine.decide.mockImplementation(async () => {
        order.push('decide');
        return { engaged: true, finalized: false };
      });

      await h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
        endTime: '2026-08-20T23:00:00Z',
      });

      expect(order).toEqual(['write', 'decide']);
    });

    it('keeps an intermediate approver’s correction, though the request stays PENDING', async () => {
      const h = await harness({ finalized: false });

      const result: any = await h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
        endTime: '2026-08-20T23:00:00Z',
      });

      expect(result.status).toBe('PENDING');
      expect(new Date(result.endTime).toISOString()).toBe(
        '2026-08-20T23:00:00.000Z',
      );
    });

    it('snapshots the filed window on the first edit only', async () => {
      const h = await harness();

      await h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
        endTime: '2026-08-20T22:00:00Z',
      });
      expect(h.row.originalEndTime.toISOString()).toBe(
        '2026-08-20T21:00:00.000Z',
      );

      h.prisma.overtimeRequest.update.mockClear();
      await h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
        endTime: '2026-08-20T23:00:00Z',
      });

      // Still the ORIGINAL 21:00, not the 22:00 the first edit produced.
      expect(h.row.originalEndTime.toISOString()).toBe(
        '2026-08-20T21:00:00.000Z',
      );
      expect(editWrite(h.prisma)).not.toHaveProperty('originalEndTime');
    });

    it('leaves the derived tier columns to the approval recompute', async () => {
      const h = await harness();

      await h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
        endTime: '2026-08-20T23:00:00Z',
      });

      const data = editWrite(h.prisma);
      expect(data).toHaveProperty('startTime');
      expect(data).toHaveProperty('endTime');
      expect(data).not.toHaveProperty('hours');
      expect(data).not.toHaveProperty('regularHours');
      expect(data).not.toHaveProperty('lateHours');
      expect(data).not.toHaveProperty('otType');
    });

    it('records the before/after pair in the audit log', async () => {
      const h = await harness();

      await h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
        endTime: '2026-08-20T23:00:00Z',
        approverNote: 'Gate log shows 23:00',
      });

      const entry = h.audit.log.mock.calls[0][0];
      expect(entry.action).toBe('OVERTIME_APPROVER_EDIT');
      expect(entry.resourceType).toBe('OvertimeRequest');
      expect(entry.resourceId).toBe('ot-1');
      expect(entry.userId).toBe('user-sup');
      expect(new Date(entry.oldData.endTime).toISOString()).toBe(
        '2026-08-20T21:00:00.000Z',
      );
      expect(new Date(entry.newData.endTime).toISOString()).toBe(
        '2026-08-20T23:00:00.000Z',
      );
    });

    it('does not touch the request at all for a bodyless approve', async () => {
      const h = await harness({ finalized: false });

      await h.service.approve('ot-1', 'user-sup', SUPERVISOR);

      expect(h.prisma.overtimeRequest.update).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });
  });

  describe('the corrected window drives the money', () => {
    it('re-tiers REGULAR to LATE and pays the food allowance', async () => {
      const h = await harness({ finalized: true });

      const updated: any = await h.service.approve(
        'ot-1',
        'user-sup',
        SUPERVISOR,
        { endTime: '2026-08-20T23:00:00Z' },
      );

      expect(updated.status).toBe('APPROVED');
      expect(Number(updated.hours)).toBe(6);
      expect(Number(updated.regularHours)).toBe(5);
      expect(Number(updated.lateHours)).toBe(1);
      expect(updated.otType).toBe('LATE');
      expect(Number(updated.foodAllowance)).toBe(150);
    });

    it('reads an end at or before the start as crossing midnight', async () => {
      const h = await harness({ finalized: true });

      const updated: any = await h.service.approve(
        'ot-1',
        'user-sup',
        SUPERVISOR,
        // 17:00 -> 01:00, tagged on the same calendar date as it is at filing.
        { endTime: '2026-08-20T01:00:00Z' },
      );

      // Clamped at the 23:59 attendance day boundary, so 17:00–23:59 is payable.
      expect(Number(updated.hours)).toBeCloseTo(6.98, 1);
    });

    it('refuses a corrected window with no payable hours left', async () => {
      const h = await harness({
        settings: { attendance_day_end_time: '18:00' },
      });

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
          startTime: '2026-08-20T19:00:00Z',
          endTime: '2026-08-20T21:00:00Z',
        }),
      ).rejects.toThrow(/no payable overtime hours/i);
    });

    it('holds the correction to the daily cap', async () => {
      // Boundary at 05:00 — a before-noon boundary means the NEXT day, so the
      // clamp does not bite here and the 9h window reaches the cap check.
      const h = await harness({ settings: { attendance_day_end_time: '05:00' } });

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
          startTime: '2026-08-20T17:00:00Z',
          endTime: '2026-08-21T02:00:00Z',
        }),
      ).rejects.toThrow(/Daily overtime limit exceeded/);
    });

    it('holds the correction to the monthly cap, excluding the row being edited', async () => {
      const h = await harness();
      // 38h on OTHER requests; this row's own 4h must not be counted again.
      h.prisma.overtimeRequest.aggregate.mockResolvedValue({
        _sum: { hours: 38 },
      });

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
          endTime: '2026-08-20T22:00:00Z',
        }),
      ).rejects.toThrow(/Monthly overtime limit exceeded/);

      // The aggregate that ran must have excluded this id, or the refusal above
      // proves nothing: 4h + 38h would exceed the cap on its own.
      const where = h.prisma.overtimeRequest.aggregate.mock.calls[0][0].where;
      expect(where.id).toEqual({ not: 'ot-1' });
    });

    it('holds the correction to the outside-work-hours rule', async () => {
      const h = await harness();

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
          startTime: '2026-08-20T10:00:00Z',
          endTime: '2026-08-20T21:00:00Z',
        }),
      ).rejects.toThrow(/outside of regular work hours/i);
    });
  });

  describe('food allowance override', () => {
    it('honours an explicit 0 against a policy that would pay 150', async () => {
      const h = await harness({ finalized: true });

      const updated: any = await h.service.approve(
        'ot-1',
        'user-sup',
        SUPERVISOR,
        { endTime: '2026-08-20T23:00:00Z', foodAllowance: 0 },
      );

      // The window earns the allowance; the approver said no.
      expect(Number(updated.foodAllowance)).toBe(0);
      expect(Number(updated.foodAllowanceOverride)).toBe(0);
    });

    it('lets the policy decide when no override is sent', async () => {
      const h = await harness({ finalized: true });

      const updated: any = await h.service.approve(
        'ot-1',
        'user-sup',
        SUPERVISOR,
        { endTime: '2026-08-20T23:00:00Z' },
      );

      expect(updated.foodAllowanceOverride).toBeNull();
      expect(Number(updated.foodAllowance)).toBe(150);
    });

    it('refuses an override while the policy pays no food allowance at all', async () => {
      const h = await harness();
      const otPolicy: any = (h.service as any).otPolicy;
      otPolicy.resolveOvertimeConfig.mockResolvedValue({
        ...CFG,
        foodAllowanceEnabled: false,
      });

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, { foodAllowance: 50 }),
      ).rejects.toThrow(/Food allowance is disabled/);
    });
  });

  describe('site allowance', () => {
    it('survives the approval recompute', async () => {
      const h = await harness({ finalized: true });

      const updated: any = await h.service.approve(
        'ot-1',
        'user-sup',
        SUPERVISOR,
        { siteAllowance: 25, siteAllowanceNote: 'Offshore rig' },
      );

      expect(updated.status).toBe('APPROVED');
      expect(Number(updated.siteAllowance)).toBe(25);
      expect(updated.siteAllowanceNote).toBe('Offshore rig');

      // Proved structurally too: naming the column in the finalize payload is
      // exactly the mistake that would zero it.
      const finalize = h.prisma.overtimeRequest.update.mock.calls.find(
        (c: any[]) => c[0].data.status === 'APPROVED',
      )[0].data;
      expect(finalize).not.toHaveProperty('siteAllowance');
    });

    it('is refused while the feature is off', async () => {
      const h = await harness({
        settings: { overtime_site_allowance_enabled: 'false' },
      });

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, { siteAllowance: 25 }),
      ).rejects.toThrow(/Site allowance is disabled/);
    });

    it('is refused above the configured ceiling', async () => {
      const h = await harness({
        settings: { overtime_site_allowance_max: '20' },
      });

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, { siteAllowance: 25 }),
      ).rejects.toThrow(/exceeds the maximum of 20/);
    });

    it('treats a ceiling of 0 as no ceiling', async () => {
      const h = await harness({
        settings: { overtime_site_allowance_max: '0' },
        finalized: true,
      });

      const updated: any = await h.service.approve(
        'ot-1',
        'user-sup',
        SUPERVISOR,
        { siteAllowance: 5000 },
      );

      expect(Number(updated.siteAllowance)).toBe(5000);
    });

    it('is written as a bare 0 when only a note is sent', async () => {
      const h = await harness();

      await h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
        siteAllowanceNote: 'noted, no money',
      });

      expect(Number(h.row.siteAllowance)).toBe(0);
    });
  });

  describe('who may edit', () => {
    it('refuses an approver who cannot act on the current step', async () => {
      const h = await harness({ canAct: false });

      await expect(
        h.service.approve('ot-1', 'user-other', { id: 'user-other', role: 'EMPLOYEE' }, {
          siteAllowance: 25,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(h.prisma.overtimeRequest.update).not.toHaveBeenCalled();
    });

    it('refuses a plain EMPLOYEE on the legacy no-chain path', async () => {
      // approve() itself admits role EMPLOYEE here without an ownership test.
      // Rewriting hours and allowances is deliberately held to a higher bar.
      const h = await harness({ engaged: false });

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, { siteAllowance: 25 }),
      ).rejects.toThrow(/do not have permission to edit/i);
    });

    it('allows HR_MANAGER on the legacy no-chain path', async () => {
      const h = await harness({ engaged: false });

      await h.service.approve(
        'ot-1',
        'user-hr',
        { id: 'user-hr', role: 'HR_MANAGER' },
        { siteAllowance: 25 },
      );

      expect(Number(h.row.siteAllowance)).toBe(25);
    });

    it('refuses a MANAGER outside their own departments', async () => {
      const h = await harness({ engaged: false });

      await expect(
        h.service.approve(
          'ot-1',
          'user-mgr',
          { id: 'user-mgr', role: 'MANAGER', managedDepartmentIds: ['dept-9'] },
          { siteAllowance: 25 },
        ),
      ).rejects.toThrow(/do not have permission to edit/i);
    });
  });

  describe('guards', () => {
    it('refuses any edit while the kill switch is off, but still approves', async () => {
      const h = await harness({
        settings: { overtime_approver_edit_enabled: 'false' },
        finalized: true,
      });

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, { siteAllowance: 25 }),
      ).rejects.toThrow(/disabled/i);

      // The bodyless decision is untouched by the switch.
      const updated: any = await h.service.approve('ot-1', 'user-sup', SUPERVISOR);
      expect(updated.status).toBe('APPROVED');
    });

    it('refuses a stale expectedUpdatedAt with a 409', async () => {
      const h = await harness();

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
          siteAllowance: 25,
          expectedUpdatedAt: '2026-08-20T09:00:00.000Z',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('accepts a matching expectedUpdatedAt', async () => {
      const h = await harness();

      await h.service.approve('ot-1', 'user-sup', SUPERVISOR, {
        siteAllowance: 25,
        expectedUpdatedAt: h.row.updatedAt.toISOString(),
      });

      expect(Number(h.row.siteAllowance)).toBe(25);
    });

    it('refuses an edit on a request that is no longer pending', async () => {
      const h = await harness({ row: { ...baseRow(), status: 'APPROVED' } });

      await expect(
        h.service.approve('ot-1', 'user-sup', SUPERVISOR, { siteAllowance: 25 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('edit-preview', () => {
    it('returns the corrected breakdown and rates without writing', async () => {
      const h = await harness();

      const preview: any = await h.service.previewApproverEdit(
        'ot-1',
        { endTime: '2026-08-20T23:00:00Z' },
        SUPERVISOR,
      );

      expect(preview.hours).toBe(6);
      expect(preview.regularHours).toBe(5);
      expect(preview.lateHours).toBe(1);
      expect(preview.otType).toBe('LATE');
      expect(preview.foodAllowance).toBe(150);
      expect(preview.regularRate).toBe(1.5);
      expect(preview.lateRate).toBe(1.5);
      expect(h.prisma.overtimeRequest.update).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it('shows an override in place of the computed allowance', async () => {
      const h = await harness();

      const preview: any = await h.service.previewApproverEdit(
        'ot-1',
        { endTime: '2026-08-20T23:00:00Z', foodAllowance: 0 },
        SUPERVISOR,
      );

      expect(preview.foodAllowance).toBe(0);
      expect(preview.foodAllowanceOverride).toBe(0);
    });

    it('refuses a preview the edit itself would refuse', async () => {
      const h = await harness({ canAct: false });

      await expect(
        h.service.previewApproverEdit(
          'ot-1',
          { endTime: '2026-08-20T23:00:00Z' },
          { id: 'user-other', role: 'EMPLOYEE' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
