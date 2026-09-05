import axiosInstance from '@/lib/axios';
import {
  EmiDueRow,
  LoanReportMeta,
  OutstandingRow,
  OverdueRow,
} from '@/types/advanceLoan';

interface Envelope<T> {
  success: boolean;
  data: T;
  totals?: Record<string, number>;
  buckets?: Record<string, { count: number; amount: number }>;
  meta: LoanReportMeta;
}

/**
 * Loan book reporting.
 *
 * Every response carries `meta.openPayrolls`. Surface it: a report run while a
 * payroll is open will not match that payroll's payslips, and showing which
 * runs are open is what stops that reading as a bug.
 */
class LoanReportService {
  async outstanding(params?: {
    asOf?: string;
    departmentId?: string;
    type?: string;
    /** Filter to one loan product. Matches nothing until products are in use. */
    loanTypeId?: string;
    page?: number;
    limit?: number;
  }): Promise<Envelope<OutstandingRow[]>> {
    return axiosInstance.get('/advance-loans/reports/outstanding', { params });
  }

  async portfolio(): Promise<Envelope<any[]>> {
    return axiosInstance.get('/advance-loans/reports/portfolio');
  }

  async emiDue(params?: {
    month?: number;
    year?: number;
    includeHeld?: boolean;
  }): Promise<Envelope<EmiDueRow[]>> {
    return axiosInstance.get('/advance-loans/reports/emi-due', { params });
  }

  async overdue(params?: { asOf?: string }): Promise<Envelope<OverdueRow[]>> {
    return axiosInstance.get('/advance-loans/reports/overdue', { params });
  }

  async interestEarned(params?: {
    from?: string;
    to?: string;
  }): Promise<Envelope<any[]>> {
    return axiosInstance.get('/advance-loans/reports/interest-earned', { params });
  }

  /** The caller's own statement — derived from the token, no id to pass. */
  async myStatement(): Promise<Envelope<any[]>> {
    return axiosInstance.get('/advance-loans/reports/my-statement');
  }

  async employeeStatement(employeeId: string): Promise<Envelope<any[]>> {
    return axiosInstance.get(
      `/advance-loans/reports/employee/${employeeId}/statement`,
    );
  }
}

export default new LoanReportService();
