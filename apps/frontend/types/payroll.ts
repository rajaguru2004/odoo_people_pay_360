import { SalaryType } from './employee';
export type PayrollStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'LOCKED';

export interface Payroll {
  id: string;
  month: number;
  year: number;
  status: PayrollStatus;
  totalAmount: number;
  finalizedBy?: string;
  finalizedAt?: string;
  submittedAt?: string;
  submittedBy?: string;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  lockedAt?: string;
  lockedBy?: string;
  version?: number;
  previousVersionId?: string;
  notes?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
  items: PayrollItem[];
  batchId?: string;
  batch?: {
    id: string;
    name: string;
  };
  _count?: {
    items: number;
  };
}

export interface PayrollItem {
  id: string;
  payrollId: string;
  employeeId: string;
  baseSalary: number;
  workDays: number;
  actualWorkDays: number;
  allowances: number;
  bonus: number;
  deduction: number;
  overtimeHours: number;
  overtimePay: number;
  foodAllowance: number;
  reimbursement: number; // Non-taxable, added to net after deductions
  advanceLoanDeduction?: number; // Salary advance / loan recovery, subtracted from net
  insurance: number; // Total insurance (BHXH + BHYT + BHTN)
  tax: number; // Personal income tax
  /**
   * The columns `GET /payrolls/:id` has always returned and this type never
   * declared, so every screen had to reconstruct gross from five of the eight
   * earning columns and silently lost the other three. Optional because older
   * cached responses and the trimmed payslip view models do not carry them.
   */
  siteAllowance?: number; // Site allowance granted on an overtime request. Earning, taxable.
  leaveEncashment?: number; // Leave paid out instead of taken. Earning.
  gratuityPayout?: number; // EOSB paid through this run. Only on a FINAL_SETTLEMENT run.
  garnishment?: number; // Court-ordered attachment. Deducted before loan recovery.
  otherRecovery?: number; // Asset damage, training bonds. Post-tax employer recovery.
  netSalary: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    employeeCode: string;
    fullName: string;
    position?: string;
    /**
     * Pay basis. Absent means MONTHLY (mirrors the backend's toSalaryBasis).
     * Every basic-pay figure on this item is a MONTH's pay for MONTHLY staff
     * and `dayRate x actualWorkDays` for DAILY staff.
     */
    salaryType?: SalaryType;
    department?: {
      id: string;
      name: string;
    };
  };
}

/**
 * What the "my payslip" detail endpoint returns: a payroll item plus the run it
 * belongs to. The page consumes the raw item shape, not the Payslip view model
 * below.
 */
export interface MyPayslipDetail extends PayrollItem {
  payroll: {
    id: string;
    month: number;
    year: number;
    status: string;
  };
}

export interface CreatePayrollData {
  month: number;
  year: number;
  batchId?: string;
  employeeIds?: string[];
}

export interface UpdatePayrollItemData {
  allowances?: number;
  bonus?: number;
  deduction?: number;
  overtimeHours?: number;
  foodAllowance?: number;
  notes?: string;
}

export interface Payslip {
  employee: {
    employeeCode: string;
    fullName: string;
    position: string;
    department: string;
  };
  period: {
    month: number;
    year: number;
  };
  earnings: {
    baseSalary: number;
    allowances: number;
    bonus: number;
    overtimePay: number;
    foodAllowance?: number;
    total: number;
  };
  deductions: {
    insurance: number; // Total insurance (BHXH + BHYT + BHTN)
    tax: number; // Personal income tax
    other: number; // Other deductions
    total: number;
  };
  attendance: {
    workDays: number;
    actualWorkDays: number;
    overtimeHours: number;
  };
  netSalary: number;
}
