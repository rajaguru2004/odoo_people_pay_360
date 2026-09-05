import axiosInstance from '@/lib/axios';
import type { ApiResponse } from '@/types/api';
import type { LeaveType } from '@/types/leave';

export type LibraryType = 'LEAVE_TYPE' | 'EMPLOYMENT_TYPE';

export interface LibraryItem {
  id: string;
  libraryType: LibraryType;
  label: string;
  isActive: boolean;
  sortOrder: number;
  defaultDays: number | null;
  isPaid: boolean;
  requiresNoticeDays: number;
  affectsBalance: boolean;
  genderRestriction: 'MALE' | 'FEMALE' | null;
}

export interface SaveLibraryItemPayload {
  libraryType?: LibraryType;
  label?: string;
  isActive?: boolean;
  sortOrder?: number;
  defaultDays?: number;
  isPaid?: boolean;
  requiresNoticeDays?: number;
  affectsBalance?: boolean;
  genderRestriction?: 'MALE' | 'FEMALE' | null;
}

/**
 * The admin-managed pick lists.
 *
 * `label` is the KEY every balance row and leave request stores, which is why
 * removing an item is a DEACTIVATION rather than a delete: a hard delete would
 * leave a year of history naming a type the list no longer offers.
 */
class LibraryItemService {
  list(
    type?: LibraryType,
    activeOnly?: boolean,
  ): Promise<ApiResponse<LibraryItem[]>> {
    return axiosInstance.get('/library-items', {
      params: { type, activeOnly },
    });
  }

  create(payload: SaveLibraryItemPayload): Promise<ApiResponse<LeaveType>> {
    return axiosInstance.post('/library-items', payload);
  }

  update(
    id: string,
    payload: SaveLibraryItemPayload,
  ): Promise<ApiResponse<LeaveType>> {
    return axiosInstance.patch(`/library-items/${id}`, payload);
  }

  /** Soft: the row stays so old requests keep resolving. */
  deactivate(id: string): Promise<ApiResponse<LeaveType>> {
    return axiosInstance.delete(`/library-items/${id}`);
  }
}

export default new LibraryItemService();
