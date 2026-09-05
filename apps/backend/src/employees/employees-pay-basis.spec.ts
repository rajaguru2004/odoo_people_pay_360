import { BadRequestException } from '@nestjs/common';
import { EmployeesService } from './employees.service';
// `update` requires an actor with no default: while it was optional the
// privileged controller branch passed none, and an HR_MANAGER could write a
// field marked editableByRoles: ['ADMIN']. A test with no human behind it says
// so explicitly, exactly as the production callers do.
import { SYSTEM_ACTOR } from '../common/utils/self-service.util';

/**
 * Employment Type -> Pay Basis derivation.
 *
 * "Employment Type = Daily Wage" and "Pay Basis = MONTHLY/DAILY" used to be two
 * unrelated fields on the employee form, so picking the daily-wage employment
 * type while leaving the basis at its MONTHLY default was silently accepted —
 * and the employee's PER-DAY rate was then paid as a whole month's salary.
 *
 * Now the EMPLOYMENT_TYPE library item carries the basis and the server derives
 * it. Nothing here matches on the LABEL "Daily Wage": the flag on the library
 * row is the entire contract, so an admin can flag any custom type and renaming
 * a type never breaks payroll.
 */
describe('EmployeesService — pay basis derived from employment type', () => {
  let prisma: any;
  let service: EmployeesService;

  /** An EMPLOYMENT_TYPE library row, keyed by label. */
  const library: Record<string, { payBasis: string | null }> = {
    // Deliberately NOT named "Daily Wage" — the label must be irrelevant.
    'Site Labour': { payBasis: 'DAILY' },
    Staff: { payBasis: 'MONTHLY' },
    Consultant: { payBasis: null },
  };

  const STORED = {
    id: 'emp-1',
    branchId: null,
    employmentType: null as string | null,
    salaryType: 'MONTHLY',
    baseSalary: 50000,
    position: 'Fitter',
    departmentId: 'dept-1',
    status: 'ACTIVE',
    email: 'a@b.c',
    idCard: 'ID1',
  };

  const stored = (over: Record<string, any> = {}) => ({ ...STORED, ...over });

  beforeEach(() => {
    prisma = {
      libraryItem: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          const label = where?.libraryType_label?.label;
          return label in library ? library[label] : null;
        }),
      },
      employee: {
        findUnique: jest.fn().mockResolvedValue(stored()),
        update: jest.fn().mockImplementation(async ({ data }: any) => data),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          ...data,
          id: 'emp-new',
          department: { name: 'Ops' },
          startDate: new Date(),
        })),
      },
      employeeHistory: { createMany: jest.fn().mockResolvedValue({}) },
      department: { findUnique: jest.fn().mockResolvedValue({ id: 'dept-1', isActive: true, parentId: null }) },
      $transaction: jest
        .fn()
        .mockImplementation(async (arg: any) =>
          typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
        ),
    };

    service = new EmployeesService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      // ClearanceService — no-op here; clearance behaviour is covered by
      // clearance.service.spec.ts and asset-clearance.e2e-spec.ts.
      { assertCleared: jest.fn().mockResolvedValue(undefined) } as any,
      // Profile template resolver. These cases never send customFields, so the
      // resolver is never consulted; a disabled template is the honest stand-in.
      {
        resolve: jest.fn().mockResolvedValue({ enabled: false, fields: [] }),
      } as any,
      // SupervisorsService — these cases never send supervisorId, so nothing
      // here is called; supervisor invariants are covered by their own suite.
      {
        assign: jest.fn().mockResolvedValue(undefined),
        unassign: jest.fn().mockResolvedValue(undefined),
      } as any,
          // GarnishmentsService — appended to the ctor when court orders became a
      // real model; an exit flips any unrecovered balance to RECEIVABLE.
      { markOutstandingAsReceivable: jest.fn().mockResolvedValue(0) } as any,
);
  });

  describe('payBasisForEmploymentType', () => {
    it.each([
      ['Site Labour', 'DAILY'],
      ['Staff', 'MONTHLY'],
    ])('a flagged type %p resolves to %p', async (label, expected) => {
      await expect(service.payBasisForEmploymentType(label)).resolves.toBe(expected);
    });

    it.each<[string | null | undefined, string]>([
      ['Consultant', 'an unflagged type'],
      ['Nonexistent', 'an unknown type'],
      ['', 'an empty label'],
      ['   ', 'a whitespace label'],
      [null, 'null'],
      [undefined, 'undefined'],
    ])('%p (%s) forces nothing', async (label) => {
      await expect(
        service.payBasisForEmploymentType(label),
      ).resolves.toBeUndefined();
    });

    it('never queries the library for a blank label', async () => {
      await service.payBasisForEmploymentType('');
      expect(prisma.libraryItem.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('update()', () => {
    const update = (dto: any, current: Record<string, any> = {}) => {
      prisma.employee.findUnique.mockResolvedValue(stored(current));
      return service.update('emp-1', dto as any, 'user-1', SYSTEM_ACTOR);
    };

    const written = () => prisma.employee.update.mock.calls[0][0].data;
    const history = () =>
      prisma.employeeHistory.createMany.mock.calls[0]?.[0]?.data ?? [];

    it('assigning a DAILY-flagged type flips the basis', async () => {
      await update({ employmentType: 'Site Labour' });
      expect(written().salaryType).toBe('DAILY');
    });

    it('the flip is audited, and so is the employment type that caused it', async () => {
      await update({ employmentType: 'Site Labour' });
      const fields = history().map((h: any) => h.field);
      expect(fields).toContain('salaryType');
      expect(fields).toContain('employmentType');
      const basisRow = history().find((h: any) => h.field === 'salaryType');
      expect(basisRow).toMatchObject({ oldValue: 'MONTHLY', newValue: 'DAILY' });
    });

    it('a previously-unset field is audited as empty, not the string "null"', async () => {
      await update({ employmentType: 'Site Labour' });
      const row = history().find((h: any) => h.field === 'employmentType');
      expect(row.oldValue).toBe('');
    });

    it('the server wins over a contradicting salaryType — by rejecting it', async () => {
      await expect(
        update({ employmentType: 'Site Labour', salaryType: 'MONTHLY' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a matching salaryType alongside a flagged type is accepted', async () => {
      await update({ employmentType: 'Site Labour', salaryType: 'DAILY' });
      expect(written().salaryType).toBe('DAILY');
    });

    it('sending only salaryType against an already-flagged type is rejected', async () => {
      await expect(
        update({ salaryType: 'MONTHLY' }, { employmentType: 'Site Labour', salaryType: 'DAILY' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('an unflagged type leaves the explicit choice standing', async () => {
      await update({ employmentType: 'Consultant', salaryType: 'DAILY' });
      expect(written().salaryType).toBe('DAILY');
    });

    it('clearing the employment type does NOT reset the basis to MONTHLY', async () => {
      // Resetting would silently re-read a per-day rate as a monthly salary.
      await update({ employmentType: '' }, { employmentType: 'Site Labour', salaryType: 'DAILY' });
      expect(written().salaryType).toBeUndefined();
    });

    it('an unrelated edit re-asserts the derived basis without recording a change', async () => {
      // Re-writing the same value is how an employee whose stored basis drifted
      // from their employment type converges on the next save — and because the
      // value is unchanged, no spurious audit row appears.
      await update({ position: 'Foreman' }, { employmentType: 'Site Labour', salaryType: 'DAILY' });
      expect(written().salaryType).toBe('DAILY');
      expect(history().map((h: any) => h.field)).not.toContain('salaryType');
    });

    it('an unrelated edit on an out-of-sync employee converges them, audited', async () => {
      // The state in the bug report: daily-wage employment type, MONTHLY basis.
      await update({ position: 'Foreman' }, { employmentType: 'Site Labour', salaryType: 'MONTHLY' });
      expect(written().salaryType).toBe('DAILY');
      expect(history().find((h: any) => h.field === 'salaryType')).toMatchObject({
        oldValue: 'MONTHLY',
        newValue: 'DAILY',
      });
    });

    it('renaming the library row does not break derivation — no label is hardcoded', async () => {
      library['Casual Crew'] = { payBasis: 'DAILY' };
      await update({ employmentType: 'Casual Crew' });
      expect(written().salaryType).toBe('DAILY');
      delete library['Casual Crew'];
    });
  });
});
