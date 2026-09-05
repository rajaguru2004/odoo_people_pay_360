import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { Team, CreateTeamData, UpdateTeamData, AddTeamMemberData, EmployeeTeam } from '@/types/team';

class TeamService {
  async getAll(departmentId?: string): Promise<ApiResponse<Team[]>> {
    const params = departmentId ? { departmentId } : {};
    return axiosInstance.get('/teams', { params });
  }

  async getById(id: string): Promise<ApiResponse<Team>> {
    return axiosInstance.get(`/teams/${id}`);
  }

  async create(data: CreateTeamData): Promise<ApiResponse<Team>> {
    return axiosInstance.post('/teams', data);
  }

  async update(id: string, data: UpdateTeamData): Promise<ApiResponse<Team>> {
    return axiosInstance.patch(`/teams/${id}`, data);
  }

  async delete(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/teams/${id}`);
  }

  async addMember(teamId: string, data: AddTeamMemberData): Promise<ApiResponse<void>> {
    return axiosInstance.post(`/teams/${teamId}/members`, data);
  }

  async removeMember(teamId: string, memberId: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/teams/${teamId}/members/${memberId}`);
  }

  async getEmployeeTeams(employeeId: string): Promise<ApiResponse<EmployeeTeam[]>> {
    return axiosInstance.get(`/teams/employee/${employeeId}`);
  }
}

export default new TeamService();
