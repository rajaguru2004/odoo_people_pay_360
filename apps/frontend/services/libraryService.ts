import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreateLibraryItemData,
  LibraryItem,
  LibraryItemQuery,
  UpdateLibraryItemPayload,
} from '@/types/library';

class LibraryService {
  /**
   * Readable by any signed-in caller — every form that draws one of these
   * dropdowns needs it, whatever the role of the person filling it in.
   */
  list(query: LibraryItemQuery = {}): Promise<ApiResponse<LibraryItem[]>> {
    // `activeOnly` goes over the wire as a string because the backend reads it
    // off the query string and compares it to 'true'/'false'; sending a boolean
    // through axios would serialise the same way but hides that from the reader.
    const params: Record<string, string> = {};
    if (query.type) params.type = query.type;
    if (query.activeOnly !== undefined) params.activeOnly = String(query.activeOnly);

    return axiosInstance.get('/library-items', { params });
  }

  create(payload: CreateLibraryItemData): Promise<ApiResponse<LibraryItem>> {
    return axiosInstance.post('/library-items', payload);
  }

  update(id: string, payload: UpdateLibraryItemPayload): Promise<ApiResponse<LibraryItem>> {
    return axiosInstance.patch(`/library-items/${id}`, payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/library-items/${id}`);
  }

  /** Re-creates the shipped defaults. Idempotent, so it is safe to press twice. */
  seed(): Promise<ApiResponse<{ seeded: boolean }>> {
    return axiosInstance.post('/library-items/seed', {});
  }
}

export default new LibraryService();
