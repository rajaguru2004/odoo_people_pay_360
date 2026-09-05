import axiosInstance from '@/lib/axios';

export interface Timesheet {
  id: string;
  employeeId: string;
  taskId?: string;
  workDate: string;
  hoursWorked: number;
  description?: string;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  submittedAt?: string;
  approvedAt?: string;
  rejectionReason?: string;
  employee?: { id: string; fullName: string; employeeCode: string; department?: { name: string } };
  task?: { id: string; taskCode: string; title: string };
  approver?: { id: string; email: string; employee?: { fullName: string } };
}

export interface CreateTimesheetData {
  taskId?: string;
  workDate: string;
  hoursWorked: number;
  description?: string;
}

export interface TimesheetQueryParams {
  status?: string;
  employeeId?: string;
  taskId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

class TimesheetService {
  async getAll(params?: TimesheetQueryParams) {
    return axiosInstance.get('/timesheets', { params });
  }

  async getMine(params?: TimesheetQueryParams) {
    return axiosInstance.get('/timesheets/my', { params });
  }

  async getPending() {
    return axiosInstance.get('/timesheets/pending');
  }

  async getById(id: string) {
    return axiosInstance.get(`/timesheets/${id}`);
  }

  async getDailySummary(date?: string) {
    return axiosInstance.get('/timesheets/summary/daily', { params: { date } });
  }

  async getWeeklySummary(weekStart?: string) {
    return axiosInstance.get('/timesheets/summary/weekly', { params: { weekStart } });
  }

  async getMonthlySummary(year?: number, month?: number) {
    return axiosInstance.get('/timesheets/summary/monthly', { params: { year, month } });
  }

  async create(data: CreateTimesheetData) {
    return axiosInstance.post('/timesheets', data);
  }

  async update(id: string, data: Partial<CreateTimesheetData>) {
    return axiosInstance.patch(`/timesheets/${id}`, data);
  }

  async delete(id: string) {
    return axiosInstance.delete(`/timesheets/${id}`);
  }

  async submit(id: string) {
    return axiosInstance.post(`/timesheets/${id}/submit`);
  }

  async approve(id: string, comment?: string) {
    return axiosInstance.post(`/timesheets/${id}/approve`, { comment });
  }

  async reject(id: string, rejectionReason: string) {
    return axiosInstance.post(`/timesheets/${id}/reject`, { rejectionReason });
  }
}

export default new TimesheetService();
