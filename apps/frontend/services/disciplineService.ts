import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export type DisciplineType = 'WARNING' | 'FINE' | 'DEMOTION' | 'TERMINATION';

export interface Discipline {
  id: string;
  employeeId: string;
  reason: string;
  amount: number;
  disciplineDate: string;
  disciplineType: DisciplineType;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  employee: {
    id: string;
    employeeCode: string;
    fullName: string;
    department?: { name: string };
  };
}

export interface CreateDisciplineData {
  employeeId: string;
  reason: string;
  amount: number;
  disciplineDate: string;
  disciplineType: DisciplineType;
}

class DisciplineService {
  async getAll(params?: { employeeId?: string; page?: number; limit?: number }): Promise<ApiResponse<Discipline[]>> {
    return axiosInstance.get('/disciplines', { params });
  }

  async getByEmployee(employeeId: string): Promise<ApiResponse<Discipline[]>> {
    return axiosInstance.get(`/disciplines/employee/${employeeId}`);
  }

  async create(data: CreateDisciplineData): Promise<ApiResponse<Discipline>> {
    return axiosInstance.post('/disciplines', data);
  }

  async delete(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/disciplines/${id}`);
  }
}

export default new DisciplineService();
