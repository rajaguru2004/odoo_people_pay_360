import { TimezoneService } from './timezone.service';
import { SystemSettingsService } from '../../system-settings/system-settings.service';

describe('TimezoneService - attendance day boundary helpers', () => {
  let tz: TimezoneService;

  beforeEach(() => {
    const mockSettings = {
      getSetting: jest.fn().mockResolvedValue('Asia/Kolkata'),
    } as unknown as SystemSettingsService;
    tz = new TimezoneService(mockSettings);
  });

  describe('parseTimeHHMM', () => {
    it('parses valid HH:MM', () => {
      expect(tz.parseTimeHHMM('23:59', 0)).toBe(1439);
      expect(tz.parseTimeHHMM('01:00', 0)).toBe(60);
      expect(tz.parseTimeHHMM('00:00', 99)).toBe(0);
      expect(tz.parseTimeHHMM('9:15', 0)).toBe(555);
    });

    it('falls back on malformed input', () => {
      expect(tz.parseTimeHHMM('25:00', 1439)).toBe(1439);
      expect(tz.parseTimeHHMM('garbage', 1439)).toBe(1439);
      expect(tz.parseTimeHHMM('', 1439)).toBe(1439);
      expect(tz.parseTimeHHMM('12:60', 1439)).toBe(1439);
    });
  });

  describe('attendanceDayStartOffset (noon rule)', () => {
    it('same-day boundaries (>= 12:00) keep the calendar window', () => {
      expect(tz.attendanceDayStartOffset(1439)).toBe(0); // 23:59
      expect(tz.attendanceDayStartOffset(720)).toBe(0); // 12:00
      expect(tz.attendanceDayStartOffset(1050)).toBe(0); // 17:30
    });

    it('after-midnight boundaries (< 12:00) shift the day start', () => {
      expect(tz.attendanceDayStartOffset(60)).toBe(60); // 01:00
      expect(tz.attendanceDayStartOffset(0)).toBe(0); // 00:00 ≡ calendar
      expect(tz.attendanceDayStartOffset(719)).toBe(719); // 11:59
    });
  });

  describe('toAttendanceDateKey', () => {
    const IST = 'Asia/Kolkata';
    const NY = 'America/New_York';

    it('boundary 23:59 → identical to calendar mapping', () => {
      // 2026-06-11 10:00 IST = 04:30 UTC
      const morning = new Date(Date.UTC(2026, 5, 11, 4, 30));
      expect(tz.toAttendanceDateKey(morning, IST, 1439).getUTCDate()).toBe(11);

      // 2026-06-11 23:58 IST = 18:28 UTC
      const lateNight = new Date(Date.UTC(2026, 5, 11, 18, 28));
      expect(tz.toAttendanceDateKey(lateNight, IST, 1439).getUTCDate()).toBe(
        11,
      );

      // 2026-06-12 00:10 IST = June 11 18:40 UTC → next calendar day
      const pastMidnight = new Date(Date.UTC(2026, 5, 11, 18, 40));
      expect(
        tz.toAttendanceDateKey(pastMidnight, IST, 1439).getUTCDate(),
      ).toBe(12);
    });

    it('boundary 01:00 → times before 01:00 belong to the previous day', () => {
      // 2026-06-12 00:30 IST = June 11 19:00 UTC → previous day (June 11)
      const beforeBoundary = new Date(Date.UTC(2026, 5, 11, 19, 0));
      expect(
        tz.toAttendanceDateKey(beforeBoundary, IST, 60).getUTCDate(),
      ).toBe(11);

      // 2026-06-12 00:59 IST → still June 11
      const justBefore = new Date(Date.UTC(2026, 5, 11, 19, 29));
      expect(tz.toAttendanceDateKey(justBefore, IST, 60).getUTCDate()).toBe(
        11,
      );

      // 2026-06-12 01:00 IST exactly → the new day (half-open window)
      const atBoundary = new Date(Date.UTC(2026, 5, 11, 19, 30));
      expect(tz.toAttendanceDateKey(atBoundary, IST, 60).getUTCDate()).toBe(
        12,
      );

      // 2026-06-12 13:00 IST → same day (June 12)
      const afternoon = new Date(Date.UTC(2026, 5, 12, 7, 30));
      expect(tz.toAttendanceDateKey(afternoon, IST, 60).getUTCDate()).toBe(12);
    });

    it('boundary 00:00 ≡ calendar mapping', () => {
      const pastMidnight = new Date(Date.UTC(2026, 5, 11, 18, 40)); // 00:10 IST June 12
      expect(tz.toAttendanceDateKey(pastMidnight, IST, 0).getUTCDate()).toBe(
        12,
      );
    });

    it('noon edge: 11:59 boundary shifts, 12:00 does not', () => {
      // 2026-06-12 11:58 IST = 06:28 UTC
      const lateMorning = new Date(Date.UTC(2026, 5, 12, 6, 28));
      // boundary 11:59 → offset 719 → 11:58 < 11:59 → previous day
      expect(tz.toAttendanceDateKey(lateMorning, IST, 719).getUTCDate()).toBe(
        11,
      );
      // boundary 12:00 → offset 0 → calendar day
      expect(tz.toAttendanceDateKey(lateMorning, IST, 720).getUTCDate()).toBe(
        12,
      );
    });

    it('works in a negative-UTC-offset timezone', () => {
      // 2026-06-12 00:30 New York (EDT, UTC-4) = 04:30 UTC June 12
      const beforeBoundary = new Date(Date.UTC(2026, 5, 12, 4, 30));
      // boundary 01:00 → belongs to June 11
      expect(tz.toAttendanceDateKey(beforeBoundary, NY, 60).getUTCDate()).toBe(
        11,
      );
      // boundary 23:59 → calendar day June 12
      expect(
        tz.toAttendanceDateKey(beforeBoundary, NY, 1439).getUTCDate(),
      ).toBe(12);
    });
  });

  describe('attendanceDayEndUTC', () => {
    const IST = 'Asia/Kolkata';

    it('same-day boundary: closes on the given date', () => {
      // 2026-07-02 at 23:59 IST = 2026-07-02T18:29:00Z
      const closeAt = tz.attendanceDayEndUTC('2026-07-02', IST, 1439);
      expect(closeAt.toISOString()).toBe('2026-07-02T18:29:00.000Z');
    });

    it('after-midnight boundary: closes on the NEXT date', () => {
      // Day 2026-07-02 with boundary 01:00 closes 2026-07-03 01:00 IST = 2026-07-02T19:30:00Z
      const closeAt = tz.attendanceDayEndUTC('2026-07-02', IST, 60);
      expect(closeAt.toISOString()).toBe('2026-07-02T19:30:00.000Z');
    });

    it('midnight boundary (00:00): closes at next-day midnight', () => {
      // Day 2026-07-02 with boundary 00:00 closes 2026-07-03 00:00 IST = 2026-07-02T18:30:00Z
      const closeAt = tz.attendanceDayEndUTC('2026-07-02', IST, 0);
      expect(closeAt.toISOString()).toBe('2026-07-02T18:30:00.000Z');
    });
  });
});
