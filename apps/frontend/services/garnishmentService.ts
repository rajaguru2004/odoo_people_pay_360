import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

/**
 * Court-ordered attachments of earnings.
 *
 * The rung the recovery ladder was missing: `PayrollItem.garnishment` and the
 * allocator's `CycleContext.garnishment` both existed and payroll passed a
 * hard-coded zero, because there was nowhere to record that an order existed.
 */
export interface GarnishmentOrder {
  id: string;
  employeeId: string;
  reference: string;
  authority: string | null;
  /** Exactly one of amount / percentOfNet carries the instruction. */
  amount: string | number | null;
  percentOfNet: string | number | null;
  totalCap: string | number | null;
  collected: string | number;
  /** Lower goes first when pay cannot cover every order. Defaults to 100. */
  priority: number;
  startDate: string;
  endDate: string | null;
  isActive: boolean;
  notes: string | null;
  employee?: { id: string; employeeCode: string; fullName: string };
}

export interface GarnishmentInput {
  employeeId?: string;
  reference?: string;
  authority?: string | null;
  amount?: number | null;
  percentOfNet?: number | null;
  totalCap?: number | null;
  priority?: number;
  startDate?: string;
  endDate?: string | null;
  isActive?: boolean;
  notes?: string | null;
}

class GarnishmentService {
  async getAll(params?: {
    employeeId?: string;
    activeOnly?: boolean;
  }): Promise<ApiResponse<GarnishmentOrder[]>> {
    return axiosInstance.get('/garnishments', {
      params: params?.activeOnly
        ? { ...params, activeOnly: 'true' }
        : { employeeId: params?.employeeId },
    });
  }

  async create(data: GarnishmentInput): Promise<ApiResponse<GarnishmentOrder>> {
    return axiosInstance.post('/garnishments', data);
  }

  async update(
    id: string,
    data: GarnishmentInput,
  ): Promise<ApiResponse<GarnishmentOrder>> {
    return axiosInstance.patch(`/garnishments/${id}`, data);
  }

  async remove(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return axiosInstance.delete(`/garnishments/${id}`);
  }
}

export default new GarnishmentService();
