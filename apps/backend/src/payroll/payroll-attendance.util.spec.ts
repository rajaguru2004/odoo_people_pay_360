import type { AttendanceStatus } from '@prisma/client';
import { resolvePaidDays } from './payroll-attendance.util';

const WORKING = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];
const at = (dayKey: string, status: string) => ({
  dayKey,
  status: status as AttendanceStatus,
});

describe('resolvePaidDays', () => {
  it('pays the whole month when nothing was recorded', () => {
    // A missing row is a gap in the data, not evidence somebody stayed home.
    // The pre-flight is what catches the case where that is dangerous.
    expect(resolvePaidDays(WORKING, [])).toEqual({
      workDays: 4,
      paidDays: 4,
      unpaidDays: 0,
    });
  });

  it('claws back a recorded absence', () => {
    const result = resolvePaidDays(WORKING, [at('2026-08-03', 'ABSENT')]);
    expect(result).toEqual({ workDays: 4, paidDays: 3, unpaidDays: 1 });
  });

  it('claws back half a day for a half day', () => {
    const result = resolvePaidDays(WORKING, [at('2026-08-03', 'HALF_DAY')]);
    expect(result.paidDays).toBe(3.5);
  });

  it('costs nothing for present, late, leave, holiday or weekend', () => {
    const result = resolvePaidDays(WORKING, [
      at('2026-08-03', 'PRESENT'),
      at('2026-08-04', 'LATE'),
      at('2026-08-05', 'ON_LEAVE'),
      at('2026-08-06', 'HOLIDAY'),
    ]);
    expect(result.unpaidDays).toBe(0);
  });

  it('ignores an absence recorded on a day the branch was closed', () => {
    // Friday, outside the working set.
    const result = resolvePaidDays(WORKING, [at('2026-08-07', 'ABSENT')]);
    expect(result.unpaidDays).toBe(0);
  });

  it('does not dock the same day twice when a day has two rows', () => {
    const result = resolvePaidDays(WORKING, [
      at('2026-08-03', 'ABSENT'),
      at('2026-08-03', 'ABSENT'),
    ]);
    expect(result.unpaidDays).toBe(1);
  });

  it('never reports more unpaid days than the month had', () => {
    const result = resolvePaidDays(
      WORKING,
      WORKING.concat(WORKING).map((k) => at(k, 'ABSENT')),
    );
    expect(result.unpaidDays).toBe(4);
    expect(result.paidDays).toBe(0);
  });

  it('is all zeros for a month the branch never opened', () => {
    expect(resolvePaidDays([], [at('2026-08-03', 'ABSENT')])).toEqual({
      workDays: 0,
      paidDays: 0,
      unpaidDays: 0,
    });
  });
});
