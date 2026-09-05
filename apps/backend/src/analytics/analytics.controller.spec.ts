import { ForbiddenException } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';

/**
 * The access rules on the analytics routes.
 *
 * `employeeId` is a path parameter, so without the self-check these routes are
 * "any employee's conduct record, for anyone with a login". The service has no
 * concept of a caller, which is exactly why the check lives here and is tested
 * here. The range bound is the other half: an unbounded window over attendance
 * and worklogs is a table scan per request.
 */
describe('AnalyticsController', () => {
  const analytics: any = {
    attendanceSummary: jest.fn(async () => ({ present: 1 })),
    conductRecords: jest.fn(async () => ({ rewards: [], disciplines: [] })),
    leaveSummary: jest.fn(async () => ({})),
    overtimeSummary: jest.fn(async () => ({})),
    taskStats: jest.fn(async () => ({})),
    projectContribution: jest.fn(async () => ({})),
    worklogSummary: jest.fn(async () => ({})),
    timesheetSummary: jest.fn(async () => ({})),
    teamMembership: jest.fn(async () => ([])),
  };

  const controller = new AnalyticsController(analytics);
  const SELF = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => jest.clearAllMocks());

  describe('who may read whose record', () => {
    it('lets HR read anybody', async () => {
      const res: any = await controller.attendance({ role: 'HR_MANAGER' }, OTHER);
      expect(res.success).toBe(true);
    });

    it('lets an employee read their own', async () => {
      const res: any = await controller.attendance({ role: 'EMPLOYEE', employeeId: SELF }, SELF);
      expect(res.success).toBe(true);
    });

    it('refuses an employee reading someone else', async () => {
      await expect(
        controller.attendance({ role: 'EMPLOYEE', employeeId: SELF }, OTHER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(analytics.attendanceSummary).not.toHaveBeenCalled();
    });

    it('refuses a manager reading a report of theirs through this route', async () => {
      // Deliberate: this endpoint carries conduct records, and "manages them"
      // is not the same permission as "may read their disciplinary history".
      await expect(
        controller.conduct({ role: 'MANAGER', employeeId: SELF }, OTHER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('the period', () => {
    it('defaults to the last 90 days when none is given', async () => {
      await controller.attendance({ role: 'ADMIN' }, SELF);
      const { from, to } = analytics.attendanceSummary.mock.calls[0][0];
      const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
      expect(days).toBe(90);
    });

    it('refuses a range longer than a year', async () => {
      await expect(
        controller.attendance({ role: 'ADMIN' }, SELF, '2020-01-01', '2026-01-01'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a range that runs backwards', async () => {
      await expect(
        controller.attendance({ role: 'ADMIN' }, SELF, '2026-06-01', '2026-01-01'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an unparseable date rather than silently defaulting', async () => {
      await expect(
        controller.attendance({ role: 'ADMIN' }, SELF, 'last-tuesday'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('gathers every aggregate for the summary route', async () => {
    const res: any = await controller.summary({ role: 'ADMIN' }, SELF);
    expect(analytics.teamMembership).toHaveBeenCalledWith(SELF);
    expect(Object.keys(res.data)).toEqual(
      expect.arrayContaining(['attendance', 'leave', 'overtime', 'conduct', 'teams']),
    );
  });
});
