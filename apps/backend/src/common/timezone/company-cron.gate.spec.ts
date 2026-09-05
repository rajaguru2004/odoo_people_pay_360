import { CompanyCronGate } from './company-cron.gate';
import { TimezoneService } from './timezone.service';
import { SystemSettingsService } from '../../system-settings/system-settings.service';
import { companyTzCache } from './timezone-cache';

/**
 * Daily jobs used to be pinned to a hardcoded `timeZone` on the @Cron
 * decorator, which cannot follow the admin's `system_timezone`. The gate
 * replaces it: a short tick plus a company-local window check.
 */
describe('CompanyCronGate', () => {
  // getCompanyTZ is backed by a process-wide cache — clear it so each test's
  // zone actually takes effect.
  beforeEach(() => companyTzCache.invalidate());

  const tzServiceFor = (zone: string) =>
    new TimezoneService({
      getSetting: jest.fn().mockResolvedValue(zone),
    } as unknown as SystemSettingsService);

  // 2026-06-11 18:00 UTC = 02:00 Asia/Singapore on the 12th
  const at = (iso: string) => new Date(iso);

  it('fires at the target wall clock of the COMPANY zone, not UTC', async () => {
    const gate = new CompanyCronGate(tzServiceFor('Asia/Singapore'), '02:00');
    // 02:00 SGT
    expect(await gate.due(at('2026-06-11T18:00:00Z'))).toBe(true);
  });

  it('does not fire at the same wall clock in another zone', async () => {
    const gate = new CompanyCronGate(tzServiceFor('Asia/Singapore'), '02:00');
    // 02:00 Asia/Kolkata = 20:30 UTC — 04:30 SGT, outside the window
    expect(await gate.due(at('2026-06-11T20:30:00Z'))).toBe(false);
  });

  it('fires at most once per company-local day', async () => {
    const gate = new CompanyCronGate(tzServiceFor('Asia/Singapore'), '02:00');
    expect(await gate.due(at('2026-06-11T18:00:00Z'))).toBe(true);
    // next tick, still inside the 5-minute window
    expect(await gate.due(at('2026-06-11T18:04:00Z'))).toBe(false);
    // next day, same wall clock
    expect(await gate.due(at('2026-06-12T18:00:00Z'))).toBe(true);
  });

  it('closes the window after windowMins', async () => {
    const gate = new CompanyCronGate(tzServiceFor('Asia/Singapore'), '02:00');
    expect(await gate.due(at('2026-06-11T18:05:00Z'))).toBe(false); // 02:05 SGT
    expect(await gate.due(at('2026-06-11T17:55:00Z'))).toBe(false); // 01:55 SGT
  });

  it('honors dayOfMonth in the company zone', async () => {
    const gate = new CompanyCronGate(tzServiceFor('Asia/Singapore'), '00:00', {
      dayOfMonth: 1,
    });
    // 2026-06-30 16:00 UTC = 2026-07-01 00:00 SGT → the 1st locally
    expect(await gate.due(at('2026-06-30T16:00:00Z'))).toBe(true);
    // 2026-07-01 00:00 UTC = 08:00 SGT on the 1st → wrong wall clock
    const other = new CompanyCronGate(tzServiceFor('Asia/Singapore'), '00:00', {
      dayOfMonth: 1,
    });
    expect(await other.due(at('2026-07-01T00:00:00Z'))).toBe(false);
  });

  it('works in a half-hour-offset zone', async () => {
    const gate = new CompanyCronGate(tzServiceFor('Asia/Kolkata'), '02:00');
    expect(await gate.due(at('2026-06-11T20:30:00Z'))).toBe(true);
  });
});
