import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  Attendance,
  AttendanceListQuery,
  AttendanceSummary,
  BulkAttendancePayload,
  BulkAttendanceResult,
  CheckInPayload,
  CreateAttendancePayload,
  MonthlyAttendanceReport,
  MonthlyReportQuery,
  TodayBoard,
  UpdateAttendancePayload,
} from '@/types/attendance';
import type { AttendanceHubSummary, HubPeriod } from '@/types/attendanceHub';

class AttendanceService {
  list(query: AttendanceListQuery = {}): Promise<ApiResponse<Attendance[]>> {
    return axiosInstance.get('/attendances', { params: query });
  }

  /**
   * The board for today: the header totals and one record per active employee,
   * INCLUDING those who have not punched — an absence has to be visible before
   * anybody can explain it.
   *
   * Resolved per branch, so two offices in different zones each get their own
   * calendar day rather than the server's.
   */
  today(): Promise<ApiResponse<TodayBoard>> {
    return axiosInstance.get('/attendances/today');
  }

  summary(params: {
    startDate: string;
    endDate: string;
    departmentId?: string;
    branchId?: string;
  }): Promise<ApiResponse<AttendanceSummary>> {
    return axiosInstance.get('/attendances/summary', { params });
  }

  /**
   * One calendar month of the workforce for the attendance log grid.
   *
   * Not the paginated list narrowed to a month: this answers for everyone,
   * including the people with no record at all, and derives each absence from
   * the working calendar rather than counting rows that happen to say ABSENT.
   */
  monthlyReport(
    query: MonthlyReportQuery = {},
  ): Promise<ApiResponse<MonthlyAttendanceReport>> {
    return axiosInstance.get('/attendances/monthly-report', { params: query });
  }

  hubSummary(
    period: HubPeriod = 'month',
    anchor?: string,
  ): Promise<ApiResponse<AttendanceHubSummary>> {
    return axiosInstance.get('/attendances/hub-summary', {
      params: { period, ...(anchor ? { anchor } : {}) },
    });
  }

  forEmployee(
    employeeId: string,
    params: { startDate?: string; endDate?: string } = {},
  ): Promise<ApiResponse<Attendance[]>> {
    return axiosInstance.get(`/attendances/employee/${employeeId}`, { params });
  }

  get(id: string): Promise<ApiResponse<Attendance>> {
    return axiosInstance.get(`/attendances/${id}`);
  }

  checkIn(payload: CheckInPayload = {}): Promise<ApiResponse<Attendance>> {
    return axiosInstance.post('/attendances/check-in', payload);
  }

  checkOut(payload: CheckInPayload = {}): Promise<ApiResponse<Attendance>> {
    return axiosInstance.post('/attendances/check-out', payload);
  }

  create(payload: CreateAttendancePayload): Promise<ApiResponse<Attendance>> {
    return axiosInstance.post('/attendances', payload);
  }

  update(
    id: string,
    payload: UpdateAttendancePayload,
  ): Promise<ApiResponse<Attendance>> {
    return axiosInstance.patch(`/attendances/${id}`, payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/attendances/${id}`);
  }

  /** Reports per-row outcomes; one bad id does not fail the batch. */
  bulk(
    payload: BulkAttendancePayload,
  ): Promise<ApiResponse<BulkAttendanceResult>> {
    return axiosInstance.post('/attendances/bulk', payload);
  }
}

export default new AttendanceService();
