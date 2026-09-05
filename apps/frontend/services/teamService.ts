import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  AddTeamMemberPayload,
  CreateTeamPayload,
  Team,
  TeamMember,
  UpdateTeamMemberPayload,
  UpdateTeamPayload,
} from '@/types/team';

class TeamService {
  list(
    params: { departmentId?: string; includeInactive?: boolean } = {},
  ): Promise<ApiResponse<Team[]>> {
    return axiosInstance.get('/teams', { params });
  }

  get(id: string): Promise<ApiResponse<Team>> {
    return axiosInstance.get(`/teams/${id}`);
  }

  create(payload: CreateTeamPayload): Promise<ApiResponse<Team>> {
    return axiosInstance.post('/teams', payload);
  }

  update(id: string, payload: UpdateTeamPayload): Promise<ApiResponse<Team>> {
    return axiosInstance.patch(`/teams/${id}`, payload);
  }

  remove(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/teams/${id}`);
  }

  /** Re-adding a past member reactivates their row rather than inserting a
   *  second one, so every roster count stays honest. */
  addMember(
    teamId: string,
    payload: AddTeamMemberPayload,
  ): Promise<ApiResponse<TeamMember>> {
    return axiosInstance.post(`/teams/${teamId}/members`, payload);
  }

  updateMember(
    teamId: string,
    memberId: string,
    payload: UpdateTeamMemberPayload,
  ): Promise<ApiResponse<TeamMember>> {
    return axiosInstance.patch(`/teams/${teamId}/members/${memberId}`, payload);
  }

  removeMember(
    teamId: string,
    memberId: string,
  ): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/teams/${teamId}/members/${memberId}`);
  }
}

export default new TeamService();
