import { readFileSync } from 'fs';
import { join } from 'path';
import { LibraryType } from '@prisma/client';
import * as defaults from './library-defaults';

/**
 * The guard against a whole class of shipped bug.
 *
 * A `LibraryType` backs a dropdown somewhere in the UI. If nobody seeds it, that
 * dropdown renders with only its placeholder and the form is unusable — which is
 * exactly what happened to Travel ▸ Destination and Training ▸ Course: the enum
 * value existed, the API worked, and the screen was dead because the master was
 * empty and the Settings ▸ Library tab did not list the type, so an admin could
 * not even add rows.
 *
 * These tests fail the build for a new LibraryType that is either unseeded or
 * unmanageable, rather than letting it reach production as an empty dropdown.
 */

const SETTINGS_PAGE = join(
  __dirname,
  '../../../frontend/app/dashboard/settings/page.tsx',
);
const LIBRARY_SERVICE = join(__dirname, '../../../frontend/services/libraryService.ts');

/** Every enum value, straight from the generated Prisma client. */
const ALL_TYPES = Object.values(LibraryType) as LibraryType[];

/**
 * Types deliberately left empty, with the reason. Anything not listed here MUST
 * ship defaults. Keep this list short and justified.
 */
const INTENTIONALLY_UNSEEDED: Partial<Record<LibraryType, string>> = {
  // Nothing at present. A new entry needs a reason a reviewer would accept.
};

describe('LibraryType coverage', () => {
  it('seeds defaults for every library type', async () => {
    // Drive the real seeder against a recording stub — asserting on the seeder's
    // behaviour, not on a hand-maintained list that could drift from it.
    const seeded = new Set<string>();
    const db = {
      libraryItem: {
        upsert: jest.fn(async ({ create }: any) => {
          seeded.add(create.libraryType);
          return create;
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    } as any;

    await defaults.seedLibraryDefaults(db);

    const missing = ALL_TYPES.filter(
      (t) => !seeded.has(t) && !(t in INTENTIONALLY_UNSEEDED),
    );
    expect(missing).toEqual([]);
  });

  it('exposes every library type in the Settings ▸ Library tab', () => {
    // Without this an admin cannot add rows, so an empty master stays empty
    // forever with no route to fix it from the product.
    const page = readFileSync(SETTINGS_PAGE, 'utf8');
    const start = page.indexOf('const libraryTypes = [');
    expect(start).toBeGreaterThan(-1);
    const block = page.slice(start, page.indexOf('];', start));

    const missing = ALL_TYPES.filter((t) => !block.includes(`'${t}'`));
    expect(missing).toEqual([]);
  });

  it('accepts every library type in the frontend service signature', () => {
    // The `type` param is a hardcoded union; a type absent from it cannot be
    // fetched, so the dropdown that needs it silently gets nothing.
    const service = readFileSync(LIBRARY_SERVICE, 'utf8');
    const missing = ALL_TYPES.filter((t) => !service.includes(`'${t}'`));
    expect(missing).toEqual([]);
  });

  describe('per-diem destinations', () => {
    it('ship a usable rate so the travel form is not dead on arrival', () => {
      expect(defaults.PER_DIEM_DESTINATION_DEFAULTS.length).toBeGreaterThan(0);
      for (const d of defaults.PER_DIEM_DESTINATION_DEFAULTS) {
        expect(d.label.trim()).not.toBe('');
        expect(d.perDiemRate).toBeGreaterThanOrEqual(0);
      }
    });

    it('has no duplicate labels — the unique index would reject them', () => {
      const labels = defaults.PER_DIEM_DESTINATION_DEFAULTS.map((d) => d.label);
      expect(new Set(labels).size).toBe(labels.length);
    });
  });

  it('never overwrites an admin edit on reboot', async () => {
    // seedLibraryDefaults runs on every boot. Any upsert whose `update` is not
    // empty would silently revert a rate or a rename the admin made.
    const updates: any[] = [];
    const db = {
      libraryItem: {
        upsert: jest.fn(async ({ update, create }: any) => {
          updates.push(update);
          return create;
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
    } as any;

    await defaults.seedLibraryDefaults(db);

    for (const update of updates) {
      expect(Object.keys(update)).toEqual([]);
    }
  });
});
