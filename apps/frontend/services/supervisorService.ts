import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export interface SupervisorInfo {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string;
  position: string;
}

export interface SupervisedEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string;
  position: string;
  department?: { id: string; name: string } | null;
}

class SupervisorService {
  /** Assign or reassign an employee to a supervisor (ADMIN/HR). */
  async assign(
    employeeId: string,
    supervisorId: string,
  ): Promise<ApiResponse<any>> {
    return axiosInstance.post('/supervisors/assign', {
      employeeId,
      supervisorId,
    });
  }

  /** Assign many employees to one supervisor (ADMIN/HR). */
  async bulkAssign(
    employeeIds: string[],
    supervisorId: string,
  ): Promise<ApiResponse<any>> {
    return axiosInstance.post('/supervisors/bulk-assign', {
      employeeIds,
      supervisorId,
    });
  }

  /** Detach an employee from its supervisor (ADMIN/HR). */
  async remove(employeeId: string): Promise<ApiResponse<any>> {
    return axiosInstance.delete(`/supervisors/assignment/${employeeId}`);
  }

  /** Get an employee's assigned supervisor. */
  async getOf(employeeId: string): Promise<ApiResponse<SupervisorInfo | null>> {
    return axiosInstance.get(`/supervisors/of/${employeeId}`);
  }

  /** List the employees supervised by a supervisor. */
  async getReports(
    supervisorId: string,
  ): Promise<ApiResponse<SupervisedEmployee[]>> {
    return axiosInstance.get(`/supervisors/reports/${supervisorId}`);
  }

  /** Employees the current user supervises (any role). */
  async getMyTeam(): Promise<ApiResponse<SupervisedEmployee[]>> {
    return axiosInstance.get('/supervisors/my-team');
  }

  // ── Supervisor teams (ADMIN/HR) ──────────────────────────────────────
  async listTeams(): Promise<ApiResponse<SupervisorTeam[]>> {
    return axiosInstance.get('/supervisors/teams');
  }

  async createTeam(dto: {
    name: string;
    supervisorId: string;
    memberIds?: string[];
    description?: string;
  }): Promise<ApiResponse<SupervisorTeam>> {
    return axiosInstance.post('/supervisors/teams', dto);
  }

  async updateTeam(
    id: string,
    dto: {
      name?: string;
      supervisorId?: string;
      memberIds?: string[];
      description?: string;
    },
  ): Promise<ApiResponse<SupervisorTeam>> {
    return axiosInstance.patch(`/supervisors/teams/${id}`, dto);
  }

  async deleteTeam(id: string): Promise<ApiResponse<any>> {
    return axiosInstance.delete(`/supervisors/teams/${id}`);
  }
}

export interface SupervisorTeamMember {
  id: string;
  employeeId: string;
  employee: {
    id: string;
    fullName: string;
    employeeCode: string;
    position: string;
    department?: { id: string; name: string } | null;
  };
}

export interface SupervisorTeam {
  id: string;
  name: string;
  description: string | null;
  teamLeadId: string | null;
  teamLead: {
    id: string;
    fullName: string;
    employeeCode: string;
    position: string;
  } | null;
  members: SupervisorTeamMember[];
}

export default new SupervisorService();
