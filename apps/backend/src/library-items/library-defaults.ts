import { LibraryType, PrismaClient } from '@prisma/client';

/**
 * The pick-list rows every environment needs before the screens that read them
 * are usable.
 *
 * Deliberately free of Nest and of PrismaService, so the two callers that have
 * nothing else in common can share one definition: `LibraryItemsService`
 * self-heals a running app from `onModuleInit`, and `prisma/seed.ts` is a bare
 * script with a raw client and no container. `PrismaService extends
 * PrismaClient`, so both satisfy the `db` parameter.
 */

export const POSITION_DEFAULTS = ['Manager', 'Employee'];

export const CONTRACT_TYPE_DEFAULTS = [
  'Probation (≤60 days)',
  'Definite term (12-36 months)',
  'Indefinite',
];

export const WORK_MODE_DEFAULTS = ['Full-time', 'Part-time'];

export const DOCUMENT_TYPE_DEFAULTS = [
  'Resume/CV',
  'ID Card Front',
  'ID Card Back',
  'Degree',
  'Certificate',
  'Contract',
  'Other',
];

export const VISA_TYPE_DEFAULTS = [
  'Employment Visa',
  'Residence Visa',
  'Visit Visa',
  'Business Visa',
  'Investor Visa',
  'Student Visa',
  'Dependent Visa',
  'Transit Visa',
];

export const ASSET_CATEGORY_DEFAULTS = [
  'Laptop',
  'Desktop',
  'Mobile Phone',
  'SIM Card',
  'Vehicle',
  'Access Card',
  'Tool',
  'Furniture',
  'Other',
];

export const COURSE_CATEGORY_DEFAULTS = [
  'Compliance',
  'Technical',
  'Leadership',
  'Health & Safety',
  'Soft Skills',
  'Finance',
  'Other',
];

export const GRIEVANCE_CATEGORY_DEFAULTS = [
  'Workplace Conduct',
  'Harassment',
  'Discrimination',
  'Pay & Benefits',
  'Working Conditions',
  'Management Practice',
  'Health & Safety',
  'Other',
];

/**
 * Employment types carry a pay basis: it is what makes an employee's base pay
 * mean "per month" or "per day" for everyone assigned that type. `null` leaves
 * the choice with each employee.
 */
export const EMPLOYMENT_TYPE_DEFAULTS: {
  label: string;
  payBasis: 'MONTHLY' | 'DAILY' | null;
  sortOrder: number;
}[] = [
  { label: 'Monthly', payBasis: 'MONTHLY', sortOrder: 0 },
  { label: 'Daily Wage', payBasis: 'DAILY', sortOrder: 1 },
  { label: 'Contract', payBasis: null, sortOrder: 2 },
];

export const LEAVE_TYPE_DEFAULTS = [
  {
    label: 'Annual Leave',
    defaultDays: 12,
    isPaid: true,
    requiresNoticeDays: 3,
    affectsBalance: true,
    genderRestriction: null,
  },
  {
    label: 'Sick Leave',
    defaultDays: 30,
    isPaid: true,
    requiresNoticeDays: 0,
    affectsBalance: true,
    genderRestriction: null,
  },
  {
    label: 'Unpaid Leave',
    defaultDays: 0,
    isPaid: false,
    requiresNoticeDays: 0,
    affectsBalance: false,
    genderRestriction: null,
  },
  {
    label: 'Maternity Leave',
    defaultDays: 90,
    isPaid: true,
    requiresNoticeDays: 0,
    affectsBalance: true,
    genderRestriction: 'FEMALE',
  },
  {
    label: 'Paternity Leave',
    defaultDays: 15,
    isPaid: true,
    requiresNoticeDays: 0,
    affectsBalance: true,
    genderRestriction: 'MALE',
  },
  {
    label: 'Bereavement Leave',
    defaultDays: 5,
    isPaid: true,
    requiresNoticeDays: 0,
    affectsBalance: true,
    genderRestriction: null,
  },
];

/** Upsert a label-only library, never touching a row that already exists. */
async function seedSimple(
  db: PrismaClient,
  libraryType: LibraryType,
  labels: string[],
) {
  for (const label of labels) {
    await db.libraryItem.upsert({
      where: { libraryType_label: { libraryType, label } },
      update: {},
      create: { libraryType, label, isActive: true, sortOrder: 0 },
    });
  }
}

/**
 * Create every default pick-list row. Idempotent, and safe to run on every
 * boot — which is exactly what it does.
 */
export async function seedLibraryDefaults(db: PrismaClient): Promise<void> {
  await seedSimple(db, LibraryType.POSITION, POSITION_DEFAULTS);
  await seedSimple(db, LibraryType.CONTRACT_TYPE, CONTRACT_TYPE_DEFAULTS);
  await seedSimple(db, LibraryType.WORK_MODE, WORK_MODE_DEFAULTS);
  await seedSimple(db, LibraryType.DOCUMENT_TYPE, DOCUMENT_TYPE_DEFAULTS);
  await seedSimple(db, LibraryType.VISA_TYPE, VISA_TYPE_DEFAULTS);
  await seedSimple(db, LibraryType.ASSET_CATEGORY, ASSET_CATEGORY_DEFAULTS);
  await seedSimple(db, LibraryType.COURSE_CATEGORY, COURSE_CATEGORY_DEFAULTS);
  await seedSimple(
    db,
    LibraryType.GRIEVANCE_CATEGORY,
    GRIEVANCE_CATEGORY_DEFAULTS,
  );

  for (const item of EMPLOYMENT_TYPE_DEFAULTS) {
    await db.libraryItem.upsert({
      where: {
        libraryType_label: {
          libraryType: LibraryType.EMPLOYMENT_TYPE,
          label: item.label,
        },
      },
      // Empty on purpose. This runs on every boot, so writing `payBasis` here
      // would overwrite an administrator's deliberate change every restart.
      update: {},
      create: {
        libraryType: LibraryType.EMPLOYMENT_TYPE,
        label: item.label,
        isActive: true,
        sortOrder: item.sortOrder,
        payBasis: item.payBasis,
      },
    });

    // ...but a database bootstrapped with `prisma db push` never ran a backfill,
    // so a pre-existing 'Daily Wage' row would keep a NULL basis for ever and
    // daily-wage staff would be paid as monthly. Fill it in ONLY where it is
    // still unset, which leaves any administrator choice intact.
    if (item.payBasis) {
      await db.libraryItem.updateMany({
        where: {
          libraryType: LibraryType.EMPLOYMENT_TYPE,
          label: item.label,
          payBasis: null,
        },
        data: { payBasis: item.payBasis },
      });
    }
  }

  for (const item of LEAVE_TYPE_DEFAULTS) {
    await db.libraryItem.upsert({
      where: {
        libraryType_label: {
          libraryType: LibraryType.LEAVE_TYPE,
          label: item.label,
        },
      },
      update: {},
      create: {
        libraryType: LibraryType.LEAVE_TYPE,
        label: item.label,
        isActive: true,
        sortOrder: 0,
        defaultDays: item.defaultDays,
        isPaid: item.isPaid,
        requiresNoticeDays: item.requiresNoticeDays,
        affectsBalance: item.affectsBalance,
        genderRestriction: item.genderRestriction,
      },
    });

    // Same reasoning as `payBasis`: fill a still-unset restriction, never
    // overwrite one somebody chose.
    if (item.genderRestriction) {
      await db.libraryItem.updateMany({
        where: {
          libraryType: LibraryType.LEAVE_TYPE,
          label: item.label,
          genderRestriction: null,
        },
        data: { genderRestriction: item.genderRestriction },
      });
    }
  }
}
