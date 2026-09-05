import { BadRequestException } from '@nestjs/common';
import { BranchesService } from './branches.service';

/**
 * `weeklyOffDays` is the highest-leverage field on a branch: every day it names
 * is read back as a REST DAY by holidaysService.getWeeklyOffDays(), and
 * overtime on a rest day pays at the double multiplier.
 *
 * In Aug 2026 the Taneka Head Office branch was saved as "1,2,3,4,5,6" — the
 * WORKING days entered into the OFF-days field — and every Mon–Sat overtime
 * request from that moment on was classified SUNDAY / DOUBLE_LATE and priced at
 * 2x. These pin the normalisation that keeps the stored form canonical and
 * refuses the one set that can never be a real roster.
 */
describe('BranchesService.normalizeWeeklyOffDays', () => {
  // The normaliser is private and pure — reach it directly rather than standing
  // up Prisma for a string transform.
  const service = new BranchesService(null as any);
  const normalize = (dto: { weeklyOffDays?: string | null }) => {
    (service as any).normalizeWeeklyOffDays(dto);
    return dto.weeklyOffDays;
  };

  it('leaves an omitted field untouched (a patch that does not mention it)', () => {
    const dto: { weeklyOffDays?: string | null } = {};
    normalize(dto);
    expect('weeklyOffDays' in dto && dto.weeklyOffDays !== undefined).toBe(
      false,
    );
  });

  it('collapses null and empty string to null (inherit the company default)', () => {
    expect(normalize({ weeklyOffDays: null })).toBeNull();
    expect(normalize({ weeklyOffDays: '' })).toBeNull();
    expect(normalize({ weeklyOffDays: '   ' })).toBeNull();
  });

  it('sorts and de-duplicates so "0,0,6" is two off days, not three', () => {
    expect(normalize({ weeklyOffDays: '0,0,6' })).toBe('0,6');
    expect(normalize({ weeklyOffDays: '6,0' })).toBe('0,6');
    expect(normalize({ weeklyOffDays: ' 5 , 6 ' })).toBe('5,6');
  });

  it('keeps the ordinary Singapore roster (Sunday only) intact', () => {
    expect(normalize({ weeklyOffDays: '0' })).toBe('0');
  });

  it('still allows the 6-day set that caused the incident, normalised', () => {
    // Legal, if unusual — the branch form warns about the overtime consequence
    // rather than blocking the save, so a real one-day-a-week site still works.
    expect(normalize({ weeklyOffDays: '1,2,3,4,5,6' })).toBe('1,2,3,4,5,6');
  });

  it('refuses a set covering all seven days — no working day left', () => {
    expect(() => normalize({ weeklyOffDays: '0,1,2,3,4,5,6' })).toThrow(
      BadRequestException,
    );
    // Duplicates must not sneak a seven-day set past the check either.
    expect(() => normalize({ weeklyOffDays: '0,1,2,3,4,5,6,6' })).toThrow(
      BadRequestException,
    );
  });
});
