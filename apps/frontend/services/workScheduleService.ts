import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { ShiftType, WorkSchedule } from '@/types/attendance';

export interface BulkSchedulePayload {
  employeeIds: string[];
  startDate: string;
  endDate: string;
  shiftType: ShiftType;
  startTime?: string;
  endTime?: string;
  requiredHours?: number;
  /** Days to skip, as ISO weekday numbers (1 = Monday). */
  skipWeekdays?: number[];
}

/**
 * The roster.
 *
 * A row here means one person DEVIATES from their branch calendar on one day —
 * that is the only reason to store one. A table with a row per employee per day
 * would be headcount × 365 rows a year saying nothing the branch calendar does
 * not already say.
 */
class WorkScheduleService {
  list(
    params: { employeeId?: string; startDate?: string; endDate?: string } = {},
  ): Promise<ApiResponse<WorkSchedule[]>> {
    return axiosInstance.get('/work-schedules', { params });
  }

  create(
    payload: Omit<WorkSchedule, 'id' | 'createdAt' | 'updatedAt' | 'employee'>,
  ): Promise<ApiResponse<WorkSchedule>> {
    return axiosInstance.post('/work-schedules', payload);
  }

  update(
    id: string,
    payload: Partial<WorkSchedule>,
  ): Promise<ApiResponse<WorkSchedule>> {
    return axiosInstance.patch(`/work-schedules/${id}`, payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/work-schedules/${id}`);
  }

  bulk(
    payload: BulkSchedulePayload,
  ): Promise<ApiResponse<{ created: number; skipped: number }>> {
    return axiosInstance.post('/work-schedules/bulk', payload);
  }
}

export default new WorkScheduleService();
