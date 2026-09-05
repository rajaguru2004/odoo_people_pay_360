/**
 * Mirrors the Prisma `LibraryType` enum — the one place the union is written,
 * so the settings screen and every fetch signature derive from it rather than
 * keeping their own copies. A value missing here is a list with rows in the
 * database and no way to reach them.
 */
export type LibraryTypeValue =
  | 'POSITION'
  | 'CONTRACT_TYPE'
  | 'EMPLOYMENT_TYPE'
  | 'WORK_MODE'
  | 'LEAVE_TYPE'
  | 'DOCUMENT_TYPE'
  | 'VISA_TYPE'
  | 'ASSET_CATEGORY'
  | 'COURSE_CATEGORY'
  | 'GRIEVANCE_CATEGORY';

/** Null on the wire means "everyone", which is why it is not part of the union. */
export type GenderRestriction = 'MALE' | 'FEMALE';

/**
 * What an employment type makes an employee's base pay MEAN. Null leaves the
 * choice with each employee.
 */
export type PayBasis = 'MONTHLY' | 'DAILY';

export interface LibraryItem {
  id: string;
  libraryType: LibraryTypeValue;
  label: string;
  isActive: boolean;
  sortOrder: number;

  // LEAVE_TYPE metadata.
  defaultDays: number | null;
  isPaid: boolean;
  requiresNoticeDays: number;
  affectsBalance: boolean;
  genderRestriction: GenderRestriction | null;

  // EMPLOYMENT_TYPE metadata.
  payBasis: PayBasis | null;

  createdAt: string;
  updatedAt: string;
}

export interface LibraryItemQuery {
  type?: LibraryTypeValue;
  activeOnly?: boolean;
}

export interface CreateLibraryItemPayload {
  libraryType: LibraryTypeValue;
  label: string;
  isActive?: boolean;
  sortOrder?: number;
  defaultDays?: number | null;
  isPaid?: boolean;
  requiresNoticeDays?: number;
  affectsBalance?: boolean;
  genderRestriction?: GenderRestriction | null;
  payBasis?: PayBasis | null;
}

/** The create body under the name the library service reads it by. */
export type CreateLibraryItemData = CreateLibraryItemPayload;

/**
 * `libraryType` is fixed at creation — nothing moves a row between lists, and a
 * PATCH that carried one would let a leave type quietly become a job title.
 */
export type UpdateLibraryItemPayload = Partial<
  Omit<CreateLibraryItemPayload, 'libraryType'>
>;
