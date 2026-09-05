import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { CreateGrievanceData, Grievance } from '@/types/grievance';

class GrievanceService {
  /** Nobody ever receives a grievance raised against themselves. */
  async getAll(status?: string): Promise<ApiResponse<Grievance[]>> {
    return axiosInstance.get('/grievances', { params: status ? { status } : {} });
  }

  async getById(id: string): Promise<ApiResponse<Grievance>> {
    return axiosInstance.get(`/grievances/${id}`);
  }

  async create(data: CreateGrievanceData): Promise<ApiResponse<Grievance>> {
    return axiosInstance.post('/grievances', data);
  }

  async update(
    id: string,
    data: {
      status?: string;
      assignedToId?: string;
      resolution?: string;
      note?: string;
    },
  ): Promise<ApiResponse<Grievance>> {
    return axiosInstance.patch(`/grievances/${id}`, data);
  }

  async addNote(id: string, note: string, isInternal = false) {
    return axiosInstance.post(`/grievances/${id}/notes`, { note, isInternal });
  }

  async withdraw(id: string): Promise<ApiResponse<Grievance>> {
    return axiosInstance.post(`/grievances/${id}/withdraw`, {});
  }
}

export default new GrievanceService();
