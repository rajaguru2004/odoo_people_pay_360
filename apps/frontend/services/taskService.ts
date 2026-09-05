import axiosInstance from '@/lib/axios';

export interface Task {
  id: string;
  taskCode: string;
  title: string;
  description?: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'COMPLETED' | 'CANCELLED' | 'BLOCKED';
  assigneeId?: string;
  reporterId?: string;
  dueDate?: string;
  startDate?: string;
  completedDate?: string;
  estimatedHours?: number;
  actualHours: number;
  tags: string[];
  isArchived: boolean;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  assignee?: { id: string; fullName: string; employeeCode: string; email: string; avatarUrl?: string };
  assignees?: { id: string; fullName: string; employeeCode: string; email: string; avatarUrl?: string }[];
  reporter?: { id: string; fullName: string; employeeCode: string; email: string };
  _count?: { comments: number; attachments: number; workLogs: number };
}

export interface CreateTaskData {
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  assigneeId?: string;
  assigneeIds?: string[];
  reporterId?: string;
  dueDate?: string;
  startDate?: string;
  estimatedHours?: number;
  tags?: string[];
  isPrivate?: boolean;
}

export interface TaskQueryParams {
  status?: string;
  priority?: string;
  assigneeId?: string;
  search?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  isArchived?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

class TaskService {
  async getAll(params?: TaskQueryParams) {
    return axiosInstance.get('/tasks', { params });
  }

  async getMyTasks(params?: { status?: string; priority?: string }) {
    return axiosInstance.get('/tasks/my-tasks', { params });
  }

  async getById(id: string) {
    return axiosInstance.get(`/tasks/${id}`);
  }

  async getStats() {
    return axiosInstance.get('/tasks/stats');
  }

  async create(data: CreateTaskData) {
    return axiosInstance.post('/tasks', data);
  }

  async update(id: string, data: Partial<CreateTaskData> & { status?: string; completedDate?: string }) {
    return axiosInstance.patch(`/tasks/${id}`, data);
  }

  async delete(id: string) {
    return axiosInstance.delete(`/tasks/${id}`);
  }

  async archive(id: string) {
    return axiosInstance.post(`/tasks/${id}/archive`);
  }

  async assign(id: string, assigneeId: string) {
    return axiosInstance.post(`/tasks/${id}/assign`, { assigneeId });
  }

  async changeStatus(id: string, status: string) {
    return axiosInstance.post(`/tasks/${id}/status`, { status });
  }

  async bulkAssign(taskIds: string[], assigneeId: string) {
    return axiosInstance.post('/tasks/bulk-assign', { taskIds, assigneeId });
  }

  // Comments
  async getComments(taskId: string) {
    return axiosInstance.get(`/task-comments/task/${taskId}`);
  }

  async addComment(taskId: string, comment: string) {
    return axiosInstance.post('/task-comments', { taskId, comment });
  }

  async updateComment(id: string, comment: string) {
    return axiosInstance.patch(`/task-comments/${id}`, { comment });
  }

  async deleteComment(id: string) {
    return axiosInstance.delete(`/task-comments/${id}`);
  }

  // Attachments
  async getAttachments(taskId: string) {
    return axiosInstance.get(`/task-attachments/task/${taskId}`);
  }

  async uploadAttachment(taskId: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    return axiosInstance.post(`/task-attachments/upload/${taskId}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  }

  async deleteAttachment(id: string) {
    return axiosInstance.delete(`/task-attachments/${id}`);
  }

  // Dashboard
  async getEmployeeDashboard() {
    return axiosInstance.get('/task-dashboard/employee');
  }

  async getManagerDashboard() {
    return axiosInstance.get('/task-dashboard/manager');
  }
}

export default new TaskService();
