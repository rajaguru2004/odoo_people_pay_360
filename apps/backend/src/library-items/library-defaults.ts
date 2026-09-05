/**
 * The library items every environment needs before the app is usable.
 *
 * Deliberately free of Nest and of PrismaService so it can be called from two
 * places that have nothing else in common:
 *
 *  - `LibraryItemsService.onModuleInit()` — self-heals a running app;
 *  - `prisma/seed.ts` — a bare ts-node script with a raw PrismaClient and no DI
 *    container. Before this module existed the seed script created ZERO library
 *    items, so a freshly seeded database had no "Daily Wage" employment type
 *    (and no positions, leave types, or document types) until someone booted the
 *    backend.
 *
 * `PrismaService extends PrismaClient`, so both callers satisfy the `db` param.
 */
import { LibraryType, PrismaClient } from '@prisma/client';

/** A plain label-only default, for libraries that carry no metadata. */
type SimpleDefault = string;

export const POSITION_DEFAULTS: SimpleDefault[] = ['Manager', 'Employee'];

export const SALARY_COMPONENT_TYPE_DEFAULTS: SimpleDefault[] = [
  'Basic salary',
  'Allowances',
  'Lunch allowance',
  'Gasoline allowance',
  'Telephone allowance',
  'Housing allowance',
  'Position allowances',
  'Bonus',
  'Other',
];

export const CONTRACT_TYPE_DEFAULTS: SimpleDefault[] = [
  'Probation (≤60 days)',
  'Definite term (12-36 months)',
  'Indefinite',
];

export const WORK_MODE_DEFAULTS: SimpleDefault[] = ['Full-time', 'Part-time'];

/**
 * Employment types carry a pay basis: it is what makes `baseSalary` mean "per
 * month" or "per day" for everyone assigned to that type. `null` leaves the
 * choice to each employee.
 *
 * These are only DEFAULTS — an admin can flag any custom type, and nothing in
 * the pay logic matches on these labels.
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

export const DOCUMENT_TYPE_DEFAULTS: SimpleDefault[] = [
  'Resume/CV',
  'ID Card Front',
  'ID Card Back',
  'Degree',
  'Certificate',
  'Contract',
  'Other',
];

export const ASSET_CATEGORY_DEFAULTS: SimpleDefault[] = [
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

/**
 * Budget headings. 'Payroll' and 'Overtime' match what BudgetActualsService
 * derives from payroll rows; 'Travel' and 'Training' match what those modules
 * tag their commitments and claims with. Renaming one without the other breaks
 * the variance report's attribution.
 */
export const BUDGET_CATEGORY_DEFAULTS: SimpleDefault[] = [
  'Payroll',
  'Overtime',
  'Travel',
  'Training',
  'Recruitment',
  'Benefits',
  'Other',
];

export const COURSE_CATEGORY_DEFAULTS: SimpleDefault[] = [
  'Compliance',
  'Technical',
  'Leadership',
  'Health & Safety',
  'Soft Skills',
  'Finance',
  'Other',
];

/**
 * Per-diem destinations ship with a rate, so they cannot use `seedSimple`.
 *
 * These are starter rows an admin is expected to edit — a per-diem rate is
 * commercially specific. They exist because an EMPTY destination list makes the
 * travel request form unusable, with no hint that the fix lives in
 * Settings > Library.
 */
export interface PerDiemDefault {
  label: string;
  perDiemRate: number;
  sortOrder: number;
}

export const PER_DIEM_DESTINATION_DEFAULTS: PerDiemDefault[] = [
  { label: 'Local / Same City', perDiemRate: 0, sortOrder: 0 },
  { label: 'Domestic - Other City', perDiemRate: 25, sortOrder: 1 },
  { label: 'GCC', perDiemRate: 60, sortOrder: 2 },
  { label: 'Asia', perDiemRate: 75, sortOrder: 3 },
  { label: 'Europe', perDiemRate: 110, sortOrder: 4 },
  { label: 'Americas', perDiemRate: 120, sortOrder: 5 },
  { label: 'Rest of World', perDiemRate: 90, sortOrder: 6 },
];

export const GRIEVANCE_CATEGORY_DEFAULTS: SimpleDefault[] = [
  'Workplace Conduct',
  'Harassment',
  'Discrimination',
  'Pay & Benefits',
  'Working Conditions',
  'Management Practice',
  'Health & Safety',
  'Other',
];

export const VISA_TYPE_DEFAULTS: SimpleDefault[] = [
  'Employment Visa',
  'Residence Visa',
  'Visit Visa',
  'Business Visa',
  'Investor Visa',
  'Student Visa',
  'Dependent Visa',
  'Transit Visa',
];

export const LEAVE_TYPE_DEFAULTS = [
  { label: 'Annual Leave', defaultDays: 12, isPaid: true, requiresNoticeDays: 3, affectsBalance: true, genderRestriction: null },
  { label: 'Sick Leave', defaultDays: 30, isPaid: true, requiresNoticeDays: 0, affectsBalance: true, genderRestriction: null },
  { label: 'Unpaid Leave', defaultDays: 0, isPaid: false, requiresNoticeDays: 0, affectsBalance: false, genderRestriction: null },
  { label: 'Maternity Leave', defaultDays: 90, isPaid: true, requiresNoticeDays: 0, affectsBalance: true, genderRestriction: 'FEMALE' },
  { label: 'Paternity Leave', defaultDays: 15, isPaid: true, requiresNoticeDays: 0, affectsBalance: true, genderRestriction: 'MALE' },
  { label: 'Bereavement Leave', defaultDays: 5, isPaid: true, requiresNoticeDays: 0, affectsBalance: true, genderRestriction: null },
];

/** Upsert a label-only library, never touching an existing row. */
async function seedSimple(
  db: PrismaClient,
  libraryType: LibraryType,
  labels: SimpleDefault[],
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
 * Create every default library item. Idempotent, and safe to run on every app
 * boot — which it does.
 */
export async function seedLibraryDefaults(db: PrismaClient): Promise<void> {
  await seedSimple(db, LibraryType.POSITION, POSITION_DEFAULTS);
  await seedSimple(db, LibraryType.SALARY_COMPONENT_TYPE, SALARY_COMPONENT_TYPE_DEFAULTS);
  await seedSimple(db, LibraryType.CONTRACT_TYPE, CONTRACT_TYPE_DEFAULTS);
  await seedSimple(db, LibraryType.WORK_MODE, WORK_MODE_DEFAULTS);
  await seedSimple(db, LibraryType.DOCUMENT_TYPE, DOCUMENT_TYPE_DEFAULTS);
  await seedSimple(db, LibraryType.VISA_TYPE, VISA_TYPE_DEFAULTS);
  await seedSimple(db, LibraryType.ASSET_CATEGORY, ASSET_CATEGORY_DEFAULTS);
  await seedSimple(db, LibraryType.BUDGET_CATEGORY, BUDGET_CATEGORY_DEFAULTS);
  await seedSimple(db, LibraryType.GRIEVANCE_CATEGORY, GRIEVANCE_CATEGORY_DEFAULTS);
  await seedSimple(db, LibraryType.COURSE_CATEGORY, COURSE_CATEGORY_DEFAULTS);

  for (const item of PER_DIEM_DESTINATION_DEFAULTS) {
    await db.libraryItem.upsert({
      where: {
        libraryType_label: {
          libraryType: LibraryType.PER_DIEM_DESTINATION,
          label: item.label,
        },
      },
      // Empty on purpose — this runs on every boot, so writing perDiemRate here
      // would overwrite the admin's negotiated rate on every restart.
      update: {},
      create: {
        libraryType: LibraryType.PER_DIEM_DESTINATION,
        label: item.label,
        isActive: true,
        sortOrder: item.sortOrder,
        perDiemRate: item.perDiemRate,
      },
    });
  }

  for (const item of EMPLOYMENT_TYPE_DEFAULTS) {
    await db.libraryItem.upsert({
      where: {
        libraryType_label: {
          libraryType: LibraryType.EMPLOYMENT_TYPE,
          label: item.label,
        },
      },
      // Empty on purpose. This runs on every boot, so writing payBasis here
      // would overwrite an admin's deliberate change every time the app
      // restarts.
      update: {},
      create: {
        libraryType: LibraryType.EMPLOYMENT_TYPE,
        label: item.label,
        isActive: true,
        sortOrder: item.sortOrder,
        payBasis: item.payBasis,
      },
    });

    // ...but an environment bootstrapped with `prisma db push` never ran the
    // backfill migration, so its pre-existing 'Daily Wage' row would keep a NULL
    // basis forever and daily-wage staff would be paid as monthly. Fill it in
    // ONLY where it is still unset, which leaves any admin choice intact.
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
      // Empty on purpose. This runs on every boot; the previous
      // `update: { genderRestriction }` reverted an admin's choice on every
      // restart — set "Annual Leave" to FEMALE-only and it silently reset.
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

    // ...but an environment bootstrapped with `prisma db push` never ran the
    // original migration, so a pre-existing Maternity/Paternity row would keep a
    // NULL restriction forever. Fill it ONLY where still unset, exactly as
    // payBasis does above — which leaves any admin choice intact.
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
