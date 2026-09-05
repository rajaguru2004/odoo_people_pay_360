import axios from 'axios';
import { FusionAnalyticsProvider } from './fusion-analytics.provider';
import { ResolvedIntegrationConfig } from '../types/attendance-provider.interface';

jest.mock('axios');
const mockedGet = axios.get as jest.Mock;

/**
 * Adapter-level coverage.
 *
 * The two things that can silently corrupt attendance are timestamp
 * interpretation and payload field mapping, so both are pinned here.
 *
 * The fixtures are the REAL response shapes, captured live from
 * live.thefusionapps.com on 2026-07-31 — two parallel arrays that must be
 * joined on employeeId, because attendance rows carry no branch or tenant:
 *
 *   GET /api/v4/attendance/employeeAttendances/all?date=YYYY-MM-DD
 *   { total, employees:[{employeeId, employeeName, branchId, tenantId, jobShift}],
 *             attendance:[{id, employeeId, clockIn, clockOut, attendanceStatus, clockInEventId}] }
 */
describe('FusionAnalyticsProvider', () => {
  let provider: FusionAnalyticsProvider;

  const cfg = (options: Record<string, unknown> = {}): ResolvedIntegrationConfig => ({
    id: 'int-1',
    provider: 'fusion-analytics',
    branchId: 'branch-1',
    baseUrl: 'https://live.thefusionapps.com',
    authScheme: 'header',
    authHeaderName: 'x-analytics-trigger-key',
    authSecret: 'test-key',
    externalBranchId: '55', // Taageer Finance HO — numeric, not "TAGGER"
    externalTenantId: '10',
    options,
    autoCreateAbsent: false,
  });

  beforeEach(() => {
    provider = new FusionAnalyticsProvider();
    mockedGet.mockReset();
  });

  /**
   * Build a whole-day feed. Attendance rows are auto-enrolled into the roster at
   * branch 55 / tenant 10 unless the row carries an explicit `_branchId`/`_tenantId`.
   */
  const respond = (rows: any[]) => {
    const employees = rows
      .filter((r) => r.employeeId)
      .map((r) => ({
        employeeId: r.employeeId,
        employeeName: r._name ?? `Emp ${r.employeeId}`,
        branchId: r._branchId ?? '55',
        tenantId: r._tenantId ?? 10,
        jobShift: 'TAAGEER-1',
      }));
    const attendance = rows.map(({ _branchId, _tenantId, _name, ...a }) => a);
    mockedGet.mockResolvedValue({
      status: 200,
      data: { total: attendance.length, employees, attendance },
    });
  };

  describe('auth + query', () => {
    it('reads the whole-day feed and sends the configured key header', async () => {
      respond([]);
      await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');

      const [url, options] = mockedGet.mock.calls[0];
      expect(url).toBe(
        'https://live.thefusionapps.com/api/v4/attendance/employeeAttendances/all',
      );
      expect(options.headers['x-analytics-trigger-key']).toBe('test-key');
      expect(options.params).toMatchObject({ date: '2026-07-20' });
    });

    it('uses a bearer token when the scheme says so', async () => {
      respond([]);
      await provider.fetchRange(
        { ...cfg(), authScheme: 'bearer' },
        '2026-07-20',
        '2026-07-20',
      );
      expect(mockedGet.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    });

    it('passes the configured calculationVersion through on the per-branch strategy', async () => {
      respond([]);
      await provider.fetchRange(
        cfg({ fetchStrategy: 'per-branch', calculationVersion: 'v3' }),
        '2026-07-20',
        '2026-07-20',
      );
      const [url, options] = mockedGet.mock.calls[0];
      expect(url).toContain('/employeeAttendances');
      expect(options.params).toMatchObject({
        branchId: '55',
        tenantId: '10',
        version: 'v3',
      });
    });
  });

  describe('branch filtering (the join)', () => {
    it('keeps only rows whose roster entry is in the configured branch', async () => {
      respond([
        { id: 1, employeeId: 'employee-taageer-1031', clockIn: '2026-07-20T03:27:06.383Z' },
        { id: 2, employeeId: 'employee-tmj-cbe-10606', clockIn: '2026-07-20T04:00:00.000Z', _branchId: '52' },
      ]);

      const out = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');

      expect(out).toHaveLength(1);
      expect(out[0].externalEmployeeId).toBe('employee-taageer-1031');
    });

    it('also filters on tenant — branch ids repeat across tenants', async () => {
      respond([
        { id: 1, employeeId: 'a', clockIn: '2026-07-20T03:00:00.000Z' },
        { id: 2, employeeId: 'b', clockIn: '2026-07-20T03:00:00.000Z', _tenantId: 6 },
      ]);

      const out = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');

      expect(out.map((r) => r.externalEmployeeId)).toEqual(['a']);
    });

    it('carries the roster name across for the unmapped-employee panel', async () => {
      respond([
        {
          id: 1,
          employeeId: 'employee-taageer-1031',
          clockIn: '2026-07-20T03:00:00.000Z',
          _name: 'Rabha Al Suleimany',
        },
      ]);

      const [rec] = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');
      expect(rec.externalEmployeeName).toBe('Rabha Al Suleimany');
    });

    it('skips an attendance row whose employee is missing from the roster', async () => {
      mockedGet.mockResolvedValue({
        status: 200,
        data: { employees: [], attendance: [{ id: 1, employeeId: 'orphan', clockIn: '2026-07-20T03:00:00.000Z' }] },
      });

      const out = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');
      expect(out).toHaveLength(0);
    });
  });

  describe('range handling', () => {
    it('reads one day at a time across the range', async () => {
      respond([]);
      await provider.fetchRange(cfg(), '2026-07-20', '2026-07-22');
      const dates = mockedGet.mock.calls.map((c) => c[1].params.date);
      expect(dates).toEqual(['2026-07-20', '2026-07-21', '2026-07-22']);
    });

    it("refuses a window wider than the provider's 31-day cap", async () => {
      await expect(
        provider.fetchRange(cfg(), '2026-01-01', '2026-03-01'),
      ).rejects.toThrow(/31-day limit/);
    });
  });

  describe('payload mapping', () => {
    it('maps a real record and keeps the requested day, not their date field', async () => {
      respond([
        {
          // Verbatim shape from the live API.
          id: 73172,
          employeeId: 'employee-taageer-1031',
          clockIn: '2026-07-30T03:27:06.383Z',
          clockOut: '2026-07-30T08:20:30.321Z',
          attendanceStatus: 'present',
          // Their date would be derived in Asia/Kolkata; we ignore it.
          date: '2026-07-19',
          _name: 'Rabha Al Suleimany',
        },
      ]);

      const [rec] = await provider.fetchRange(cfg(), '2026-07-30', '2026-07-30');

      expect(rec.externalEmployeeId).toBe('employee-taageer-1031');
      expect(rec.externalEmployeeName).toBe('Rabha Al Suleimany');
      expect(rec.businessDate).toBe('2026-07-30');
      expect(rec.externalRef).toBe('73172');
      // Their status is lowercase.
      expect(rec.status).toBe('PRESENT');
      expect(rec.checkIn?.toISOString()).toBe('2026-07-30T03:27:06.383Z');
      expect(rec.checkOut?.toISOString()).toBe('2026-07-30T08:20:30.321Z');
    });

    it('handles a row with no clockOut (still on shift / missed punch)', async () => {
      respond([
        {
          id: 1,
          employeeId: 'employee-taageer-1031',
          clockIn: '2026-07-30T03:27:06.383Z',
          clockOut: null,
          attendanceStatus: 'present',
        },
      ]);

      const [rec] = await provider.fetchRange(cfg(), '2026-07-30', '2026-07-30');
      expect(rec.checkIn).not.toBeNull();
      expect(rec.checkOut).toBeNull();
    });

    it('maps intra-day sessions when present', async () => {
      respond([
        {
          employeeId: 'TGR-001',
          clockIn: '2026-07-20T09:00:00+05:30',
          clockOut: '2026-07-20T18:00:00+05:30',
          sessions: [
            { clockIn: '2026-07-20T09:00:00+05:30', clockOut: '2026-07-20T13:00:00+05:30' },
            { clockIn: '2026-07-20T14:00:00+05:30', clockOut: '2026-07-20T18:00:00+05:30' },
          ],
        },
      ]);

      const [rec] = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');
      expect(rec.sessions).toHaveLength(2);
    });

    it('reports an explicit absence as ABSENT', async () => {
      respond([{ id: 1, employeeId: 'TGR-002', attendanceStatus: 'absent' }]);
      const [rec] = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');
      expect(rec.status).toBe('ABSENT');
      expect(rec.checkIn).toBeNull();
    });

    it('drops rows with no employee id rather than guessing', async () => {
      mockedGet.mockResolvedValue({
        status: 200,
        data: {
          employees: [{ employeeId: '', branchId: '55', tenantId: 10 }],
          attendance: [{ id: 1, clockIn: '2026-07-20T09:00:00+05:30' }],
        },
      });
      const out = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');
      expect(out).toHaveLength(0);
    });

    it("reads the per-branch endpoint's `list` wrapper", async () => {
      mockedGet.mockResolvedValue({
        status: 200,
        data: { totalEmployee: 1, list: [{ id: 1, employeeId: 'TGR-003' }] },
      });
      const out = await provider.fetchRange(
        cfg({ fetchStrategy: 'per-branch' }),
        '2026-07-20',
        '2026-07-20',
      );
      expect(out).toHaveLength(1);
    });
  });

  describe('collapsing duplicate rows (real source-data defects)', () => {
    it('merges several rows for one employee-day into one record', async () => {
      // Measured live: 10-15 of ~55 Taageer employees per day have >1 row.
      // Without collapsing, the (employeeId, date) upsert keeps whichever
      // happened to be processed last.
      respond([
        { id: 73177, employeeId: 'employee-taageer-1291', clockIn: '2026-07-30T02:31:45.317Z', clockOut: null },
        { id: 73178, employeeId: 'employee-taageer-1291', clockIn: '2026-07-30T03:19:09.563Z', clockOut: '2026-07-30T08:00:00.000Z' },
      ]);

      const out = await provider.fetchRange(cfg(), '2026-07-30', '2026-07-30');

      expect(out).toHaveLength(1);
      // v1 = First IN, Last OUT
      expect(out[0].checkIn?.toISOString()).toBe('2026-07-30T02:31:45.317Z');
      expect(out[0].checkOut?.toISOString()).toBe('2026-07-30T08:00:00.000Z');
      // Both source ids retained for traceability.
      expect(out[0].externalRef).toBe('73177,73178');
      // Intra-day detail preserved.
      expect(out[0].sessions).toHaveLength(2);
    });

    it('honours calculationVersion when choosing IN/OUT across rows', async () => {
      const rows = [
        { id: 1, employeeId: 'E1', clockIn: '2026-07-30T02:00:00.000Z', clockOut: '2026-07-30T06:00:00.000Z' },
        { id: 2, employeeId: 'E1', clockIn: '2026-07-30T04:00:00.000Z', clockOut: '2026-07-30T09:00:00.000Z' },
      ];

      respond(rows);
      const [v1] = await provider.fetchRange(cfg({ calculationVersion: 'v1' }), '2026-07-30', '2026-07-30');
      expect([v1.checkIn?.toISOString(), v1.checkOut?.toISOString()])
        .toEqual(['2026-07-30T02:00:00.000Z', '2026-07-30T09:00:00.000Z']); // first IN, last OUT

      respond(rows);
      const [v4] = await provider.fetchRange(cfg({ calculationVersion: 'v4' }), '2026-07-30', '2026-07-30');
      expect([v4.checkIn?.toISOString(), v4.checkOut?.toISOString()])
        .toEqual(['2026-07-30T04:00:00.000Z', '2026-07-30T06:00:00.000Z']); // last IN, first OUT
    });

    it('drops a clockOut that precedes its clockIn instead of inventing a 23-hour day', async () => {
      // Seen daily in the live feed (deltas of -3s, -18s): mis-paired duplicate
      // face events. Passing it through hits our overnight-shift rule, which
      // adds 24h and reports an almost-full-day shift.
      respond([
        {
          id: 73178,
          employeeId: 'employee-taageer-1291',
          clockIn: '2026-07-30T03:19:09.563Z',
          clockOut: '2026-07-30T03:18:51.942Z',
        },
      ]);

      const [rec] = await provider.fetchRange(cfg(), '2026-07-30', '2026-07-30');

      expect(rec.checkIn?.toISOString()).toBe('2026-07-30T03:19:09.563Z');
      expect(rec.checkOut).toBeNull();
    });
  });

  describe('timestamps', () => {
    it('keeps an explicit offset as the true instant', async () => {
      respond([{ id: 1, employeeId: 'E1', clockIn: '2026-07-20T09:00:00+05:30' }]);
      const [rec] = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');
      // 09:00 IST == 03:30 UTC
      expect(rec.checkIn?.toISOString()).toBe('2026-07-20T03:30:00.000Z');
    });

    it('reads a naive timestamp in the configured source timezone', async () => {
      respond([{ id: 1, employeeId: 'E1', clockIn: '2026-07-20 09:00:00' }]);
      const [rec] = await provider.fetchRange(
        cfg({ sourceTimezone: 'Asia/Kolkata' }),
        '2026-07-20',
        '2026-07-20',
      );
      expect(rec.checkIn?.toISOString()).toBe('2026-07-20T03:30:00.000Z');
    });

    it('wallclock mode re-anchors the clock face in the source timezone', async () => {
      // Same payload as the first case, but the clock face is authoritative:
      // 09:00 is meant to be 09:00 local, which is 05:00 UTC in Muscat.
      respond([{ id: 1, employeeId: 'E1', clockIn: '2026-07-20T09:00:00+05:30' }]);
      const [rec] = await provider.fetchRange(
        cfg({ timestampMode: 'wallclock', sourceTimezone: 'Asia/Muscat' }),
        '2026-07-20',
        '2026-07-20',
      );
      expect(rec.checkIn?.toISOString()).toBe('2026-07-20T05:00:00.000Z');
    });

    it('combines a bare HH:mm with the requested day', async () => {
      respond([{ id: 1, employeeId: 'E1', clockIn: '09:00' }]);
      const [rec] = await provider.fetchRange(
        cfg({ sourceTimezone: 'Asia/Kolkata' }),
        '2026-07-20',
        '2026-07-20',
      );
      expect(rec.checkIn?.toISOString()).toBe('2026-07-20T03:30:00.000Z');
    });

    it('accepts epoch seconds and milliseconds', async () => {
      // 2026-07-20T03:30:00Z. Asserted against the absolute value, not just
      // against each other — two nulls are also "equal".
      respond([
        { employeeId: 'E1', clockIn: 1784518200 },
        { employeeId: 'E2', clockIn: 1784518200000 },
      ]);
      const out = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');
      expect(out[0].checkIn?.toISOString()).toBe('2026-07-20T03:30:00.000Z');
      expect(out[1].checkIn?.toISOString()).toBe('2026-07-20T03:30:00.000Z');
    });

    it('returns null for an unparseable value instead of a wrong date', async () => {
      respond([{ id: 1, employeeId: 'E1', clockIn: 'not a time' }]);
      const [rec] = await provider.fetchRange(cfg(), '2026-07-20', '2026-07-20');
      expect(rec.checkIn).toBeNull();
    });
  });

  describe('errors', () => {
    it('explains a rejected key without retrying', async () => {
      mockedGet.mockRejectedValue({ response: { status: 401 } });
      await expect(
        provider.fetchRange(cfg(), '2026-07-20', '2026-07-20'),
      ).rejects.toThrow(/Authentication rejected/);
      expect(mockedGet).toHaveBeenCalledTimes(1); // 4xx is not retried
    });

    it('points at the base URL on a 404', async () => {
      mockedGet.mockRejectedValue({ response: { status: 404 } });
      await expect(
        provider.fetchRange(cfg(), '2026-07-20', '2026-07-20'),
      ).rejects.toThrow(/there is no \/api\/v5/);
    });

    it('retries a 5xx before giving up', async () => {
      mockedGet.mockRejectedValue({ response: { status: 503 } });
      await expect(
        provider.fetchRange(cfg(), '2026-07-20', '2026-07-20'),
      ).rejects.toThrow(/HTTP 503/);
      expect(mockedGet).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('testConnection', () => {
    it('probes the cheapest authenticated endpoint', async () => {
      mockedGet.mockResolvedValue({ status: 200, data: [] });
      const res = await provider.testConnection(cfg());

      expect(mockedGet.mock.calls[0][0]).toContain('/getTodaysAbsentees');
      expect(res.ok).toBe(true);
    });

    it('reports failure instead of throwing', async () => {
      mockedGet.mockRejectedValue({ response: { status: 403 } });
      const res = await provider.testConnection(cfg());
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/Authentication rejected/);
    });
  });
});
