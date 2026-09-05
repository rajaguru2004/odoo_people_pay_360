import axiosInstance from '@/lib/axios';
import type { ProjectPermission } from '@/types/project';

export interface CreateProjectRolePayload {
  name: string;
  description?: string;
  color?: string;
  permissions?: ProjectPermission[];
  copyFromRoleId?: string;
}

export interface UpdateProjectRolePayload {
  name?: string;
  description?: string;
  color?: string;
  permissions?: ProjectPermission[];
}

class ProjectRoleService {
  /** Resolved permission set for the current user within a project. */
  async getMyPermissions(projectId: string) {
    return axiosInstance.get(`/projects/${projectId}/my-permissions`);
  }

  /** All assignable permissions (grouped) for the matrix UI. */
  async getCatalog() {
    return axiosInstance.get('/project-roles/catalog');
  }

  async listRoles(projectId: string) {
    return axiosInstance.get(`/projects/${projectId}/roles`);
  }

  async createRole(projectId: string, payload: CreateProjectRolePayload) {
    return axiosInstance.post(`/projects/${projectId}/roles`, payload);
  }

  async updateRole(
    projectId: string,
    roleId: string,
    payload: UpdateProjectRolePayload,
  ) {
    return axiosInstance.patch(`/projects/${projectId}/roles/${roleId}`, payload);
  }

  async deleteRole(projectId: string, roleId: string) {
    return axiosInstance.delete(`/projects/${projectId}/roles/${roleId}`);
  }
}

const projectRoleService = new ProjectRoleService();
export default projectRoleService;
