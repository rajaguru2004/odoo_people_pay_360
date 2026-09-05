import axiosInstance from '@/lib/axios';

export interface WorkLog {
  id: string;
  taskId: string;
  employeeId: string;
  startTime: string;
  endTime?: string;
  duration?: number;
  notes?: string;
  timerActive: boolean;
  timerPausedAt?: string;
  timerPausedSecs: number;
  statusId?: string;
  statusName?: string;
  task?: { id: string; taskCode: string; title: string };
  employee?: { id: string; fullName: string; avatarUrl?: string };
  status?: { id: string; name: string; color: string };
}

class WorkLogService {
  async getMine() {
    return axiosInstance.get('/work-logs/my');
  }

  async getByTask(taskId: string) {
    return axiosInstance.get(`/work-logs/task/${taskId}`);
  }

  async getTimerStatus() {
    return axiosInstance.get('/work-logs/timer/status');
  }

  async create(data: { taskId: string; startTime: string; endTime: string; notes?: string }) {
    return axiosInstance.post('/work-logs', data);
  }

  async update(id: string, data: { startTime?: string; endTime?: string; notes?: string }) {
    return axiosInstance.patch(`/work-logs/${id}`, data);
  }

  async delete(id: string) {
    return axiosInstance.delete(`/work-logs/${id}`);
  }

  async startTimer(taskId: string, notes?: string) {
    return axiosInstance.post('/work-logs/timer/start', { taskId, notes });
  }

  async pauseTimer() {
    return axiosInstance.post('/work-logs/timer/pause');
  }

  async resumeTimer() {
    return axiosInstance.post('/work-logs/timer/resume');
  }

  async stopTimer(notes?: string) {
    return axiosInstance.post('/work-logs/timer/stop', { notes });
  }
}

export default new WorkLogService();
