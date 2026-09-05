import axiosInstance from '@/lib/axios';

/**
 * Mirrors the Prisma `LibraryType` enum. Single source of truth for the union —
 * the settings screen and the fetch signature both derive from it, because
 * three hand-kept copies is exactly how ASSET_CATEGORY, PER_DIEM_DESTINATION,
 * COURSE_CATEGORY, BUDGET_CATEGORY and GRIEVANCE_CATEGORY ended up unreachable.
 * `library-coverage.spec.ts` fails the build if this drifts from the enum.
 */
export type LibraryTypeValue =
  | 'POSITION'
  | 'SALARY_COMPONENT_TYPE'
  | 'CONTRACT_TYPE'
  | 'WORK_MODE'
  | 'LEAVE_TYPE'
  | 'DOCUMENT_TYPE'
  | 'VISA_TYPE'
  | 'EMPLOYMENT_TYPE'
  | 'ASSET_CATEGORY'
  | 'PER_DIEM_DESTINATION'
  | 'COURSE_CATEGORY'
  | 'BUDGET_CATEGORY'
  | 'GRIEVANCE_CATEGORY';

export interface LibraryItem {
  id: string;
  libraryType: LibraryTypeValue;
  label: string;
  isActive: boolean;
  sortOrder: number;
  defaultDays?: number | null;
  isPaid?: boolean;
  requiresNoticeDays?: number;
  affectsBalance?: boolean;
  genderRestriction?: string | null;
  /**
   * EMPLOYMENT_TYPE only. The pay basis this employment type forces on every
   * employee assigned to it; null leaves each employee's own salaryType alone.
   */
  payBasis?: 'MONTHLY' | 'DAILY' | null;
  /**
   * PER_DIEM_DESTINATION only. Daily allowance for the destination; snapshotted
   * onto a travel request at submit so later edits never change approved trips.
   */
  perDiemRate?: string | number | null;
  createdAt: string;
  updatedAt: string;
}

class LibraryService {
  /**
   * Fetches all library items filtered by type and active status.
   */
  async getAll(
    type?: LibraryTypeValue,
    activeOnly?: boolean,
  ): Promise<{ success: boolean; data: LibraryItem[] }> {
    const params: Record<string, any> = {};
    if (type) params.type = type;
    if (activeOnly !== undefined) params.activeOnly = String(activeOnly);

    return axiosInstance.get('/library-items', { params });
  }

  /**
   * Creates a new library item.
   */
  async create(data: {
    libraryType: 'POSITION' | 'SALARY_COMPONENT_TYPE' | 'CONTRACT_TYPE' | 'WORK_MODE' | 'LEAVE_TYPE' | 'DOCUMENT_TYPE' | 'VISA_TYPE' | 'EMPLOYMENT_TYPE' | 'ASSET_CATEGORY' | 'PER_DIEM_DESTINATION' | 'COURSE_CATEGORY' | 'BUDGET_CATEGORY' | 'GRIEVANCE_CATEGORY';
    label: string;
    isActive?: boolean;
    sortOrder?: number;
    defaultDays?: number | null;
    isPaid?: boolean;
    requiresNoticeDays?: number;
    affectsBalance?: boolean;
    genderRestriction?: string | null;
    payBasis?: 'MONTHLY' | 'DAILY' | null;
  }): Promise<{ success: boolean; data: LibraryItem }> {
    return axiosInstance.post('/library-items', data);
  }

  /**
   * Updates an existing library item.
   */
  async update(
    id: string,
    data: {
      label?: string;
      isActive?: boolean;
      sortOrder?: number;
      defaultDays?: number | null;
      isPaid?: boolean;
      requiresNoticeDays?: number;
      affectsBalance?: boolean;
      genderRestriction?: string | null;
      payBasis?: 'MONTHLY' | 'DAILY' | null;
    },
  ): Promise<{ success: boolean; data: LibraryItem }> {
    return axiosInstance.patch(`/library-items/${id}`, data);
  }

  /**
   * Deletes a library item.
   */
  async delete(id: string): Promise<{ success: boolean; message: string }> {
    return axiosInstance.delete(`/library-items/${id}`);
  }

  /**
   * Runs position seeding.
   */
  async seed(): Promise<{ success: boolean; message: string }> {
    return axiosInstance.post('/library-items/seed');
  }
}

export default new LibraryService();
