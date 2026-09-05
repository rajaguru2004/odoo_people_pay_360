import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  PayrollCostGroupBy,
  PayrollCostReport,
  PayrollRegisterReport,
  StatutoryReport,
  YtdReport,
} from '@/types/payroll';

/**
 * `/payroll/reports/*`.
 *
 * Every route reads APPROVED and PAID runs only. A figure in a draft has not
 * been paid to anybody, and a report that mixed the two would be reporting on
 * an intention rather than on a payroll.
 */
class PayrollReportService {
  /** Every payslip in the run, with its lines. */
  register(runId: string): Promise<ApiResponse<PayrollRegisterReport>> {
    return axiosInstance.get('/payroll/reports/register', {
      params: { runId },
    });
  }

  /** The run's cost broken down by department or by branch. */
  cost(
    runId: string,
    groupBy: PayrollCostGroupBy = 'department',
  ): Promise<ApiResponse<PayrollCostReport>> {
    return axiosInstance.get('/payroll/reports/cost', {
      params: { runId, groupBy },
    });
  }

  /** Deduction and employer-contribution totals, by component. */
  statutory(runId: string): Promise<ApiResponse<StatutoryReport>> {
    return axiosInstance.get('/payroll/reports/statutory', {
      params: { runId },
    });
  }

  /** One employee's year to date. */
  ytd(employeeId: string, year: number): Promise<ApiResponse<YtdReport>> {
    return axiosInstance.get(`/payroll/reports/ytd/${employeeId}`, {
      params: { year },
    });
  }
}

export default new PayrollReportService();
