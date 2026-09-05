import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type {
  Payslip,
  PayslipSummary,
  SalaryStructure,
  YtdSummary,
} from '@/types/payroll';

/**
 * The read side of payroll.
 *
 * Everything here is a question somebody asks about their own pay. There is no
 * method that creates, calculates or approves a run: the payroll engine is not
 * part of this portal's surface, and adding a write here would put a button on
 * a screen the server would refuse.
 */
class PayrollService {
  /** The caller's own payslips, newest first. */
  myPayslips(year?: number): Promise<ApiResponse<PayslipSummary[]>> {
    return axiosInstance.get('/payrolls/my-payslips/list', {
      params: year ? { year } : undefined,
    });
  }

  /** One of the caller's own payslips, with its breakdown. */
  myPayslip(id: string): Promise<ApiResponse<Payslip>> {
    return axiosInstance.get(`/payrolls/my-payslips/${id}`);
  }

  ytdSummary(year?: number): Promise<ApiResponse<YtdSummary>> {
    return axiosInstance.get('/payrolls/my-ytd-summary', {
      params: year ? { year } : undefined,
    });
  }

  /**
   * A payslip addressed by person and period.
   *
   * The employee comes from the URL rather than from the session, so the server
   * answers it only for the caller themselves or for a payroll role.
   */
  forPeriod(
    employeeId: string,
    month: number,
    year: number,
  ): Promise<ApiResponse<Payslip>> {
    return axiosInstance.get(`/payrolls/payslip/${employeeId}/${month}/${year}`);
  }

  salaryStructure(employeeId: string): Promise<ApiResponse<SalaryStructure>> {
    return axiosInstance.get(`/payrolls/salary-structure/${employeeId}`);
  }
}

export default new PayrollService();
