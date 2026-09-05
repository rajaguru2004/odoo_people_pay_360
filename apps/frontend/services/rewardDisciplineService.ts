import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export interface Reward {
    id: string;
    employeeId: string;
    reason: string;
    amount: number;
    rewardDate: string;
    rewardType: 'PERFORMANCE' | 'PROJECT' | 'ATTENDANCE' | 'OTHER';
    createdBy: string;
    createdAt: string;
    employee?: {
        id: string;
        employeeCode: string;
        fullName: string;
    };
    creator?: {
        id: string;
        email: string;
    };
}

export interface Discipline {
    id: string;
    employeeId: string;
    reason: string;
    disciplineType: 'WARNING' | 'FINE' | 'SUSPENSION' | 'OTHER';
    amount: number;
    disciplineDate: string;
    createdBy: string;
    createdAt: string;
    employee?: {
        id: string;
        employeeCode: string;
        fullName: string;
    };
    creator?: {
        id: string;
        email: string;
    };
}

export interface CreateRewardData {
    employeeId: string;
    reason: string;
    amount: number;
    rewardDate: string;
    rewardType: 'PERFORMANCE' | 'PROJECT' | 'ATTENDANCE' | 'OTHER';
}

export interface CreateDisciplineData {
    employeeId: string;
    reason: string;
    disciplineType: 'WARNING' | 'FINE' | 'SUSPENSION' | 'OTHER';
    amount: number;
    disciplineDate: string;
}

class RewardDisciplineService {
    // Rewards
    async getAllRewards(params?: {
        employeeId?: string;
        page?: number;
        limit?: number;
    }): Promise<ApiResponse<Reward[]>> {
        return axiosInstance.get('/rewards', { params });
    }

    async getRewardsByEmployee(employeeId: string): Promise<ApiResponse<Reward[]>> {
        return axiosInstance.get(`/rewards/employee/${employeeId}`);
    }

    async createReward(data: CreateRewardData): Promise<ApiResponse<Reward>> {
        return axiosInstance.post('/rewards', data);
    }

    async deleteReward(id: string): Promise<ApiResponse<void>> {
        return axiosInstance.delete(`/rewards/${id}`);
    }

    // Disciplines
    async getAllDisciplines(params?: {
        employeeId?: string;
        page?: number;
        limit?: number;
    }): Promise<ApiResponse<Discipline[]>> {
        return axiosInstance.get('/disciplines', { params });
    }

    async getDisciplinesByEmployee(employeeId: string): Promise<ApiResponse<Discipline[]>> {
        return axiosInstance.get(`/disciplines/employee/${employeeId}`);
    }

    async createDiscipline(data: CreateDisciplineData): Promise<ApiResponse<Discipline>> {
        return axiosInstance.post('/disciplines', data);
    }

    async deleteDiscipline(id: string): Promise<ApiResponse<void>> {
        return axiosInstance.delete(`/disciplines/${id}`);
    }
}

export default new RewardDisciplineService();
