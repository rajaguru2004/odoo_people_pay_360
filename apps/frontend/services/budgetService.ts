import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  Budget,
  BudgetLine,
  BudgetStatus,
  CreateBudgetData,
  UpsertBudgetLineData,
  VarianceReport,
} from '@/types/budget';

class BudgetService {
  async getAll(params: { fiscalYear?: number; status?: string } = {}): Promise<
    ApiResponse<Budget[]>
  > {
    return axiosInstance.get('/budgets', { params });
  }

  async getById(id: string): Promise<ApiResponse<Budget>> {
    return axiosInstance.get(`/budgets/${id}`);
  }

  async create(data: CreateBudgetData): Promise<ApiResponse<Budget>> {
    return axiosInstance.post('/budgets', data);
  }

  /** Only an ACTIVE budget attracts commitments from approved requests. */
  async setStatus(id: string, status: BudgetStatus): Promise<ApiResponse<Budget>> {
    return axiosInstance.patch(`/budgets/${id}/status`, { status });
  }

  async upsertLine(
    budgetId: string,
    data: UpsertBudgetLineData,
  ): Promise<ApiResponse<BudgetLine>> {
    return axiosInstance.post(`/budgets/${budgetId}/lines`, data);
  }

  async removeLine(budgetId: string, lineId: string): Promise<ApiResponse<null>> {
    return axiosInstance.delete(`/budgets/${budgetId}/lines/${lineId}`);
  }

  /** Planned vs Committed vs Actual vs Remaining. */
  async variance(id: string): Promise<ApiResponse<VarianceReport>> {
    return axiosInstance.get(`/budgets/${id}/variance`);
  }
}

export default new BudgetService();
