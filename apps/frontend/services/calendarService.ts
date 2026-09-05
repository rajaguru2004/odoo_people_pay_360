import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { CalendarEvent, CalendarStats } from '@/types/calendar';

class CalendarService {
  /**
   * One person's month. `employeeId` is honoured for ADMIN, HR and managers
   * only; everybody else gets their own whatever they pass.
   */
  myCalendar(
    startDate: string,
    endDate: string,
    employeeId?: string,
  ): Promise<ApiResponse<CalendarEvent[]>> {
    return axiosInstance.get('/calendar/my-calendar', {
      params: { startDate, endDate, employeeId },
    });
  }

  stats(
    month: number,
    year: number,
    employeeId?: string,
  ): Promise<ApiResponse<CalendarStats>> {
    return axiosInstance.get('/calendar/stats', {
      params: { month, year, employeeId },
    });
  }
}

export default new CalendarService();
