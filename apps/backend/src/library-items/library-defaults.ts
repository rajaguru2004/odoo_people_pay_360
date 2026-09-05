import { LibraryType, PrismaClient } from '@prisma/client';

/**
 * The pick lists a fresh database needs before anybody can file leave.
 *
 * Kept as data in its own file rather than inside the service so
 * `prisma/seed.ts` — which has no Nest container — creates exactly the same rows
 * the app would. Two lists that are meant to agree and are written twice do not
 * agree for long.
 */

export interface LeaveTypeDefault {
  label: string;
  defaultDays: number;
  isPaid: boolean;
  requiresNoticeDays: number;
  affectsBalance: boolean;
  genderRestriction: string | null;
  sortOrder: number;
}

export const LEAVE_TYPE_DEFAULTS: LeaveTypeDefault[] = [
  {
    label: 'Annual Leave',
    defaultDays: 30,
    isPaid: true,
    // Three days' warning, so a team can cover the desk. Enforced against the
    // START date in the company timezone, not against the filing date alone.
    requiresNoticeDays: 3,
    affectsBalance: true,
    genderRestriction: null,
    sortOrder: 1,
  },
  {
    label: 'Sick Leave',
    defaultDays: 30,
    isPaid: true,
    // Nobody plans an illness. A notice period here would make the rule
    // unusable on exactly the day it is needed.
    requiresNoticeDays: 0,
    affectsBalance: true,
    genderRestriction: null,
    sortOrder: 2,
  },
  {
    label: 'Unpaid Leave',
    defaultDays: 0,
    isPaid: false,
    requiresNoticeDays: 0,
    // The one type that touches no balance: it is still recorded and still
    // writes ON_LEAVE attendance, it simply costs no entitlement.
    affectsBalance: false,
    genderRestriction: null,
    sortOrder: 3,
  },
  {
    label: 'Maternity Leave',
    defaultDays: 98,
    isPaid: true,
    requiresNoticeDays: 0,
    affectsBalance: true,
    genderRestriction: 'FEMALE',
    sortOrder: 4,
  },
  {
    label: 'Paternity Leave',
    defaultDays: 7,
    isPaid: true,
    requiresNoticeDays: 0,
    affectsBalance: true,
    genderRestriction: 'MALE',
    sortOrder: 5,
  },
  {
    label: 'Bereavement Leave',
    defaultDays: 3,
    isPaid: true,
    requiresNoticeDays: 0,
    affectsBalance: true,
    genderRestriction: null,
    sortOrder: 6,
  },
];

/**
 * Employment types, which are the middle tier of the overtime-policy chain.
 *
 * Labels rather than an enum precisely so an administrator can add one without a
 * deploy — see the note on `Employee.employmentType`.
 */
export const EMPLOYMENT_TYPE_DEFAULTS = [
  'Monthly Staff',
  'Daily Wage',
  'Contractor',
];

/**
 * Create every default library item. Idempotent, and run on every boot.
 *
 * The `update` branch of each upsert is EMPTY on purpose. This runs at start-up,
 * so writing the defaults back would revert an administrator's edit on every
 * restart: set Annual Leave to 25 days, restart the container, and it is 30
 * again with nothing to show why.
 */
export async function seedLibraryDefaults(
  db: Pick<PrismaClient, 'libraryItem'>,
): Promise<void> {
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
        sortOrder: item.sortOrder,
        defaultDays: item.defaultDays,
        isPaid: item.isPaid,
        requiresNoticeDays: item.requiresNoticeDays,
        affectsBalance: item.affectsBalance,
        genderRestriction: item.genderRestriction,
      },
    });
  }

  for (const [index, label] of EMPLOYMENT_TYPE_DEFAULTS.entries()) {
    await db.libraryItem.upsert({
      where: {
        libraryType_label: {
          libraryType: LibraryType.EMPLOYMENT_TYPE,
          label,
        },
      },
      update: {},
      create: {
        libraryType: LibraryType.EMPLOYMENT_TYPE,
        label,
        isActive: true,
        sortOrder: index + 1,
      },
    });
  }
}
