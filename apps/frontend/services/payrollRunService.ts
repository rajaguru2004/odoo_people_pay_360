import type { AxiosResponse } from 'axios';
import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  CreatePayrollRunPayload,
  PayrollRun,
  PayrollRunListQuery,
  PreflightPayload,
  PreflightResult,
  RejectPayrollRunPayload,
} from '@/types/payroll';
import type { PayrollRunDetail } from '@/types/payslip';
import type { PayrollHubSummary, TrendMonths } from '@/types/payrollHub';

class PayrollRunService {
  list(query: PayrollRunListQuery = {}): Promise<ApiResponse<PayrollRun[]>> {
    return axiosInstance.get('/payroll-runs', { params: query });
  }

  /**
   * What a run WOULD do. Writes nothing.
   *
   * Declared before `:id` server-side, so `preflight` is never parsed as a uuid.
   * The period screen asks this first: an objection is far cheaper to read here
   * than after a row exists that then has to be cancelled.
   */
  preflight(payload: PreflightPayload): Promise<ApiResponse<PreflightResult>> {
    return axiosInstance.post('/payroll-runs/preflight', payload);
  }

  get(id: string): Promise<ApiResponse<PayrollRunDetail>> {
    return axiosInstance.get(`/payroll-runs/${id}`);
  }

  create(payload: CreatePayrollRunPayload): Promise<ApiResponse<PayrollRun>> {
    return axiosInstance.post('/payroll-runs', payload);
  }

  /**
   * Build the payslips.
   *
   * One transaction: prior payslips are deleted and rebuilt, so calculating
   * twice is a replacement rather than a doubling.
   */
  calculate(id: string): Promise<ApiResponse<PayrollRun>> {
    return axiosInstance.post(`/payroll-runs/${id}/calculate`);
  }

  approve(id: string): Promise<ApiResponse<PayrollRun>> {
    return axiosInstance.post(`/payroll-runs/${id}/approve`);
  }

  /** Back to DRAFT, with the reason kept on the run for the next attempt. */
  reject(
    id: string,
    payload: RejectPayrollRunPayload,
  ): Promise<ApiResponse<PayrollRun>> {
    return axiosInstance.post(`/payroll-runs/${id}/reject`, payload);
  }

  markPaid(id: string): Promise<ApiResponse<PayrollRun>> {
    return axiosInstance.post(`/payroll-runs/${id}/mark-paid`);
  }

  cancel(id: string): Promise<ApiResponse<PayrollRun>> {
    return axiosInstance.post(`/payroll-runs/${id}/cancel`);
  }

  /** Only ever a run nobody has been paid from. */
  remove(id: string): Promise<ApiResponse<{ id: string }>> {
    return axiosInstance.delete(`/payroll-runs/${id}`);
  }

  /**
   * The run as an `.xlsx`.
   *
   * `responseType: 'blob'` is the ONE case the response interceptor in
   * `lib/axios.ts` hands back untouched — there is no `{ success, data }`
   * envelope on it. So this resolves to the raw axios response: the file is
   * `res.data`, and the server's filename is in
   * `res.headers['content-disposition']`.
   */
  exportXlsx(id: string): Promise<AxiosResponse<Blob>> {
    return axiosInstance.get<Blob, AxiosResponse<Blob>>(
      `/payroll-runs/${id}/export`,
      { responseType: 'blob' },
    );
  }

  /**
   * The Payroll hub's one aggregate.
   *
   * `months` is offered as 6 or 12 and nothing else; the server answers 400 to
   * any other window rather than quietly reporting on a period nobody asked
   * about.
   */
  hubSummary(months: TrendMonths = 6): Promise<ApiResponse<PayrollHubSummary>> {
    return axiosInstance.get('/payroll/hub-summary', { params: { months } });
  }
}

export default new PayrollRunService();
