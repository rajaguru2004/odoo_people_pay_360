import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

export type BankChangeStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED';

export interface BankChangeRequest {
  id: string;
  employeeId: string;
  status: BankChangeStatus;
  bankId: string;
  iban: string; // masked in list/get responses
  accountNumber?: string | null;
  accountHolderName: string;
  createdAt: string;
  decidedAt?: string | null;
  bank?: { name: string; country: string };
  employee?: { fullName: string; employeeCode: string };
}

export interface CreateBankChangeData {
  employeeId?: string; // HR/Admin only; self-service ignores it
  bankId: string;
  data: Record<string, string>; // fieldKey -> value, per country config
}

export interface MigrateBankDetailData {
  employeeId: string;
  bankId: string;
  data: Record<string, string>;
}

export interface BankingField {
  fieldKey: string;
  label: string;
  fieldType: string; // TEXT | NUMBER | SELECT
  validationType: string;
  regex?: string | null;
  options?: unknown;
  required: boolean;
  displayOrder: number;
  placeholder?: string | null;
  helpText?: string | null;
  isSensitive: boolean;
}

export interface CurrentBankDetail {
  detail: {
    bankId: string;
    bankName?: string;
    country?: string;
    values: Record<string, string>; // masked, keyed by fieldKey
    fields: BankingField[]; // the stored detail's own country fields
    effectiveFrom: string;
  } | null;
  countries: string[]; // allowed banking countries for the employee's branch
  pendingRequestId: string | null;
}

export interface MigrationCandidate {
  id: string;
  fullName: string;
  employeeCode: string;
  branchId: string | null;
  countries: string[]; // branch allowed banking countries (ISO-2)
  profile?: {
    bankName?: string | null;
    bankBranch?: string | null;
    bankAccountNumber?: string | null;
    bankAccountHolderName?: string | null;
  };
}

class BankChangeService {
  /** Submit a bank detail change request. */
  async create(data: CreateBankChangeData): Promise<ApiResponse<{ id: string; status: BankChangeStatus }>> {
    return axiosInstance.post('/bank-change-requests', data);
  }

  async list(status?: BankChangeStatus): Promise<ApiResponse<BankChangeRequest[]>> {
    return axiosInstance.get(`/bank-change-requests${status ? `?status=${status}` : ''}`);
  }

  /** Caller's current (masked) approved detail + whether a request is pending. */
  async current(): Promise<ApiResponse<CurrentBankDetail>> {
    return axiosInstance.get('/bank-change-requests/me/current');
  }

  /** Admin/HR: another employee's current (masked) detail + pending flag. */
  async currentFor(employeeId: string): Promise<ApiResponse<CurrentBankDetail>> {
    return axiosInstance.get(`/bank-change-requests/employee/${employeeId}/current`);
  }

  async get(id: string): Promise<ApiResponse<BankChangeRequest>> {
    return axiosInstance.get(`/bank-change-requests/${id}`);
  }

  async approve(id: string, comment?: string): Promise<ApiResponse<any>> {
    return axiosInstance.post(`/bank-change-requests/${id}/approve`, { comment });
  }

  async reject(id: string, comment?: string): Promise<ApiResponse<any>> {
    return axiosInstance.post(`/bank-change-requests/${id}/reject`, { comment });
  }

  async cancel(id: string): Promise<ApiResponse<any>> {
    return axiosInstance.post(`/bank-change-requests/${id}/cancel`, {});
  }

  // HR migration
  async migrationCandidates(): Promise<ApiResponse<MigrationCandidate[]>> {
    return axiosInstance.get('/bank-change-requests/migration/candidates');
  }

  async migrate(data: MigrateBankDetailData): Promise<ApiResponse<any>> {
    return axiosInstance.post('/bank-change-requests/migration', data);
  }
}

export default new BankChangeService();
