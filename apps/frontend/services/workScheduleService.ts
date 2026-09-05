import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { ShiftType, WorkSchedule } from '@/types/attendance';

export interface ListSchedulesParams {
  employeeId?: string;
  branchId?: string;
  shiftType?: ShiftType;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export interface CreateSchedulePayload {
  employeeId: string;
  /** "YYYY-MM-DD". A date-only value — never an instant. */
  date: string;
  shiftType?: ShiftType;
  /** Wall clock, "HH:MM". Required for every type except FLEXIBLE. */
  startTime?: string | null;
  endTime?: string | null;
  /** Required for FLEXIBLE, which has no window to measure. */
  requiredHours?: number | null;
  isWorkDay?: boolean;
  notes?: string | null;
}

export type UpdateSchedulePayload = Partial<
  Omit<CreateSchedulePayload, 'employeeId' | 'date'>
>;

export interface BulkSchedulePayload {
  employeeIds: string[];
  startDate: string;
  endDate: string;
  /**
   * Days the pattern APPLIES to, as ISO weekday numbers (1 = Monday).
   *
   * Omitted or empty means every day in the range. Note the direction — this is
   * not a skip list; sending `[1,2,3,4,5]` rosters the working week and leaves
   * the weekend alone.
   */
  weekdays?: number[];
  shiftType?: ShiftType;
  startTime?: string | null;
  endTime?: string | null;
  requiredHours?: number | null;
  isWorkDay?: boolean;
  /** Replace a day that is already rostered instead of reporting it. */
  overwrite?: boolean;
  notes?: string | null;
}

/** What the bulk endpoint reports back, day by day. */
export interface BulkScheduleResult {
  range: { startDate: string; endDate: string };
  days: number;
  employees: number;
  created: number;
  replaced: number;
  skipped: number;
  failed: number;
  results: Array<{
    employeeId: string;
    date: string;
    outcome: 'created' | 'replaced' | 'skipped' | 'failed';
    message?: string;
  }>;
}

/**
 * Writing the roster.
 *
 * A row here means one person DEVIATES from their branch calendar on one day —
 * that is the only reason to store one. A table with a row per employee per day
 * would be headcount × 365 rows a year saying nothing the branch calendar does
 * not already say.
 *
 * Reads that span more than one person's rows — the grid, the coverage sweep,
 * the dashboard — go through `scheduleService` instead.
 */
class WorkScheduleService {
  list(params: ListSchedulesParams = {}): Promise<ApiResponse<WorkSchedule[]>> {
    return axiosInstance.get('/work-schedules', { params });
  }

  get(id: string): Promise<ApiResponse<WorkSchedule>> {
    return axiosInstance.get(`/work-schedules/${id}`);
  }

  create(payload: CreateSchedulePayload): Promise<ApiResponse<WorkSchedule>> {
    return axiosInstance.post('/work-schedules', payload);
  }

  update(
    id: string,
    payload: UpdateSchedulePayload,
  ): Promise<ApiResponse<WorkSchedule>> {
    return axiosInstance.patch(`/work-schedules/${id}`, payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/work-schedules/${id}`);
  }

  /**
   * Lay one shift pattern over a range for a set of people.
   *
   * Reports every day it created, replaced or left alone rather than failing
   * the batch — somebody laying a March night shift over a month that already
   * has three hand-made exceptions in it wants to know about those three, not
   * to lose them.
   */
  bulk(payload: BulkSchedulePayload): Promise<ApiResponse<BulkScheduleResult>> {
    return axiosInstance.post('/work-schedules/bulk', payload);
  }
}

export default new WorkScheduleService();
