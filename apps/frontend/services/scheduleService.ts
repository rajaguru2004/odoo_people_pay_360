import axiosInstance from '@/lib/axios';
import type { ApiResponse } from '@/types/api';
import type {
  EmployeeCalendar,
  ScheduleConflictReport,
  ScheduleCoverage,
  ScheduleOverview,
  SchedulePeriod,
  ScheduleStats,
  SchedulesHubSummary,
} from '@/types/schedules';

/**
 * Reading the roster.
 *
 * Every call here is a GET. Creating, editing and deleting a shift goes through
 * `workScheduleService` — one write path, one place the roster rules are
 * enforced, and no second door for a screen to reach.
 */
class ScheduleService {
  /** The Schedules dashboard, in one request. */
  hubSummary(
    period: SchedulePeriod = 'week',
    anchor?: string,
  ): Promise<ApiResponse<SchedulesHubSummary>> {
    return axiosInstance.get('/schedules/hub-summary', {
      params: { period, ...(anchor ? { anchor } : {}) },
    });
  }

  /**
   * The working-schedule grid: everyone down the side, every day across.
   *
   * One request draws the whole matrix — the employees, their shifts, the leave
   * days already recorded and each BRANCH's own holidays and weekly offs. A
   * second request per row would be headcount round trips for one screen.
   */
  overview(params: {
    startDate: string;
    endDate: string;
    branchId?: string;
    departmentId?: string;
  }): Promise<ApiResponse<ScheduleOverview>> {
    return axiosInstance.get('/schedules/overview', { params });
  }

  /**
   * One employee's calendar. Omit `employeeId` to read your own.
   *
   * Naming somebody else is allowed for admin, HR, payroll and managers — and a
   * manager only within the departments they head. The server decides; this just
   * asks.
   */
  calendar(params: {
    startDate: string;
    endDate: string;
    employeeId?: string;
  }): Promise<ApiResponse<EmployeeCalendar>> {
    return axiosInstance.get('/schedules/my', { params });
  }

  stats(params: {
    month: number;
    year: number;
    employeeId?: string;
  }): Promise<ApiResponse<ScheduleStats>> {
    return axiosInstance.get('/schedules/stats', { params });
  }

  coverage(params: {
    startDate: string;
    endDate: string;
  }): Promise<ApiResponse<ScheduleCoverage>> {
    return axiosInstance.get('/schedules/coverage', { params });
  }

  conflicts(params: {
    employeeId: string;
    startDate: string;
    endDate: string;
  }): Promise<ApiResponse<ScheduleConflictReport>> {
    return axiosInstance.get('/schedules/conflicts', { params });
  }
}

export default new ScheduleService();
