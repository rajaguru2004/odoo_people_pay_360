import axiosInstance from '@/lib/axios';
import type { ApiResponse } from '@/types/api';
import type {
  CreateLibraryItemPayload,
  LibraryItem,
  LibraryTypeValue,
  UpdateLibraryItemPayload,
} from '@/types/library';

/**
 * The union is declared once, in `@/types/library`, and re-exported here under
 * the name the callers of this service already use. Two hand-kept copies is how
 * a list ends up with rows in the database and no way to reach them.
 */
export type LibraryType = LibraryTypeValue;
export type { LibraryItem };

/** A create body and an update body differ only in what is required. */
export type SaveLibraryItemPayload = UpdateLibraryItemPayload;

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

  create(
    payload: CreateLibraryItemPayload,
  ): Promise<ApiResponse<LibraryItem>> {
    return axiosInstance.post('/library-items', payload);
  }

  update(
    id: string,
    payload: SaveLibraryItemPayload,
  ): Promise<ApiResponse<LibraryItem>> {
    return axiosInstance.patch(`/library-items/${id}`, payload);
  }

  /** Soft: the row stays so old requests keep resolving. */
  deactivate(id: string): Promise<ApiResponse<LibraryItem>> {
    return axiosInstance.delete(`/library-items/${id}`);
  }

  /** Idempotent — re-running it adds only what is missing. */
  seedDefaults(): Promise<ApiResponse<void>> {
    return axiosInstance.post('/library-items/seed');
  }
}

export default new LibraryItemService();
