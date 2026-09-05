import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export type RewardType = 'BONUS' | 'CERTIFICATE' | 'PROMOTION' | 'OTHER';

export interface Reward {
  id: string;
  employeeId: string;
  reason: string;
  amount: number;
  rewardDate: string;
  rewardType: RewardType;
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

export interface CreateRewardData {
  employeeId: string;
  reason: string;
  amount: number;
  rewardDate: string;
  rewardType?: RewardType;
}

class RewardService {
  async getAll(params?: { employeeId?: string; page?: number; limit?: number }): Promise<ApiResponse<Reward[]>> {
    return axiosInstance.get('/rewards', { params });
  }

  async getByEmployee(employeeId: string): Promise<ApiResponse<Reward[]>> {
    return axiosInstance.get(`/rewards/employee/${employeeId}`);
  }

  async create(data: CreateRewardData): Promise<ApiResponse<Reward>> {
    return axiosInstance.post('/rewards', data);
  }

  async delete(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/rewards/${id}`);
  }
}

export default new RewardService();
