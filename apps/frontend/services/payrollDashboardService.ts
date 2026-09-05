import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  PayrollDashboardQuery,
  PayrollDashboardSummary,
} from '@/types/payrollDashboard';

/**
 * The analytics page's one endpoint.
 *
 * Deliberately one method. Every visual on the page reads the same response, so
 * a filter change is one request and every chart moves together — a page that
 * fetched per panel would show the reader six charts mid-way through agreeing
 * with each other.
 */
class PayrollDashboardService {
  summary(
    query: PayrollDashboardQuery = {},
  ): Promise<ApiResponse<PayrollDashboardSummary>> {
    return axiosInstance.get('/payroll/dashboard', { params: query });
  }
}

const payrollDashboardService = new PayrollDashboardService();
export default payrollDashboardService;
