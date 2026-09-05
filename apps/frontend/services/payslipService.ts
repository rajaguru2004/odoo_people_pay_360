import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  MyPayslipListQuery,
  Payslip,
  PayslipListQuery,
} from '@/types/payslip';

class PayslipService {
  /**
   * Self-service.
   *
   * `/payslips/my` is declared before `/payslips/:id` server-side, and the
   * service — not a decorator — narrows it to the caller and to APPROVED / PAID
   * runs. A decorator cannot see whose record it is, and a figure still being
   * calculated is not a payslip.
   */
  listMine(query: MyPayslipListQuery = {}): Promise<ApiResponse<Payslip[]>> {
    return axiosInstance.get('/payslips/my', { params: query });
  }

  getMine(id: string): Promise<ApiResponse<Payslip>> {
    return axiosInstance.get(`/payslips/my/${id}`);
  }

  list(query: PayslipListQuery = {}): Promise<ApiResponse<Payslip[]>> {
    return axiosInstance.get('/payslips', { params: query });
  }

  get(id: string): Promise<ApiResponse<Payslip>> {
    return axiosInstance.get(`/payslips/${id}`);
  }

  listByEmployee(
    employeeId: string,
    query: MyPayslipListQuery = {},
  ): Promise<ApiResponse<Payslip[]>> {
    return axiosInstance.get('/payslips', {
      params: { ...query, employeeId },
    });
  }
}

export default new PayslipService();
