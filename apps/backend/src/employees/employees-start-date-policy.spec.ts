import { BadRequestException, ConflictException } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import {
  DEFAULT_START_DATE_POLICY,
  StartDatePolicy,
  checkEmploymentStartDate,
} from '../common/utils/start-date-policy.util';

/**
 * Employment start-date policy at the create() boundary.
 *
 * Backdating used to be blocked by a hardcoded "not more than 1 year in the
 * past" rule, which made it impossible to onboard a hire whose paperwork
 * arrived late. The window now comes from SystemSettings and allows any past
 * date by default.
 *
 * Acceptance is asserted with a sentinel: the email-uniqueness check is the
 * very next thing create() does, so a ConflictException('Email already exists')
 * proves the date got through the gate — without having to mock the entire
 * creation path.
 */
describe('EmployeesService — employment start date policy', () => {
  let prisma: any;
  let settings: { getEmploymentStartDatePolicy: jest.Mock };
  let service: EmployeesService;

  const DOB = '1999-04-02';

  const dto = (over: Record<string, any> = {}) => ({
    fullName: 'Late Paperwork',
    email: 'late@example.com',
    dateOfBirth: DOB,
    idCard: 'ID-1',
    departmentId: 'dept-1',
    position: 'Fitter',
    startDate: '2023-03-04',
    baseSalary: 50000,
    ...over,
  });

  const withPolicy = (over: Partial<StartDatePolicy> = {}) =>
    settings.getEmploymentStartDatePolicy.mockResolvedValue({
      ...DEFAULT_START_DATE_POLICY,
      ...over,
    });

  const daysFromToday = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  };

  beforeEach(() => {
    prisma = {
      // Sentinel: an existing email means anything that clears the date gate
      // lands on ConflictException instead of BadRequestException.
      employee: {
        findUnique: jest.fn().mockResolvedValue({ id: 'existing' }),
      },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    settings = {
      getEmploymentStartDatePolicy: jest
        .fn()
        .mockResolvedValue(DEFAULT_START_DATE_POLICY),
    };

    service = new EmployeesService(
      prisma,
      {} as any,
      {} as any,
      settings as any,
      {} as any,
      { assertCleared: jest.fn().mockResolvedValue(undefined) } as any,
      // whatsappOutbox, whatsappSettings
      {} as any,
      {} as any,
      // templates, supervisors — appended to the ctor after this spec was
      // written. Positional construction is why the ctor's own comment says
      // "append only": a missing pair here shifts every later stub by two.
      {} as any,
      {} as any,
      // GarnishmentsService — appended when court orders became a real model;
      // an exit flips any unrecovered balance to RECEIVABLE.
      { markOutstandingAsReceivable: jest.fn().mockResolvedValue(0) } as any,
    );
  });

  describe('backdating is allowed by default', () => {
    it.each([
      ['3 years ago', '2023-03-04'],
      ['a previous year', '2019-03-04'],
      ['8 months ago', daysFromToday(-240)],
    ])('accepts a start date %s', async (_label, startDate) => {
      await expect(service.create(dto({ startDate }) as any)).rejects.toThrow(
        ConflictException,
      );
      expect(settings.getEmploymentStartDatePolicy).toHaveBeenCalled();
    });

    it('accepts today', async () => {
      await expect(
        service.create(dto({ startDate: daysFromToday(0) }) as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('a configured past window is enforced', () => {
    it('rejects a start date beyond the configured window', async () => {
      withPolicy({ maxPastDays: 365 });
      await expect(
        service.create(dto({ startDate: daysFromToday(-800) }) as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('reports exactly the message the shared helper produced', async () => {
      withPolicy({ maxPastDays: 365 });
      const startDate = daysFromToday(-800);

      const expected = checkEmploymentStartDate({
        startDate,
        dateOfBirth: DOB,
        policy: { ...DEFAULT_START_DATE_POLICY, maxPastDays: 365 },
      });

      await expect(
        service.create(dto({ startDate }) as any),
      ).rejects.toThrow(expected.ok === false ? expected.message : '');
    });

    it('still accepts a date inside the configured window', async () => {
      withPolicy({ maxPastDays: 365 });
      await expect(
        service.create(dto({ startDate: daysFromToday(-200) }) as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('the other bounds still hold', () => {
    it('rejects a start date past the future cap', async () => {
      await expect(
        service.create(dto({ startDate: daysFromToday(400) }) as any),
      ).rejects.toThrow(/more than 180 days in the future/);
    });

    it('rejects a start date below the floor', async () => {
      await expect(
        service.create(dto({ startDate: '1900-01-01' }) as any),
      ).rejects.toThrow(/cannot be earlier than 1970-01-01/);
    });

    it('rejects a start date before the employee turned 18, even though the DOB age check passes', async () => {
      await expect(
        service.create(dto({ startDate: '2015-01-01' }) as any),
      ).rejects.toThrow(/before the employee turns 18/);
    });

    it('rejects a start date before the date of birth', async () => {
      await expect(
        service.create(
          dto({ dateOfBirth: '1999-04-02', startDate: '1998-01-01' }) as any,
        ),
      ).rejects.toThrow(/before the date of birth/);
    });

    it('rejects an unparseable start date', async () => {
      await expect(
        service.create(dto({ startDate: 'not-a-date' }) as any),
      ).rejects.toThrow(/valid date/);
    });
  });

  it('rejects an under-18 date of birth before consulting the policy', async () => {
    await expect(
      service.create(dto({ dateOfBirth: daysFromToday(-3650) }) as any),
    ).rejects.toThrow(/at least 18 years old/);
    expect(settings.getEmploymentStartDatePolicy).not.toHaveBeenCalled();
  });
});
