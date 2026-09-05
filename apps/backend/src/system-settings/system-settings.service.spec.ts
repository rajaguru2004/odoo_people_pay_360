import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import {
  SystemSettingsService,
  validateSettingValue,
} from './system-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { companyTzCache } from '../common/timezone/timezone-cache';

/**
 * Coverage for the lunch-break settings plumbing:
 *   - getLunchBreakPolicy(): parsing, defaults, and clamping of
 *     lunch_break_start / lunch_break_duration_minutes
 *   - setSetting(): HH:MM validation for lunch_break_start and non-negative
 *     integer clamping for lunch_break_duration_minutes
 *   - getAllSettings() / getSettingsList(): both keys ship with defaults
 */
describe('SystemSettingsService - lunch break settings', () => {
  let service: SystemSettingsService;
  let db: Record<string, string>;
  let prisma: any;

  beforeEach(async () => {
    db = {};
    prisma = {
      systemSetting: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where: { key } }: any) =>
            Promise.resolve(key in db ? { key, value: db[key] } : null),
          ),
        findMany: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              Object.entries(db).map(([key, value]) => ({ key, value })),
            ),
          ),
        upsert: jest.fn().mockImplementation(({ where: { key }, create }: any) => {
          db[key] = create.value;
          return Promise.resolve({ key, value: create.value });
        }),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: UploadService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(SystemSettingsService);
  });

  describe('getLunchBreakPolicy', () => {
    it('returns the defaults (13:00 / 60 min) when nothing is stored', async () => {
      await expect(service.getLunchBreakPolicy()).resolves.toEqual({
        startMinutes: 780,
        durationMinutes: 60,
      });
    });

    it('parses stored custom values', async () => {
      db.lunch_break_start = '11:30';
      db.lunch_break_duration_minutes = '45';
      await expect(service.getLunchBreakPolicy()).resolves.toEqual({
        startMinutes: 690,
        durationMinutes: 45,
      });
    });

    it('parses midnight and late-evening starts', async () => {
      db.lunch_break_start = '00:00';
      await expect(service.getLunchBreakPolicy()).resolves.toMatchObject({
        startMinutes: 0,
      });
      db.lunch_break_start = '23:59';
      await expect(service.getLunchBreakPolicy()).resolves.toMatchObject({
        startMinutes: 1439,
      });
    });

    it('falls back to 13:00 when the stored start is not valid HH:MM', async () => {
      for (const bad of ['25:99', '13', 'noon', '9:00', '']) {
        db.lunch_break_start = bad;
        await expect(service.getLunchBreakPolicy()).resolves.toMatchObject({
          startMinutes: 780,
        });
      }
    });

    it('clamps a negative stored duration to 0 (deduction disabled)', async () => {
      db.lunch_break_duration_minutes = '-30';
      await expect(service.getLunchBreakPolicy()).resolves.toMatchObject({
        durationMinutes: 0,
      });
    });

    it('falls back to 60 when the stored duration is not numeric', async () => {
      db.lunch_break_duration_minutes = 'abc';
      await expect(service.getLunchBreakPolicy()).resolves.toMatchObject({
        durationMinutes: 60,
      });
    });

    it('returns 0 duration verbatim (admin disabled the deduction)', async () => {
      db.lunch_break_duration_minutes = '0';
      await expect(service.getLunchBreakPolicy()).resolves.toMatchObject({
        durationMinutes: 0,
      });
    });
  });

  describe('setSetting validation', () => {
    it('accepts a valid lunch_break_start and stores it', async () => {
      await service.setSetting('lunch_break_start', '12:45');
      expect(db.lunch_break_start).toBe('12:45');
    });

    it.each(['25:99', '13:60', '1:00', 'lunch', ''])(
      'rejects invalid lunch_break_start %p with a 400',
      async (bad) => {
        await expect(
          service.setSetting('lunch_break_start', bad),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(db.lunch_break_start).toBeUndefined();
      },
    );

    it('stores a valid lunch_break_duration_minutes unchanged', async () => {
      await service.setSetting('lunch_break_duration_minutes', '90');
      expect(db.lunch_break_duration_minutes).toBe('90');
    });

    it('clamps a negative lunch_break_duration_minutes to 0', async () => {
      await service.setSetting('lunch_break_duration_minutes', '-15');
      expect(db.lunch_break_duration_minutes).toBe('0');
    });

    it('normalizes a decimal duration to an integer', async () => {
      await service.setSetting('lunch_break_duration_minutes', '45.9');
      expect(db.lunch_break_duration_minutes).toBe('45');
    });
  });

  describe('defaults exposure', () => {
    it('getAllSettings() seeds both lunch keys (feeds the /public endpoint)', async () => {
      const all = await service.getAllSettings();
      expect(all.lunch_break_start).toBe('13:00');
      expect(all.lunch_break_duration_minutes).toBe('60');
    });

    it('getSettingsList() lists both lunch keys for the admin UI', async () => {
      const list = await service.getSettingsList();
      const keys = list.map((s: any) => s.key);
      expect(keys).toContain('lunch_break_start');
      expect(keys).toContain('lunch_break_duration_minutes');
      expect(
        list.find((s: any) => s.key === 'lunch_break_start')?.value,
      ).toBe('13:00');
      expect(
        list.find((s: any) => s.key === 'lunch_break_duration_minutes')?.value,
      ).toBe('60');
    });

    it('getSettingsList() reflects stored overrides', async () => {
      db.lunch_break_start = '12:00';
      db.lunch_break_duration_minutes = '30';
      const list = await service.getSettingsList();
      expect(
        list.find((s: any) => s.key === 'lunch_break_start')?.value,
      ).toBe('12:00');
      expect(
        list.find((s: any) => s.key === 'lunch_break_duration_minutes')?.value,
      ).toBe('30');
    });
  });
});

/**
 * Coverage for the geofencing settings plumbing:
 *   - getGeofencingPolicy(): parsing, defaults, and null-coalescing of
 *     office_latitude / office_longitude / geofencing_radius_meters
 *   - setSetting(): range validation for lat/lng and positive-integer
 *     enforcement for the radius
 *   - updateSettings(): guards against enabling geofencing without office
 *     coordinates already set/being set
 */
describe('SystemSettingsService - geofencing settings', () => {
  let service: SystemSettingsService;
  let db: Record<string, string>;
  let prisma: any;

  beforeEach(async () => {
    db = {};
    prisma = {
      systemSetting: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where: { key } }: any) =>
            Promise.resolve(key in db ? { key, value: db[key] } : null),
          ),
        findMany: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              Object.entries(db).map(([key, value]) => ({ key, value })),
            ),
          ),
        upsert: jest.fn().mockImplementation(({ where: { key }, create }: any) => {
          db[key] = create.value;
          return Promise.resolve({ key, value: create.value });
        }),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: UploadService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(SystemSettingsService);
  });

  describe('getGeofencingPolicy', () => {
    it('returns disabled with null coords and 100m default radius when nothing is stored', async () => {
      await expect(service.getGeofencingPolicy()).resolves.toEqual({
        enabled: false,
        officeLat: null,
        officeLng: null,
        radiusMeters: 100,
      });
    });

    it('parses stored custom values', async () => {
      db.geofencing_enabled = 'true';
      db.office_latitude = '13.0827';
      db.office_longitude = '80.2707';
      db.geofencing_radius_meters = '250';
      await expect(service.getGeofencingPolicy()).resolves.toEqual({
        enabled: true,
        officeLat: 13.0827,
        officeLng: 80.2707,
        radiusMeters: 250,
      });
    });

    it('treats an empty office_latitude/longitude as unset (null)', async () => {
      db.geofencing_enabled = 'true';
      db.office_latitude = '';
      db.office_longitude = '';
      await expect(service.getGeofencingPolicy()).resolves.toMatchObject({
        officeLat: null,
        officeLng: null,
      });
    });

    it('falls back to 100m when the stored radius is not a positive number', async () => {
      for (const bad of ['0', '-50', 'abc', '']) {
        db.geofencing_radius_meters = bad;
        await expect(service.getGeofencingPolicy()).resolves.toMatchObject({
          radiusMeters: 100,
        });
      }
    });
  });

  describe('setSetting validation', () => {
    it('accepts a valid radius and stores it unchanged', async () => {
      await service.setSetting('geofencing_radius_meters', '150');
      expect(db.geofencing_radius_meters).toBe('150');
    });

    it.each(['0', '-100', 'abc', ''])(
      'rejects an invalid geofencing_radius_meters %p with a 400',
      async (bad) => {
        await expect(
          service.setSetting('geofencing_radius_meters', bad),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(db.geofencing_radius_meters).toBeUndefined();
      },
    );

    it('accepts a valid office_latitude and stores it', async () => {
      await service.setSetting('office_latitude', '13.0827');
      expect(db.office_latitude).toBe('13.0827');
    });

    it('allows clearing office_latitude back to an empty string', async () => {
      await service.setSetting('office_latitude', '');
      expect(db.office_latitude).toBe('');
    });

    it.each(['-91', '91', 'abc'])(
      'rejects an out-of-range/non-numeric office_latitude %p with a 400',
      async (bad) => {
        await expect(
          service.setSetting('office_latitude', bad),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it.each(['-181', '181', 'abc'])(
      'rejects an out-of-range/non-numeric office_longitude %p with a 400',
      async (bad) => {
        await expect(
          service.setSetting('office_longitude', bad),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );
  });

  describe('updateSettings guard', () => {
    it('rejects enabling geofencing when no office coordinates are stored or provided', async () => {
      await expect(
        service.updateSettings({ geofencing_enabled: 'true' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects enabling geofencing when coords are provided but not numeric', async () => {
      await expect(
        service.updateSettings({
          geofencing_enabled: 'true',
          office_latitude: 'abc',
          office_longitude: 'def',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('allows enabling geofencing when coords are included in the same payload', async () => {
      await expect(
        service.updateSettings({
          geofencing_enabled: 'true',
          office_latitude: '13.0827',
          office_longitude: '80.2707',
        }),
      ).resolves.toMatchObject({ success: true });
      expect(db.geofencing_enabled).toBe('true');
    });

    it('allows enabling geofencing when coords were already stored previously', async () => {
      db.office_latitude = '13.0827';
      db.office_longitude = '80.2707';
      await expect(
        service.updateSettings({ geofencing_enabled: 'true' }),
      ).resolves.toMatchObject({ success: true });
    });

    it('allows disabling geofencing regardless of coordinate state', async () => {
      await expect(
        service.updateSettings({ geofencing_enabled: 'false' }),
      ).resolves.toMatchObject({ success: true });
    });
  });

  describe('defaults exposure', () => {
    it('getAllSettings() seeds all four geofencing keys (feeds the /public endpoint)', async () => {
      const all = await service.getAllSettings();
      expect(all.geofencing_enabled).toBe('false');
      expect(all.office_latitude).toBe('');
      expect(all.office_longitude).toBe('');
      expect(all.geofencing_radius_meters).toBe('100');
    });

    it('getSettingsList() lists all four geofencing keys for the admin UI', async () => {
      const list = await service.getSettingsList();
      const keys = list.map((s: any) => s.key);
      expect(keys).toContain('geofencing_enabled');
      expect(keys).toContain('office_latitude');
      expect(keys).toContain('office_longitude');
      expect(keys).toContain('geofencing_radius_meters');
    });
  });
});

/**
 * system_timezone write path: IANA validation on write (garbage is rejected up
 * front instead of silently falling back on read) and cache invalidation so a
 * new company timezone applies on the very next request, not up to 60 s later.
 */
describe('SystemSettingsService - system_timezone', () => {
  let service: SystemSettingsService;
  let db: Record<string, string>;
  let prisma: any;

  beforeEach(async () => {
    db = {};
    prisma = {
      systemSetting: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where: { key } }: any) =>
            Promise.resolve(key in db ? { key, value: db[key] } : null),
          ),
        upsert: jest.fn().mockImplementation(({ where: { key }, create }: any) => {
          db[key] = create.value;
          return Promise.resolve({ key, value: create.value });
        }),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: UploadService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(SystemSettingsService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('accepts a valid IANA zone and persists it', async () => {
    await service.setSetting('system_timezone', 'Asia/Singapore');
    expect(db.system_timezone).toBe('Asia/Singapore');
  });

  it('rejects a non-IANA value', async () => {
    await expect(
      service.setSetting('system_timezone', 'Not/AZone'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.setSetting('system_timezone', 'garbage'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('invalidates the company-TZ cache after a successful write', async () => {
    const spy = jest.spyOn(companyTzCache, 'invalidate');
    await service.setSetting('system_timezone', 'America/New_York');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT invalidate the TZ cache for an unrelated setting', async () => {
    const spy = jest.spyOn(companyTzCache, 'invalidate');
    await service.setSetting('office_start_time', '09:00');
    expect(spy).not.toHaveBeenCalled();
  });
});


/**
 * Loan & advance settings: the read path and the write path.
 *
 * Two defects met here.
 *
 *   §13 — nine keys the engine READS were absent from `getSettingsList()`, the
 *   only thing GET /system-settings returns. They could be written and never
 *   read back, so an administrator could not see what they had set and nothing
 *   could restore a previous value.
 *
 *   §12 — `setSetting()` stored whatever it was given, and every reader coerces
 *   at use time with a silent fallback. `loan_shortfall_policy: 'BANANA'` read
 *   back as BANANA and ran as PARTIAL; a negative `loan_min_net_pay_percent`
 *   normalised to NO take-home floor; a 500% deduction cap lifted the cap. The
 *   screen showed a protection the engine was not applying.
 */
describe('SystemSettingsService - loan settings registry and validation', () => {
  let service: SystemSettingsService;
  let db: Record<string, string>;
  let prisma: any;

  beforeEach(async () => {
    db = {};
    prisma = {
      systemSetting: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where: { key } }: any) =>
            Promise.resolve(key in db ? { key, value: db[key] } : null),
          ),
        findMany: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              Object.entries(db).map(([key, value]) => ({ key, value })),
            ),
          ),
        upsert: jest.fn().mockImplementation(({ where: { key }, create }: any) => {
          db[key] = create.value;
          return Promise.resolve({ key, value: create.value });
        }),
        deleteMany: jest.fn().mockImplementation(({ where: { key } }: any) => {
          const existed = key in db;
          delete db[key];
          return Promise.resolve({ count: existed ? 1 : 0 });
        }),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SystemSettingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: UploadService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(SystemSettingsService);
  });

  const listed = async () => {
    const rows = await service.getSettingsList();
    return new Map(rows.map((r: any) => [r.key, r]));
  };

  describe('§13 — the nine write-only keys are now readable', () => {
    /**
     * Key → the default the ENGINE falls back to. Cross-checked against
     * DEFAULT_LOAN_POLICY in advance-loans/loan-policy.service.ts and against
     * the `getSetting(key, default)` call sites for the two keys that do not
     * go through the policy resolver.
     */
    const ENGINE_DEFAULTS: Record<string, string> = {
      loan_rounding_unit: '0.01', // LoanScheduleService.roundingUnit()
      loan_grace_period_cycles: '0',
      loan_deferral_mode: 'CARRY_FORWARD',
      loan_payment_allocation_order: 'INTEREST_FIRST',
      loan_priority_tiebreak: 'OLDEST_FIRST',
      loan_auto_close_on_full_recovery: 'true',
      loan_min_partial_recovery_amount: '1',
      loan_final_settlement_ignores_min_net: 'true',
      advance_loan_auditor_user_ids: '', // LoanAccessService.auditorUserIds()
    };

    it('lists every one of them', async () => {
      const map = await listed();
      const missing = Object.keys(ENGINE_DEFAULTS).filter((k) => !map.has(k));
      expect(missing).toEqual([]);
    });

    it('reports the default the engine actually falls back to', async () => {
      const map = await listed();
      for (const [key, expected] of Object.entries(ENGINE_DEFAULTS)) {
        expect([key, map.get(key)!.value]).toEqual([key, expected]);
      }
    });

    it('describes each one well enough to act on', async () => {
      const map = await listed();
      for (const key of Object.keys(ENGINE_DEFAULTS)) {
        expect(map.get(key)!.description.length).toBeGreaterThan(30);
      }
    });

    it('reads back what was written — the point of the fix', async () => {
      await service.setSetting('loan_deferral_mode', 'EXTEND_TENURE');
      await service.setSetting('loan_grace_period_cycles', '2');
      const map = await listed();
      expect(map.get('loan_deferral_mode')!.value).toBe('EXTEND_TENURE');
      expect(map.get('loan_grace_period_cycles')!.value).toBe('2');
    });
  });

  it('ships defaults that its own validator accepts', async () => {
    // A registry default that the write path would refuse is a trap: the admin
    // screen renders it, the admin presses Save without touching it, and the
    // save fails on a value the server itself supplied.
    const rows = await service.getSettingsList();
    const bad: string[] = [];
    for (const row of rows as any[]) {
      try {
        validateSettingValue(row.key, row.value);
      } catch (err: any) {
        bad.push(err.message);
      }
    }
    expect(bad).toEqual([]);
  });

  describe('§12 — a value the engine would discard is refused on write', () => {
    it('refuses an enum value that is not in the set', async () => {
      await expect(
        service.setSetting('loan_shortfall_policy', 'BANANA'),
      ).rejects.toThrow(/loan_shortfall_policy.*PARTIAL, DEFER, SKIP/s);
      expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
    });

    it('refuses a negative take-home floor (it normalised to NO floor)', async () => {
      await expect(
        service.setSetting('loan_min_net_pay_percent', '-10'),
      ).rejects.toThrow(/loan_min_net_pay_percent/);
      await expect(
        service.setSetting('loan_min_net_pay_amount', '-500'),
      ).rejects.toThrow(/loan_min_net_pay_amount/);
    });

    it('refuses a deduction cap above 100% (it lifted the cap entirely)', async () => {
      await expect(
        service.setSetting('loan_max_total_deduction_percent_of_net', '500'),
      ).rejects.toThrow(/loan_max_total_deduction_percent_of_net.*at most 100/s);
      // The boundary itself stays legal.
      await service.setSetting('loan_max_total_deduction_percent_of_net', '100');
      expect(db.loan_max_total_deduction_percent_of_net).toBe('100');
    });

    it('refuses a non-numeric value in a numeric key', async () => {
      await expect(
        service.setSetting('loan_min_net_pay_amount', 'not-a-number'),
      ).rejects.toThrow(/loan_min_net_pay_amount/);
    });

    it('refuses a non-boolean in a kill switch', async () => {
      await expect(
        service.setSetting('loan_module_v2_enabled', 'yes'),
      ).rejects.toThrow(/loan_module_v2_enabled.*"true" or "false"/s);
    });

    it('refuses a fractional or zero count where a count is required', async () => {
      await expect(
        service.setSetting('loan_grace_period_cycles', '1.5'),
      ).rejects.toThrow(/whole number/);
      await expect(
        service.setSetting('advance_loan_max_installments', '0'),
      ).rejects.toThrow(/advance_loan_max_installments/);
      // A rounding unit of 0 reads back as 0.01, so it must not be storable.
      await expect(
        service.setSetting('loan_rounding_unit', '0'),
      ).rejects.toThrow(/greater than 0/);
    });

    it('refuses a role that does not exist, and accepts blank', async () => {
      await expect(
        service.setSetting('advance_loan_finance_roles', 'ADMIN,WIZARD'),
      ).rejects.toThrow(/advance_loan_finance_roles.*ADMIN, HR_MANAGER, MANAGER, EMPLOYEE/s);
      await service.setSetting('advance_loan_auditor_roles', '');
      expect(db.advance_loan_auditor_roles).toBe('');
    });

    it('refuses an auditor user id that is not a UUID', async () => {
      await expect(
        service.setSetting('advance_loan_auditor_user_ids', 'bob'),
      ).rejects.toThrow(/advance_loan_auditor_user_ids.*UUID/s);
      await service.setSetting(
        'advance_loan_auditor_user_ids',
        '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      );
      expect(db.advance_loan_auditor_user_ids).toBe(
        '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      );
    });

    it('refuses a run type payroll does not have', async () => {
      await expect(
        service.setSetting('loan_recover_on_run_types', 'REGULAR,PAYDAY'),
      ).rejects.toThrow(/loan_recover_on_run_types/);
      await service.setSetting('loan_recover_on_run_types', 'REGULAR,BONUS');
      expect(db.loan_recover_on_run_types).toBe('REGULAR,BONUS');
    });

    it('stores enums and lists in the case the engine compares against', async () => {
      // Readers upper-case before comparing; storing the normalised form means
      // the settings screen shows exactly the string that is in force.
      await service.setSetting('loan_shortfall_policy', ' defer ');
      expect(db.loan_shortfall_policy).toBe('DEFER');
      await service.setSetting('advance_loan_writeoff_roles', 'admin, hr_manager');
      expect(db.advance_loan_writeoff_roles).toBe('ADMIN,HR_MANAGER');
    });

    it('leaves a key with no declared shape completely alone', async () => {
      // The write path accepts arbitrary keys on purpose — other modules park
      // their configuration here — so validation must not become a namespace
      // gate.
      await service.setSetting('some_other_module_setting', 'whatever-it-likes');
      expect(db.some_other_module_setting).toBe('whatever-it-likes');
    });

    it('refuses the WHOLE payload rather than half-applying it', async () => {
      await expect(
        service.updateSettings({
          loan_module_v2_enabled: 'true',
          loan_shortfall_policy: 'BANANA',
        }),
      ).rejects.toThrow(/loan_shortfall_policy/);
      // Neither key was written — a half-applied save is worse than a refused one.
      expect(db).toEqual({});
    });

    it('names every offending key when several are bad', async () => {
      await expect(
        service.updateSettings({
          loan_shortfall_policy: 'BANANA',
          loan_min_net_pay_percent: '-10',
        }),
      ).rejects.toThrow(/loan_shortfall_policy[\s\S]*loan_min_net_pay_percent/);
    });

    it('still applies a payload whose values are all in shape', async () => {
      await service.updateSettings({
        loan_module_v2_enabled: 'true',
        loan_shortfall_policy: 'DEFER',
        loan_min_net_pay_percent: '20',
      });
      expect(db.loan_module_v2_enabled).toBe('true');
      expect(db.loan_shortfall_policy).toBe('DEFER');
      expect(db.loan_min_net_pay_percent).toBe('20');
    });
  });

  /**
   * Blank is an INSTRUCTION, not a mistake.
   *
   * An administrator who clears an optional numeric field means "no override
   * here", and that has always worked. The first cut of §12's validation
   * refused it — which would have failed the whole settings save, every
   * unrelated key in the same payload included, because one optional number was
   * emptied. Worse than the bug it was fixing. So a blank on a key with a real
   * engine default clears the stored override; only genuinely wrong values are
   * refused.
   */
  describe('blank reverts to the engine default', () => {
    it('clears a numeric override instead of storing an empty string', async () => {
      await service.setSetting('advance_loan_max_installments', '4');
      expect(db.advance_loan_max_installments).toBe('4');

      await service.setSetting('advance_loan_max_installments', '');
      expect('advance_loan_max_installments' in db).toBe(false);
      // Absent, so both read paths report the registered default again.
      expect(await service.getSetting('advance_loan_max_installments', '12')).toBe('12');
      expect((await listed()).get('advance_loan_max_installments')!.value).toBe('12');
    });

    it('treats whitespace-only the same as blank', async () => {
      await service.setSetting('loan_min_net_pay_percent', '20');
      await service.setSetting('loan_min_net_pay_percent', '   ');
      expect('loan_min_net_pay_percent' in db).toBe(false);
      expect((await listed()).get('loan_min_net_pay_percent')!.value).toBe('0');
    });

    it('clears an enum, a boolean and an ordering list too', async () => {
      await service.setSetting('loan_shortfall_policy', 'SKIP');
      await service.setSetting('loan_module_v2_enabled', 'true');
      await service.setSetting('loan_recover_on_run_types', 'REGULAR');

      await service.setSetting('loan_shortfall_policy', '');
      await service.setSetting('loan_module_v2_enabled', '');
      await service.setSetting('loan_recover_on_run_types', '');

      const map = await listed();
      expect(map.get('loan_shortfall_policy')!.value).toBe('PARTIAL');
      expect(map.get('loan_module_v2_enabled')!.value).toBe('false');
      // `csv()` already resolved an empty value to this fallback, so an empty
      // list was never a way of saying "recover on nothing".
      expect(map.get('loan_recover_on_run_types')!.value).toBe(
        'REGULAR,FINAL_SETTLEMENT',
      );
    });

    it('does NOT clear an access list — blank there means nobody', async () => {
      // Clearing the row would restore 'HR_MANAGER,ADMIN' and hand approval
      // back to the roles the admin had just removed.
      await service.setSetting('advance_loan_approver_roles', '');
      expect(db.advance_loan_approver_roles).toBe('');
      expect((await listed()).get('advance_loan_approver_roles')!.value).toBe('');

      await service.setSetting('advance_loan_auditor_user_ids', '  ');
      expect(db.advance_loan_auditor_user_ids).toBe('');
    });

    it('is a no-op on a key that was never overridden', async () => {
      await expect(
        service.setSetting('loan_grace_period_cycles', ''),
      ).resolves.toBeDefined();
      expect(db).toEqual({});
    });

    it('saves the whole admin advance-loan tab with both numbers cleared', async () => {
      // Exactly what app/dashboard/settings/page.tsx posts for that tab: the
      // toggle and the role multi-select always send a value, the two number
      // inputs can be empty.
      await service.updateSettings({
        advance_loan_enabled: 'true',
        advance_loan_approver_roles: 'HR_MANAGER,ADMIN',
        advance_loan_max_installments: '',
        advance_max_percent_of_salary: '',
      });

      const map = await listed();
      expect(map.get('advance_loan_enabled')!.value).toBe('true');
      expect(map.get('advance_loan_approver_roles')!.value).toBe('HR_MANAGER,ADMIN');
      expect(map.get('advance_loan_max_installments')!.value).toBe('12');
      expect(map.get('advance_max_percent_of_salary')!.value).toBe('100');
    });

    it('still refuses the values that are actually wrong', async () => {
      // The blank allowance must not become a hole: a bad value is still a 400.
      await expect(
        service.setSetting('advance_loan_max_installments', 'not-a-number'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.setSetting('advance_max_percent_of_salary', '-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
