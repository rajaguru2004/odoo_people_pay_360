import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import {
  SETTING_VALUE_RULES,
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
 * The settings registry and the write path.
 *
 * Two defects met here.
 *
 *   A key the engine READS could be absent from `getSettingsList()`, the only
 *   thing GET /system-settings returns. It could be written and never read
 *   back, so an administrator could not see what they had set and nothing
 *   could restore a previous value.
 *
 *   `setSetting()` stored whatever it was given, and every reader coerces at
 *   use time with a silent fallback. An out-of-set enum read back verbatim and
 *   ran as the fallback; an out-of-range bound normalised away entirely. The
 *   screen showed a protection the engine was not applying.
 */
describe('SystemSettingsService - settings registry and value validation', () => {
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

  it('lists every key with a declared shape, so none is write-only', async () => {
    // A key the write path validates but the read path never returns is
    // invisible to the admin screen: it can be saved and never seen again.
    const map = await listed();
    const missing = Object.keys(SETTING_VALUE_RULES).filter((k) => !map.has(k));
    expect(missing).toEqual([]);
  });

  it('reads back what was written', async () => {
    await service.setSetting('payroll_cutoff_enforcement', 'BLOCK');
    await service.setSetting('document_bulk_max_items', '250');
    const map = await listed();
    expect(map.get('payroll_cutoff_enforcement')!.value).toBe('BLOCK');
    expect(map.get('document_bulk_max_items')!.value).toBe('250');
  });

  describe('a value the engine would discard is refused on write', () => {
    it('refuses an enum value that is not in the set', async () => {
      await expect(
        service.setSetting('payroll_cutoff_enforcement', 'BANANA'),
      ).rejects.toThrow(/payroll_cutoff_enforcement.*WARN, BLOCK/s);
      expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
    });

    it('refuses a negative amount where negative is meaningless', async () => {
      await expect(
        service.setSetting('overtime_site_allowance_max', '-500'),
      ).rejects.toThrow(/overtime_site_allowance_max/);
    });

    it('refuses a value above the declared ceiling', async () => {
      await expect(
        service.setSetting('document_bulk_max_items', '9000'),
      ).rejects.toThrow(/document_bulk_max_items.*at most 2000/s);
      // The boundary itself stays legal.
      await service.setSetting('document_bulk_max_items', '2000');
      expect(db.document_bulk_max_items).toBe('2000');
    });

    it('refuses a non-numeric value in a numeric key', async () => {
      await expect(
        service.setSetting('overtime_site_allowance_max', 'not-a-number'),
      ).rejects.toThrow(/overtime_site_allowance_max/);
    });

    it('refuses a non-boolean in a kill switch', async () => {
      await expect(
        service.setSetting('payroll_item_lines_enabled', 'yes'),
      ).rejects.toThrow(/payroll_item_lines_enabled.*"true" or "false"/s);
    });

    it('refuses a fractional or out-of-range count where a count is required', async () => {
      await expect(
        service.setSetting('document_render_concurrency', '1.5'),
      ).rejects.toThrow(/whole number/);
      await expect(
        service.setSetting('payroll_eosb_service_year_days', '0'),
      ).rejects.toThrow(/payroll_eosb_service_year_days/);
    });

    it('refuses a role that does not exist, and accepts blank', async () => {
      await expect(
        service.setSetting('document_bulk_generate_roles', 'ADMIN,WIZARD'),
      ).rejects.toThrow(
        /document_bulk_generate_roles.*ADMIN, HR_MANAGER, MANAGER, EMPLOYEE/s,
      );
      await service.setSetting('document_bulk_generate_roles', '');
      expect(db.document_bulk_generate_roles).toBe('');
    });

    it('stores enums and role lists in the case the engine compares against', async () => {
      // Readers upper-case before comparing; storing the normalised form means
      // the settings screen shows exactly the string that is in force.
      await service.setSetting('payroll_cutoff_enforcement', ' block ');
      expect(db.payroll_cutoff_enforcement).toBe('BLOCK');
      await service.setSetting('document_bulk_generate_roles', 'admin, hr_manager');
      expect(db.document_bulk_generate_roles).toBe('ADMIN,HR_MANAGER');
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
          payroll_item_lines_enabled: 'true',
          payroll_cutoff_enforcement: 'BANANA',
        }),
      ).rejects.toThrow(/payroll_cutoff_enforcement/);
      // Neither key was written — a half-applied save is worse than a refused one.
      expect(db).toEqual({});
    });

    it('names every offending key when several are bad', async () => {
      await expect(
        service.updateSettings({
          payroll_cutoff_enforcement: 'BANANA',
          document_bulk_max_items: '9000',
        }),
      ).rejects.toThrow(
        /payroll_cutoff_enforcement[\s\S]*document_bulk_max_items/,
      );
    });

    it('still applies a payload whose values are all in shape', async () => {
      await service.updateSettings({
        payroll_item_lines_enabled: 'true',
        payroll_cutoff_enforcement: 'BLOCK',
        document_bulk_max_items: '20',
      });
      expect(db.payroll_item_lines_enabled).toBe('true');
      expect(db.payroll_cutoff_enforcement).toBe('BLOCK');
      expect(db.document_bulk_max_items).toBe('20');
    });
  });

  /**
   * Blank is an INSTRUCTION, not a mistake.
   *
   * An administrator who clears an optional numeric field means "no override
   * here", and that has always worked. The first cut of this validation
   * refused it — which would have failed the whole settings save, every
   * unrelated key in the same payload included, because one optional number was
   * emptied. Worse than the bug it was fixing. So a blank on a key with a real
   * engine default clears the stored override; only genuinely wrong values are
   * refused.
   */
  describe('blank reverts to the engine default', () => {
    it('clears a numeric override instead of storing an empty string', async () => {
      await service.setSetting('document_bulk_max_items', '4');
      expect(db.document_bulk_max_items).toBe('4');

      await service.setSetting('document_bulk_max_items', '');
      expect('document_bulk_max_items' in db).toBe(false);
      // Absent, so both read paths report the registered default again.
      expect(await service.getSetting('document_bulk_max_items', '500')).toBe('500');
      expect((await listed()).get('document_bulk_max_items')!.value).toBe('500');
    });

    it('treats whitespace-only the same as blank', async () => {
      await service.setSetting('overtime_site_allowance_max', '20');
      await service.setSetting('overtime_site_allowance_max', '   ');
      expect('overtime_site_allowance_max' in db).toBe(false);
      expect((await listed()).get('overtime_site_allowance_max')!.value).toBe('0');
    });

    it('clears an enum and a boolean too', async () => {
      await service.setSetting('payroll_cutoff_enforcement', 'BLOCK');
      await service.setSetting('payroll_item_lines_enabled', 'true');

      await service.setSetting('payroll_cutoff_enforcement', '');
      await service.setSetting('payroll_item_lines_enabled', '');

      const map = await listed();
      expect(map.get('payroll_cutoff_enforcement')!.value).toBe('WARN');
      expect(map.get('payroll_item_lines_enabled')!.value).toBe('false');
    });

    it('does NOT clear an access list — blank there means nobody', async () => {
      // Clearing the row would restore 'ADMIN,HR_MANAGER' and hand the grant
      // back to the roles the admin had just removed.
      await service.setSetting('document_bulk_generate_roles', '');
      expect(db.document_bulk_generate_roles).toBe('');
      expect((await listed()).get('document_bulk_generate_roles')!.value).toBe('');

      await service.setSetting('document_bulk_generate_roles', '  ');
      expect(db.document_bulk_generate_roles).toBe('');
    });

    it('is a no-op on a key that was never overridden', async () => {
      await expect(
        service.setSetting('document_render_concurrency', ''),
      ).resolves.toBeDefined();
      expect(db).toEqual({});
    });

    it('saves a whole admin tab with its optional numbers cleared', async () => {
      // What a settings tab posts: the toggle and the role multi-select always
      // send a value, the number inputs can be empty.
      await service.updateSettings({
        document_bulk_enabled: 'true',
        document_bulk_generate_roles: 'HR_MANAGER,ADMIN',
        document_bulk_max_items: '',
        document_render_concurrency: '',
      });

      const map = await listed();
      expect(map.get('document_bulk_enabled')!.value).toBe('true');
      expect(map.get('document_bulk_generate_roles')!.value).toBe('HR_MANAGER,ADMIN');
      expect(map.get('document_bulk_max_items')!.value).toBe('500');
      expect(map.get('document_render_concurrency')!.value).toBe('2');
    });

    it('still refuses the values that are actually wrong', async () => {
      // The blank allowance must not become a hole: a bad value is still a 400.
      await expect(
        service.setSetting('document_bulk_max_items', 'not-a-number'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.setSetting('overtime_site_allowance_max', '-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
