import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { PayrollHubSummary, PayrollTrendMonths } from '@/types/payrollHub';

/**
 * The payroll extension APIs, in one file.
 *
 * Nine features share one module rather than nine, because they share one
 * audience — the person running payroll — and one lifecycle: every route here is
 * unavailable until its flag is on, and answers 404 rather than 403 when it is
 * not. Splitting them would mean nine files each with two methods and the same
 * import block.
 *
 * Each class is exported as a singleton, matching every other service here.
 */

// ── Shared shapes ──────────────────────────────────────────────────────────

/** The finding shape, shared with the WPS pre-flight so one component renders both. */
export interface PayrollFinding {
  code: string;
  severity: 'BLOCKING' | 'WARNING';
  scope: 'RUN' | 'EMPLOYEE';
  message: string;
  employeeId?: string;
  employeeCode?: string;
  employeeName?: string;
  field?: string;
  fix?: { label: string; href: string };
}

export interface PayrollEmployeeStatus {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  status: 'READY' | 'WARNING' | 'BLOCKED';
  findings: PayrollFinding[];
}

export interface PayrollPreflightResult {
  branchId: string | null;
  month: number;
  year: number;
  runType: string;
  ready: number;
  total: number;
  blockedEmployees: number;
  warningEmployees: number;
  canGenerate: boolean;
  runFindings: PayrollFinding[];
  byEmployee: PayrollEmployeeStatus[];
  requiresAcknowledgement: string[];
  window: {
    periodStart: string;
    periodEnd: string;
    cutOffDate: string | null;
    paymentDate: string | null;
    enforceCutOff: boolean;
    fromCalendar: boolean;
  };
}

// ── Pre-run validation ─────────────────────────────────────────────────────

class PayrollValidationService {
  /** Writes nothing. Safe to call as often as a form wants. */
  async preflight(body: {
    month: number;
    year: number;
    branchId?: string | null;
    batchId?: string | null;
    employeeIds?: string[] | null;
    runType?: string;
  }): Promise<ApiResponse<PayrollPreflightResult>> {
    return axiosInstance.post('/payrolls/preflight', body);
  }
}

// ── Gratuity / end of service ──────────────────────────────────────────────

export interface GratuityRule {
  id: string;
  country: string;
  nationalityClass: string;
  fromYears: string | number;
  toYears: string | number | null;
  daysPerYear: string | number;
  basis: string;
  monthDays: string | number;
  employerShare: string | number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  notes: string | null;
}

export interface GratuityEntitlement {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  asOf: string;
  country: string;
  nationalityClass: string | null;
  serviceYears: number;
  amount: number;
  grossEntitlement: number;
  provisioned: number;
  bands: Array<{
    fromYears: number;
    toYears: number | null;
    yearsInBand: number;
    daysPerYear: number;
    dayRate: number;
    amount: number;
  }>;
  workingLines: string[];
  refusal: string | null;
}

class GratuityService {
  async rules(country?: string): Promise<ApiResponse<GratuityRule[]>> {
    return axiosInstance.get('/gratuity/rules', { params: { country } });
  }

  async createRule(body: Record<string, unknown>): Promise<ApiResponse<GratuityRule>> {
    return axiosInstance.post('/gratuity/rules', body);
  }

  async retireRule(id: string): Promise<ApiResponse<GratuityRule>> {
    return axiosInstance.delete(`/gratuity/rules/${id}`);
  }

  async entitlement(employeeId: string, asOf?: string): Promise<ApiResponse<GratuityEntitlement>> {
    return axiosInstance.get(`/gratuity/employee/${employeeId}/entitlement`, {
      params: { asOf },
    });
  }

  /** No id parameter, so this route cannot be pointed at anyone else. */
  async myEntitlement(asOf?: string): Promise<ApiResponse<GratuityEntitlement>> {
    return axiosInstance.get('/gratuity/my-entitlement', { params: { asOf } });
  }

  async liability(branchId?: string): Promise<
    ApiResponse<Array<{ branchId: string; provisioned: number; accrualCount: number }>>
  > {
    return axiosInstance.get('/gratuity/liability', { params: { branchId } });
  }

  async accruals(employeeId: string): Promise<ApiResponse<any[]>> {
    return axiosInstance.get(`/gratuity/employee/${employeeId}/accruals`);
  }
}

// ── Final settlement ───────────────────────────────────────────────────────

export interface SettlementLine {
  id: string;
  category: 'EARNING' | 'DEDUCTION';
  code: string;
  label: string;
  computedAmount: string | number;
  adjustedAmount: string | number | null;
  adjustmentReason: string | null;
  displayOrder: number;
}

/**
 * One line of the stored working. The settlement composer writes plain
 * sentences; other producers (and older rows) hold a structured entry instead.
 */
export type SettlementWorkingEntry =
  | string
  | { code?: string; label?: string; amount?: string | number };

export interface FinalSettlement {
  id: string;
  employeeId: string;
  variant: string;
  lastWorkingDate: string;
  status: 'DRAFT' | 'APPROVED' | 'PAID' | 'CANCELLED';
  totalEarnings: string | number;
  totalDeductions: string | number;
  netPayable: string | number;
  /**
   * Free-form working, stored as at preparation. The composer writes strings,
   * but this is a JSON column written by more than one producer, so a row can
   * legitimately hold structured entries — the screen must not assume strings.
   */
  workingJson: { lines?: SettlementWorkingEntry[]; gratuity?: SettlementWorkingEntry[] } | null;
  lines: SettlementLine[];
  employee?: { fullName: string; employeeCode: string; position?: string; startDate?: string };
}

class FinalSettlementService {
  async list(params?: { branchId?: string; status?: string }): Promise<ApiResponse<FinalSettlement[]>> {
    return axiosInstance.get('/final-settlements', { params });
  }

  async getById(id: string): Promise<ApiResponse<FinalSettlement>> {
    return axiosInstance.get(`/final-settlements/${id}`);
  }

  async create(body: Record<string, unknown>): Promise<ApiResponse<FinalSettlement>> {
    return axiosInstance.post('/final-settlements', body);
  }

  /** The reason is required by the server AND by a database CHECK. */
  async adjustLine(
    id: string,
    lineId: string,
    body: { amount: number; reason: string },
  ): Promise<ApiResponse<FinalSettlement>> {
    return axiosInstance.patch(`/final-settlements/${id}/lines/${lineId}`, body);
  }

  async approve(id: string): Promise<ApiResponse<FinalSettlement>> {
    return axiosInstance.post(`/final-settlements/${id}/approve`);
  }

  async markPaid(id: string): Promise<ApiResponse<FinalSettlement>> {
    return axiosInstance.post(`/final-settlements/${id}/pay`);
  }

  async cancel(id: string, reason: string): Promise<ApiResponse<FinalSettlement>> {
    return axiosInstance.post(`/final-settlements/${id}/cancel`, { reason });
  }

  async variants(): Promise<ApiResponse<string[]>> {
    return axiosInstance.get('/final-settlements/variants');
  }
}

// ── Leave encashment ───────────────────────────────────────────────────────

export interface EncashmentRequest {
  id: string;
  employeeId: string;
  leaveTypeKey: string;
  year: number;
  days: string | number;
  ratePerDay: string | number | null;
  amount: string | number | null;
  status: string;
  reason: string | null;
}

class LeaveEncashmentService {
  async policies(): Promise<ApiResponse<any[]>> {
    return axiosInstance.get('/leave-encashment/policies');
  }

  async setPolicy(body: Record<string, unknown>): Promise<ApiResponse<any>> {
    return axiosInstance.post('/leave-encashment/policies', body);
  }

  async forEmployee(employeeId: string): Promise<ApiResponse<EncashmentRequest[]>> {
    return axiosInstance.get(`/leave-encashment/employee/${employeeId}`);
  }

  async myRequests(): Promise<ApiResponse<EncashmentRequest[]>> {
    return axiosInstance.get('/leave-encashment/my-requests');
  }

  /** Read-only: answers the number before anybody commits to anything. */
  async quote(
    employeeId: string,
    params: { leaveTypeKey: string; year: number; days?: number },
  ): Promise<ApiResponse<any>> {
    return axiosInstance.get(`/leave-encashment/employee/${employeeId}/quote`, { params });
  }

  async request(body: Record<string, unknown>): Promise<ApiResponse<EncashmentRequest>> {
    return axiosInstance.post('/leave-encashment/requests', body);
  }

  async approve(id: string): Promise<ApiResponse<EncashmentRequest>> {
    return axiosInstance.post(`/leave-encashment/requests/${id}/approve`);
  }

  async reject(id: string, reason: string): Promise<ApiResponse<EncashmentRequest>> {
    return axiosInstance.post(`/leave-encashment/requests/${id}/reject`, { reason });
  }

  async carryForwardRuns(branchId?: string): Promise<ApiResponse<any[]>> {
    return axiosInstance.get('/leave-encashment/carry-forward/runs', { params: { branchId } });
  }

  async runCarryForward(body: {
    branchId: string;
    fromYear: number;
    toYear?: number;
  }): Promise<ApiResponse<any>> {
    return axiosInstance.post('/leave-encashment/carry-forward', body);
  }

  async reverseCarryForward(runId: string): Promise<ApiResponse<any>> {
    return axiosInstance.post(`/leave-encashment/carry-forward/${runId}/reverse`);
  }
}

// ── Payroll calendar ───────────────────────────────────────────────────────

class PayrollCalendarService {
  async list(branchId?: string): Promise<ApiResponse<any[]>> {
    return axiosInstance.get('/payroll-calendars', { params: { branchId } });
  }

  async forBranch(branchId: string, year: number): Promise<ApiResponse<any>> {
    return axiosInstance.get(`/payroll-calendars/branch/${branchId}/${year}`);
  }

  async save(body: Record<string, unknown>): Promise<ApiResponse<any>> {
    return axiosInstance.post('/payroll-calendars', body);
  }

  async setEnforcement(
    calendarId: string,
    month: number,
    enforceCutOff: boolean,
  ): Promise<ApiResponse<any>> {
    return axiosInstance.patch(
      `/payroll-calendars/${calendarId}/periods/${month}/enforcement`,
      { enforceCutOff },
    );
  }

  async remove(id: string): Promise<ApiResponse<any>> {
    return axiosInstance.delete(`/payroll-calendars/${id}`);
  }
}

// ── Employer recoveries ────────────────────────────────────────────────────

export interface EmployeeRecovery {
  id: string;
  employeeId: string;
  kind: string;
  reference: string | null;
  totalAmount: string | number;
  amountRecovered: string | number;
  instalmentAmount: string | number | null;
  status: string;
  reason: string | null;
  startDate: string;
}

class EmployeeRecoveryService {
  async kinds(): Promise<ApiResponse<string[]>> {
    return axiosInstance.get('/employee-recoveries/kinds');
  }

  async forEmployee(employeeId: string): Promise<ApiResponse<EmployeeRecovery[]>> {
    return axiosInstance.get(`/employee-recoveries/employee/${employeeId}`);
  }

  async create(body: Record<string, unknown>): Promise<ApiResponse<EmployeeRecovery>> {
    return axiosInstance.post('/employee-recoveries', body);
  }

  async waive(id: string, reason: string): Promise<ApiResponse<EmployeeRecovery>> {
    return axiosInstance.patch(`/employee-recoveries/${id}/waive`, { reason });
  }

  async cancel(id: string): Promise<ApiResponse<EmployeeRecovery>> {
    return axiosInstance.delete(`/employee-recoveries/${id}`);
  }
}

// ── Branch transfers ───────────────────────────────────────────────────────

export interface EmployeeTransfer {
  id: string;
  employeeId: string;
  fromBranchId: string;
  toBranchId: string;
  effectiveDate: string;
  reason: string;
  status: string;
  employee?: { fullName: string; employeeCode: string };
}

class EmployeeTransferService {
  async list(params?: { branchId?: string; status?: string }): Promise<ApiResponse<EmployeeTransfer[]>> {
    return axiosInstance.get('/employee-transfers', { params });
  }

  async request(body: Record<string, unknown>): Promise<ApiResponse<EmployeeTransfer>> {
    return axiosInstance.post('/employee-transfers', body);
  }

  async approve(id: string): Promise<ApiResponse<EmployeeTransfer>> {
    return axiosInstance.post(`/employee-transfers/${id}/approve`);
  }

  async reject(id: string, reason: string): Promise<ApiResponse<EmployeeTransfer>> {
    return axiosInstance.post(`/employee-transfers/${id}/reject`, { reason });
  }

  async apply(id: string): Promise<ApiResponse<EmployeeTransfer>> {
    return axiosInstance.post(`/employee-transfers/${id}/apply`);
  }

  async cancel(id: string): Promise<ApiResponse<EmployeeTransfer>> {
    return axiosInstance.post(`/employee-transfers/${id}/cancel`);
  }
}

// ── Grades ─────────────────────────────────────────────────────────────────

export interface Grade {
  id: string;
  code: string;
  name: string;
  level: number;
  minSalary: string | number | null;
  maxSalary: string | number | null;
  isActive: boolean;
  description: string | null;
  components?: Array<{
    id: string;
    componentType: string;
    valueType: string;
    value: string | number;
    isMandatory: boolean;
  }>;
  _count?: { employees: number };
}

class GradeService {
  async list(includeInactive = false): Promise<ApiResponse<Grade[]>> {
    return axiosInstance.get('/grades', { params: { includeInactive } });
  }

  async create(body: Record<string, unknown>): Promise<ApiResponse<Grade>> {
    return axiosInstance.post('/grades', body);
  }

  async update(id: string, body: Record<string, unknown>): Promise<ApiResponse<Grade>> {
    return axiosInstance.patch(`/grades/${id}`, body);
  }

  async retire(id: string): Promise<ApiResponse<Grade>> {
    return axiosInstance.delete(`/grades/${id}`);
  }

  async setComponents(
    id: string,
    components: Array<Record<string, unknown>>,
  ): Promise<ApiResponse<Grade>> {
    return axiosInstance.put(`/grades/${id}/components`, { components });
  }

  async template(id: string, basic: number): Promise<ApiResponse<any>> {
    return axiosInstance.get(`/grades/${id}/template`, { params: { basic } });
  }

  async assign(employeeId: string, gradeId: string | null): Promise<ApiResponse<any>> {
    return axiosInstance.post(`/grades/assign/${employeeId}`, { gradeId });
  }
}

// ── Reports ────────────────────────────────────────────────────────────────

class PayrollReportService {
  async register(month: number, year: number, branchId?: string): Promise<ApiResponse<any>> {
    return axiosInstance.get('/payrolls/reports/register', {
      params: { month, year, branchId },
    });
  }

  async cost(
    year: number,
    groupBy: 'department' | 'branch',
    month?: number,
    branchId?: string,
  ): Promise<ApiResponse<any>> {
    return axiosInstance.get('/payrolls/reports/cost', {
      params: { year, groupBy, month, branchId },
    });
  }

  async statutory(month: number, year: number, branchId?: string): Promise<ApiResponse<any>> {
    return axiosInstance.get('/payrolls/reports/statutory-summary', {
      params: { month, year, branchId },
    });
  }

  async ytd(employeeId: string, year: number): Promise<ApiResponse<any>> {
    return axiosInstance.get(`/payrolls/reports/ytd/${employeeId}`, { params: { year } });
  }

  async gratuityLiability(branchId?: string): Promise<ApiResponse<any>> {
    return axiosInstance.get('/payrolls/reports/gratuity-liability', { params: { branchId } });
  }

  async variance(month: number, year: number, branchId?: string): Promise<ApiResponse<any>> {
    return axiosInstance.get('/payrolls/reports/variance', {
      params: { month, year, branchId },
    });
  }
}

// ── Module hub ─────────────────────────────────────────────────────────────

class PayrollHubService {
  /**
   * The whole Payroll hub in one request.
   *
   * Takes no period: the server resolves the reporting month itself, to the
   * newest one that actually holds a run, and labels what it picked. `months`
   * moves only the trend panel's own window, and a value outside 6|12 is
   * refused with 400 rather than quietly defaulted.
   *
   * The branch is not a parameter either — it rides on the `X-Branch-Id` header
   * the axios instance already attaches, and the server scopes through the
   * Prisma extension.
   */
  async getHubSummary(
    months: PayrollTrendMonths = 6,
  ): Promise<ApiResponse<PayrollHubSummary>> {
    return axiosInstance.get('/payrolls/hub-summary', { params: { months } });
  }
}

export const payrollValidationService = new PayrollValidationService();
export const gratuityService = new GratuityService();
export const finalSettlementService = new FinalSettlementService();
export const leaveEncashmentService = new LeaveEncashmentService();
export const payrollCalendarService = new PayrollCalendarService();
export const employeeRecoveryService = new EmployeeRecoveryService();
export const employeeTransferService = new EmployeeTransferService();
export const gradeService = new GradeService();
export const payrollReportService = new PayrollReportService();
export const payrollHubService = new PayrollHubService();
