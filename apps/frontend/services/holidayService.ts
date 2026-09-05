import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { Holiday } from '@/types/holiday';

class HolidayService {
  /** Company-wide rows plus the branch's own; a branch row wins on a shared date. */
  list(
    params: { year?: number; branchId?: string } = {},
  ): Promise<ApiResponse<Holiday[]>> {
    return axiosInstance.get('/holidays', { params });
  }

  create(
    payload: Pick<Holiday, 'name' | 'date'> &
      Partial<Pick<Holiday, 'branchId' | 'isRecurring' | 'description'>>,
  ): Promise<ApiResponse<Holiday>> {
    return axiosInstance.post('/holidays', payload);
  }

  update(id: string, payload: Partial<Holiday>): Promise<ApiResponse<Holiday>> {
    return axiosInstance.patch(`/holidays/${id}`, payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/holidays/${id}`);
  }
}

export default new HolidayService();
