import axiosInstance from '@/lib/axios';
import { CalendarResponse, CalendarStatsResponse, CreateScheduleDto, UpdateScheduleDto, BulkCreateScheduleDto } from '@/types/calendar';
import type { HubPeriod, SchedulesHubSummary } from '@/types/schedulesHub';
import type { ApiResponse } from '@/types/api';

class CalendarService {
    async getMyCalendar(startDate: string, endDate: string, employeeId?: string): Promise<CalendarResponse> {
        return axiosInstance.get('/calendar/my-calendar', {
            params: { startDate, endDate, employeeId },
        });
    }

    async getOverviewCalendar(startDate: string, endDate: string): Promise<any> {
        return axiosInstance.get('/calendar/overview', {
            params: { startDate, endDate },
        });
    }

    async getCalendarStats(month: number, year: number): Promise<CalendarStatsResponse> {
        return axiosInstance.get('/calendar/stats', {
            params: { month, year },
        });
    }

    async createSchedule(data: CreateScheduleDto) {
        return axiosInstance.post('/calendar/schedules', data);
    }

    async getSchedule(id: string) {
        return axiosInstance.get(`/calendar/schedules/${id}`);
    }

    async updateSchedule(id: string, data: UpdateScheduleDto) {
        return axiosInstance.put(`/calendar/schedules/${id}`, data);
    }

    async deleteSchedule(id: string) {
        return axiosInstance.delete(`/calendar/schedules/${id}`);
    }

    async bulkCreateSchedules(data: BulkCreateScheduleDto) {
        return axiosInstance.post('/calendar/schedules/bulk', data);
    }

    async checkConflicts(employeeId: string, startDate: string, endDate: string) {
        return axiosInstance.get('/calendar/schedules/conflicts/check', {
            params: { employeeId, startDate, endDate },
        });
    }

    /**
     * Everything the Schedules module hub draws, in one request.
     *
     * `anchor` is any date inside the window being viewed; omit it for the
     * current one. Page with the `prevAnchor`/`nextAnchor` the response returns
     * rather than doing calendar arithmetic here — what "the week before" means
     * depends on the branch working week, and a client that assumed Monday
     * would disagree with the numbers beside it every Sunday in Muscat.
     */
    async getHubSummary(
        period: HubPeriod,
        anchor?: string,
    ): Promise<ApiResponse<SchedulesHubSummary>> {
        return axiosInstance.get('/calendar/hub-summary', {
            params: { period, anchor },
        });
    }
}

export default new CalendarService();
