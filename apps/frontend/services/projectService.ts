import axiosInstance from '@/lib/axios';
import type {
  CreateProjectData,
  ProjectQueryParams,
} from '@/types/project';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A role argument may be a ProjectRole id (UUID) or a legacy role slug/name.
const roleBody = (roleOrId?: string) => {
  if (!roleOrId) return {};
  return UUID_RE.test(roleOrId) ? { roleId: roleOrId } : { role: roleOrId };
};

class ProjectService {
  async getAll(params?: ProjectQueryParams) {
    return axiosInstance.get('/projects', { params });
  }

  async getStats() {
    return axiosInstance.get('/projects/stats');
  }

  async getById(id: string) {
    return axiosInstance.get(`/projects/${id}`);
  }

  async getBySlug(slug: string) {
    return axiosInstance.get(`/projects/by-slug/${slug}`);
  }

  async create(data: CreateProjectData) {
    return axiosInstance.post('/projects', data);
  }

  async update(id: string, data: Partial<CreateProjectData>) {
    return axiosInstance.patch(`/projects/${id}`, data);
  }

  async delete(id: string) {
    return axiosInstance.delete(`/projects/${id}`);
  }

  async archive(id: string) {
    return axiosInstance.post(`/projects/${id}/archive`);
  }

  async unarchive(id: string) {
    return axiosInstance.post(`/projects/${id}/unarchive`);
  }

  // Members
  async getMembers(id: string) {
    return axiosInstance.get(`/projects/${id}/members`);
  }

  async addMember(id: string, employeeIds: string[], roleOrId?: string) {
    return axiosInstance.post(`/projects/${id}/members`, {
      employeeIds,
      ...roleBody(roleOrId),
    });
  }

  async updateMemberRole(id: string, memberId: string, roleOrId: string) {
    // R70: `roleBody('')` is `{}`, and the server reads an absent role as "use
    // the project default" — so "change this member's role" silently became
    // "reset them to Member", and answered 200. An empty argument here is
    // always a caller bug, never an instruction, so refuse it rather than
    // sending a request whose meaning is the opposite of its name.
    if (!roleOrId?.trim()) {
      throw new Error("A role is required to change a member's role");
    }
    return axiosInstance.patch(`/projects/${id}/members/${memberId}`, roleBody(roleOrId));
  }

  async removeMember(id: string, memberId: string) {
    return axiosInstance.delete(`/projects/${id}/members/${memberId}`);
  }

  async getActivity(id: string, params?: { page?: number; limit?: number }) {
    return axiosInstance.get(`/projects/${id}/activity`, { params });
  }
}

const projectService = new ProjectService();
export default projectService;
