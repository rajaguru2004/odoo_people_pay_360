import { companyTzCache } from './timezone-cache';

/**
 * Process-wide company-TZ cache. Backs TimezoneService.getCompanyTZ (avoids a DB
 * read per check-in) and is invalidated by SystemSettingsService when the
 * timezone setting changes, so a new zone takes effect immediately.
 */
describe('companyTzCache', () => {
  beforeEach(() => companyTzCache.invalidate());
  afterEach(() => {
    jest.useRealTimers();
    companyTzCache.invalidate();
  });

  it('returns null before anything is cached', () => {
    expect(companyTzCache.get()).toBeNull();
  });

  it('returns the set value while fresh', () => {
    companyTzCache.set('Asia/Singapore');
    expect(companyTzCache.get()).toBe('Asia/Singapore');
  });

  it('invalidate() clears the cached value', () => {
    companyTzCache.set('Asia/Singapore');
    companyTzCache.invalidate();
    expect(companyTzCache.get()).toBeNull();
  });

  it('expires after the 60 s TTL', () => {
    jest.useFakeTimers();
    companyTzCache.set('Asia/Kolkata');
    expect(companyTzCache.get()).toBe('Asia/Kolkata');
    jest.advanceTimersByTime(59_000);
    expect(companyTzCache.get()).toBe('Asia/Kolkata'); // still fresh
    jest.advanceTimersByTime(2_000);
    expect(companyTzCache.get()).toBeNull(); // past TTL
  });
});
