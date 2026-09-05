import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { Contract, CreateContractData, UpdateContractData, ExpiringContract } from '@/types/contract';

interface QueryContractParams {
  employeeId?: string;
  contractType?: string;
  status?: string;
  page?: number;
  limit?: number;
}

class ContractService {
  async getAll(params?: QueryContractParams): Promise<ApiResponse<Contract[]>> {
    return axiosInstance.get('/contracts', { params });
  }

  async getById(id: string): Promise<ApiResponse<Contract>> {
    return axiosInstance.get(`/contracts/${id}`);
  }

  async getByEmployee(employeeId: string): Promise<ApiResponse<Contract[]>> {
    return axiosInstance.get(`/contracts/employee/${employeeId}`);
  }

  async getExpiring(days: number = 30): Promise<ApiResponse<ExpiringContract[]>> {
    return axiosInstance.get('/contracts/expiring', { params: { days } });
  }

  async getStatistics(): Promise<ApiResponse<{ total: number; active: number; expired: number; expiringSoon: number }>> {
    return axiosInstance.get('/contracts/statistics');
  }

  async create(data: CreateContractData): Promise<ApiResponse<Contract>> {
    return axiosInstance.post('/contracts', data);
  }

  async update(id: string, data: UpdateContractData): Promise<ApiResponse<Contract>> {
    return axiosInstance.patch(`/contracts/${id}`, data);
  }

  async delete(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/contracts/${id}`);
  }
}

export default new ContractService();
