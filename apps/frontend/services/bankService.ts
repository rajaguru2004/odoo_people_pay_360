import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export interface Bank {
  id: string;
  country: string;
  name: string;
  bankCode: string | null;
  swift: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBankData {
  country: string;
  name: string;
  bankCode?: string;
  swift?: string;
}

export interface UpdateBankData {
  name?: string;
  bankCode?: string;
  swift?: string;
  isActive?: boolean;
}

class BankService {
  /** List banks, optionally filtered by ISO-2 country and/or active-only. */
  async getAll(country?: string, activeOnly = false): Promise<ApiResponse<Bank[]>> {
    const params = new URLSearchParams();
    if (country) params.set('country', country);
    if (activeOnly) params.set('activeOnly', 'true');
    const qs = params.toString();
    return axiosInstance.get(`/banks${qs ? `?${qs}` : ''}`);
  }

  async create(data: CreateBankData): Promise<ApiResponse<Bank>> {
    return axiosInstance.post('/banks', data);
  }

  async update(id: string, data: UpdateBankData): Promise<ApiResponse<Bank>> {
    return axiosInstance.patch(`/banks/${id}`, data);
  }

  async deactivate(id: string): Promise<ApiResponse<Bank>> {
    return axiosInstance.patch(`/banks/${id}/deactivate`, {});
  }

  /** Branches with their allowed banking countries. */
  async branchCountries(): Promise<ApiResponse<BranchCountries[]>> {
    return axiosInstance.get('/banks/branch-countries');
  }

  /** Set the allowed banking countries (ISO-2) for a branch. */
  async setBranchCountries(
    branchId: string,
    countries: string[],
  ): Promise<ApiResponse<{ id: string; name: string; bankingCountries: string[] }>> {
    return axiosInstance.put(`/banks/branch-countries/${branchId}`, { countries });
  }
}

export interface BranchCountries {
  id: string;
  name: string;
  code: string;
  country: string | null;
  bankingCountries: string[];
  allowedCountries: string[];
}

export default new BankService();
