import { BadRequestException } from '@nestjs/common';
import { LibraryType } from '@prisma/client';
import { LibraryItemsService } from './library-items.service';
import { seedLibraryDefaults, EMPLOYMENT_TYPE_DEFAULTS } from './library-defaults';

/**
 * `payBasis` on an EMPLOYMENT_TYPE library item is what decides whether an
 * employee's baseSalary means "per month" or "per day". Two things must hold:
 * it can only be set where something reads it, and re-seeding must never
 * overwrite an admin's deliberate choice — the seeder runs on every app boot.
 */
describe('LibraryItemsService — payBasis', () => {
  let prisma: any;
  let service: LibraryItemsService;

  beforeEach(() => {
    prisma = {
      libraryItem: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => data),
        update: jest.fn().mockImplementation(async ({ data }: any) => data),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    service = new LibraryItemsService(prisma);
  });

  describe('create()', () => {
    it('accepts payBasis on an EMPLOYMENT_TYPE item', async () => {
      await expect(
        service.create({
          libraryType: LibraryType.EMPLOYMENT_TYPE,
          label: 'Site Labour',
          payBasis: 'DAILY',
        } as any),
      ).resolves.toMatchObject({ payBasis: 'DAILY' });
    });

    it.each([LibraryType.POSITION, LibraryType.LEAVE_TYPE, LibraryType.WORK_MODE])(
      'rejects payBasis on a %s item — nothing would ever read it',
      async (libraryType) => {
        await expect(
          service.create({ libraryType, label: 'X', payBasis: 'DAILY' } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('a null payBasis is fine on any library — it means "unspecified"', async () => {
      await expect(
        service.create({
          libraryType: LibraryType.POSITION,
          label: 'Fitter',
          payBasis: null,
        } as any),
      ).resolves.toBeDefined();
    });
  });

  describe('update()', () => {
    const existing = (libraryType: LibraryType) =>
      prisma.libraryItem.findUnique.mockResolvedValue({
        id: 'li-1',
        libraryType,
        label: 'Existing',
      });

    it('checks the STORED library type when the PATCH omits it', async () => {
      existing(LibraryType.POSITION);
      await expect(
        service.update('li-1', { payBasis: 'DAILY' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a payBasis-only PATCH does not run the label uniqueness check', async () => {
      // Guarding on libraryType alone ran findFirst with `label: undefined`,
      // which matched any other row in the library and 409'd spuriously.
      existing(LibraryType.EMPLOYMENT_TYPE);
      await service.update('li-1', { payBasis: 'DAILY' } as any);
      expect(prisma.libraryItem.findFirst).not.toHaveBeenCalled();
    });

    it('clearing the flag back to null is allowed', async () => {
      existing(LibraryType.EMPLOYMENT_TYPE);
      await expect(
        service.update('li-1', { payBasis: null } as any),
      ).resolves.toMatchObject({ payBasis: null });
    });
  });
});

describe('seedLibraryDefaults — employment types carry a pay basis', () => {
  it('ships a daily-wage and a monthly employment type', () => {
    expect(EMPLOYMENT_TYPE_DEFAULTS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ payBasis: 'DAILY' }),
        expect.objectContaining({ payBasis: 'MONTHLY' }),
      ]),
    );
  });

  it('creates flagged rows but never UPDATES them — the seeder runs every boot', async () => {
    const db: any = {
      libraryItem: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    await seedLibraryDefaults(db);

    const employmentUpserts = db.libraryItem.upsert.mock.calls
      .map((c: any[]) => c[0])
      .filter((a: any) => a.create.libraryType === LibraryType.EMPLOYMENT_TYPE);

    expect(employmentUpserts.length).toBe(EMPLOYMENT_TYPE_DEFAULTS.length);
    // An empty `update` is what stops a restart from stomping an admin's choice.
    for (const arg of employmentUpserts) expect(arg.update).toEqual({});
    expect(
      employmentUpserts.find((a: any) => a.create.payBasis === 'DAILY'),
    ).toBeDefined();
  });

  it('back-fills the flag ONLY where it is still null', async () => {
    const db: any = {
      libraryItem: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    await seedLibraryDefaults(db);

    const allFills = db.libraryItem.updateMany.mock.calls.map((c: any[]) => c[0]);
    // LEAVE_TYPE back-fills genderRestriction the same way, so narrow to the
    // employment-type fills this test is about.
    const fills = allFills.filter(
      (f: any) => f.where.libraryType === LibraryType.EMPLOYMENT_TYPE,
    );
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) {
      // The null guard is the whole safety property: an environment
      // bootstrapped with `prisma db push` gets healed, an admin choice does not.
      expect(fill.where.payBasis).toBeNull();
      expect(fill.where.libraryType).toBe(LibraryType.EMPLOYMENT_TYPE);
    }
    // The unflagged default ("Contract") has nothing to fill in.
    expect(fills.length).toBe(
      EMPLOYMENT_TYPE_DEFAULTS.filter((d) => d.payBasis).length,
    );

    // Every fill, of either kind, must be null-guarded — that is the property.
    for (const fill of allFills) {
      const guarded =
        fill.where.payBasis === null || fill.where.genderRestriction === null;
      expect(guarded).toBe(true);
    }
  });

  it('is idempotent — a second run issues the same writes, none destructive', async () => {
    const db: any = {
      libraryItem: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    await seedLibraryDefaults(db);
    const first = db.libraryItem.upsert.mock.calls.length;
    await seedLibraryDefaults(db);
    expect(db.libraryItem.upsert.mock.calls.length).toBe(first * 2);
    for (const [arg] of db.libraryItem.upsert.mock.calls) {
      // LEAVE_TYPE syncs genderRestriction; nothing else is ever overwritten.
      const keys = Object.keys(arg.update);
      expect(keys.every((k) => k === 'genderRestriction')).toBe(true);
    }
  });
});
