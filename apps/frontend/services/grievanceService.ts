import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreateGrievanceData,
  Grievance,
  GrievanceEvent,
  GrievanceStats,
} from '@/types/grievance';

class GrievanceService {
  /** Nobody ever receives a grievance raised against themselves. */
  list(status?: string): Promise<ApiResponse<Grievance[]>> {
    return axiosInstance.get('/grievances', { params: status ? { status } : {} });
  }

  get(id: string): Promise<ApiResponse<Grievance>> {
    return axiosInstance.get(`/grievances/${id}`);
  }

  stats(): Promise<ApiResponse<GrievanceStats>> {
    return axiosInstance.get('/grievances/stats');
  }

  create(payload: CreateGrievanceData): Promise<ApiResponse<Grievance>> {
    return axiosInstance.post('/grievances', payload);
  }

  update(
    id: string,
    payload: {
      status?: string;
      assignedToId?: string;
      resolution?: string;
      note?: string;
    },
  ): Promise<ApiResponse<Grievance>> {
    return axiosInstance.patch(`/grievances/${id}`, payload);
  }

  addNote(
    id: string,
    note: string,
    isInternal = false,
  ): Promise<ApiResponse<GrievanceEvent>> {
    return axiosInstance.post(`/grievances/${id}/notes`, { note, isInternal });
  }

  withdraw(id: string): Promise<ApiResponse<Grievance>> {
    return axiosInstance.post(`/grievances/${id}/withdraw`, {});
  }
}

export default new GrievanceService();
