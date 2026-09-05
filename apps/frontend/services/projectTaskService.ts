import axiosInstance from '@/lib/axios';
import type { StatusCategory, ProjectMemberRole } from '@/types/project';

export interface CreateProjectTaskData {
  title: string;
  description?: string;
  projectId: string;
  statusId?: string;
  type?: string;
  priority?: string;
  assigneeIds?: string[];
  reporterId?: string;
  dueDate?: string;
  startDate?: string;
  storyPoints?: number;
  sprintId?: string;
  parentTaskId?: string;
  labelIds?: string[];
  locationName?: string;
  latitude?: number;
  longitude?: number;
}

class ProjectTaskService {
  // ─── Tasks ─────────────────────────────────────────────────────────────────
  async list(projectId: string, params?: Record<string, any>) {
    return axiosInstance.get('/tasks', { params: { projectId, limit: 200, ...params } });
  }

  async kanban(projectId: string, params?: Record<string, any>) {
    return axiosInstance.get('/tasks/kanban', { params: { projectId, ...params } });
  }

  async create(data: CreateProjectTaskData) {
    return axiosInstance.post('/tasks', data);
  }

  async update(id: string, data: Partial<CreateProjectTaskData> & { status?: string }) {
    return axiosInstance.patch(`/tasks/${id}`, data);
  }

  async moveStatus(id: string, statusId: string) {
    return axiosInstance.post(`/tasks/${id}/move-status`, { statusId });
  }

  async get(id: string) {
    return axiosInstance.get(`/tasks/${id}`);
  }

  async remove(id: string) {
    return axiosInstance.delete(`/tasks/${id}`);
  }

  // ─── Subtasks ─────────────────────────────────────────────────────────────
  async getSubtasks(taskId: string) {
    return axiosInstance.get(`/tasks/${taskId}/subtasks`);
  }

  async createSubtask(taskId: string, data: { title: string; assigneeIds?: string[] }) {
    return axiosInstance.post(`/tasks/${taskId}/subtasks`, data);
  }

  // ─── Dependencies ─────────────────────────────────────────────────────────
  async getDependencies(taskId: string) {
    return axiosInstance.get(`/tasks/${taskId}/dependencies`);
  }

  async addDependency(taskId: string, blockingTaskId: string, type = 'BLOCKS') {
    return axiosInstance.post(`/tasks/${taskId}/dependencies`, { blockingTaskId, type });
  }

  async removeDependency(depId: string) {
    return axiosInstance.delete(`/tasks/dependencies/${depId}`);
  }

  // ─── Analytics ────────────────────────────────────────────────────────────
  async charts(slug: string) {
    return axiosInstance.get(`/projects/${slug}/charts`);
  }

  // ─── Workflow statuses (kanban columns) ──────────────────────────────────────
  async getStatuses(projectId: string) {
    return axiosInstance.get('/project-statuses', { params: { projectId } });
  }

  async createStatus(data: { projectId: string; name: string; color?: string; category?: StatusCategory }) {
    return axiosInstance.post('/project-statuses', data);
  }

  async updateStatus(id: string, data: { name?: string; color?: string; category?: StatusCategory }) {
    return axiosInstance.patch(`/project-statuses/${id}`, data);
  }

  async reorderStatuses(items: { id: string; position: number }[]) {
    return axiosInstance.patch('/project-statuses/reorder', { items });
  }

  async deleteStatus(id: string) {
    return axiosInstance.delete(`/project-statuses/${id}`);
  }

  // ─── Labels ───────────────────────────────────────────────────────────────
  async getLabels(projectId: string) {
    return axiosInstance.get('/labels', { params: { projectId } });
  }

  async createLabel(data: { projectId: string; name: string; color?: string }) {
    return axiosInstance.post('/labels', data);
  }

  async updateLabel(id: string, data: { name?: string; color?: string }) {
    return axiosInstance.patch(`/labels/${id}`, data);
  }

  async deleteLabel(id: string) {
    return axiosInstance.delete(`/labels/${id}`);
  }
}

export default new ProjectTaskService();
