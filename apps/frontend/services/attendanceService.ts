import axiosInstance from '@/lib/axios';
import type { AttendanceHubSummary, HubPeriod } from '@/types/attendanceHub';
import { ApiResponse } from '@/types/api';
import {
  Attendance,
  CheckInData,
  AttendanceReport,
  AttendanceCorrection,
  CreateCorrectionData,
  AttendanceStatistics
} from '@/types/attendance';

interface QueryAttendanceParams {
  employeeId?: string;
  startDate?: string;
  endDate?: string;
  month?: number;
  year?: number;
  page?: number;
  limit?: number;
}

class AttendanceService {
  // Check-in/out
  async checkIn(): Promise<ApiResponse<Attendance>> {
    return axiosInstance.post('/attendances/check-in');
  }

  async checkOut(): Promise<ApiResponse<Attendance>> {
    return axiosInstance.post('/attendances/check-out');
  }

  async lunchCheckIn(): Promise<ApiResponse<Attendance>> {
    return axiosInstance.post('/attendances/lunch-check-in');
  }

  async lunchCheckOut(): Promise<ApiResponse<Attendance>> {
    return axiosInstance.post('/attendances/lunch-check-out');
  }

  async getLunchStatus(): Promise<ApiResponse<{
    isOnLunchBreak: boolean;
    lunchCheckOutTime: string | null;
    lunchDurationMinutes: number;
    hasTakenLunchToday: boolean;
  }>> {
    return axiosInstance.get('/attendances/lunch-status');
  }

  async getTodayAttendance(): Promise<ApiResponse<Attendance | null>> {
    return axiosInstance.get('/attendances/today');
  }

  // My attendances (uses JWT — no employeeId needed)
  async getMyAttendances(month?: number, year?: number): Promise<ApiResponse<Attendance[]> & {
    summary: {
      totalDays: number;
      presentDays: number;
      lateDays: number;
      earlyLeaveDays: number;
      totalWorkHours: number;
    };
  }> {
    return axiosInstance.get('/attendances/my', {
      params: { month, year }
    });
  }

  // Employee attendances
  async getEmployeeAttendances(employeeId: string, month?: number, year?: number): Promise<ApiResponse<Attendance[]> & {
    summary: {
      totalDays: number;
      presentDays: number;
      lateDays: number;
      earlyLeaveDays: number;
      totalWorkHours: number;
    };
  }> {
    return axiosInstance.get(`/attendances/employee/${employeeId}`, {
      params: { month, year }
    });
  }

  // Reports and statistics
  async getMonthlyReport(month: number, year: number): Promise<ApiResponse<AttendanceReport>> {
    return axiosInstance.get('/attendances/report', {
      params: { month, year }
    });
  }

  async getStatistics(month?: number, year?: number): Promise<ApiResponse<AttendanceStatistics>> {
    return axiosInstance.get('/attendances/statistics', {
      params: { month, year }
    });
  }

  // Get all employees' today attendance (for admin)
  async getTodayAllAttendances(): Promise<ApiResponse<Attendance[]>> {
    return axiosInstance.get('/attendances/today/all');
  }

  // Attendance Corrections
  async getCorrections(params?: { status?: string; employeeId?: string }): Promise<ApiResponse<AttendanceCorrection[]>> {
    return axiosInstance.get('/attendance-corrections', { params });
  }

  async getPendingCorrections(): Promise<ApiResponse<AttendanceCorrection[]>> {
    return axiosInstance.get('/attendance-corrections/pending');
  }

  async getMyCorrections(): Promise<ApiResponse<AttendanceCorrection[]>> {
    return axiosInstance.get('/attendance-corrections/my-requests');
  }

  async getMyCorrectionUsage(): Promise<any> {
    return axiosInstance.get('/attendance-corrections/my-usage');
  }

  async getCorrectionById(id: string): Promise<ApiResponse<AttendanceCorrection>> {
    return axiosInstance.get(`/attendance-corrections/${id}`);
  }

  async createCorrection(data: CreateCorrectionData): Promise<ApiResponse<AttendanceCorrection>> {
    return axiosInstance.post('/attendance-corrections', data);
  }

  async approveCorrection(id: string, notes?: string): Promise<ApiResponse<AttendanceCorrection>> {
    return axiosInstance.post(`/attendance-corrections/${id}/approve`, notes ? { notes } : {});
  }

  async rejectCorrection(id: string, rejectedReason: string): Promise<ApiResponse<AttendanceCorrection>> {
    return axiosInstance.post(`/attendance-corrections/${id}/reject`, { rejectedReason });
  }

  async cancelCorrection(id: string): Promise<ApiResponse<AttendanceCorrection>> {
    return axiosInstance.delete(`/attendance-corrections/${id}`);
  }

  // Attendance Management (Admin only)
  async validateAttendance(month: number, year: number): Promise<ApiResponse<any>> {
    return axiosInstance.get('/attendances/validate', {
      params: { month, year }
    });
  }

  async autoMarkAbsent(): Promise<ApiResponse<any>> {
    return axiosInstance.post('/attendances/auto-mark-absent');
  }

  async createManualAttendance(data: {
    employeeId: string;
    date: string;
    checkIn?: string;
    checkOut?: string;
    status?: string;
    notes?: string;
  }): Promise<ApiResponse<any>> {
    return axiosInstance.post('/attendances/manual', data);
  }

  // Period-based overview (for the Attendance Overview page)
  async getOverview(
    period: 'today' | 'week' | 'month' | 'custom',
    date?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<ApiResponse<{
    period: string;
    stats: {
      totalEmployees: number;
      present: number;
      late: number;
      absent: number;
      earlyLeave: number;
      notCheckedOut: number;
      avgWorkHours: number;
      presentRate: number;
      lateRate: number;
      lateUsers?: string[];
      absentUsers?: string[];
      earlyLeaveUsers?: string[];
      notCheckedOutUsers?: string[];
      notCheckedInUsers?: string[];
    };
    trendData: Array<{
      date: string;
      attendanceRate: number;
      lateRate: number;
      present: number;
      absent: number;
      total: number;
    }>;
    recentCheckIns: any[];
    departmentBreakdown: Array<{
      department: string;
      present: number;
      late: number;
      absent: number;
      total: number;
    }>;
  }>> {
    return axiosInstance.get('/attendances/overview', { params: { period, date, startDate, endDate } });
  }

  /**
   * The module hub's single aggregate. One request instead of the four the hub
   * used to make, and the only place that knows what "expected" means.
   */
  async getHubSummary(
    period: HubPeriod,
    anchor?: string,
  ): Promise<ApiResponse<AttendanceHubSummary>> {
    return axiosInstance.get('/attendances/hub-summary', {
      params: { period, anchor },
    });
  }

  // Period-based paginated list (for the Attendance Overview table)
  async getAttendanceList(params: {
    period?: 'today' | 'week' | 'month' | 'custom';
    page?: number;
    limit?: number;
    status?: string;
    departmentId?: string;
    search?: string;
    date?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<ApiResponse<any>> {
    return axiosInstance.get('/attendances/list', { params });
  }

  async getAttendanceById(id: string): Promise<ApiResponse<Attendance>> {
    return axiosInstance.get(`/attendances/${id}`);
  }
}

export default new AttendanceService();

