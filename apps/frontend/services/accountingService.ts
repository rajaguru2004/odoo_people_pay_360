import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';

/**
 * Loan money posted to a general ledger.
 *
 * Gap report §1: there was no accounting anywhere in the product, and
 * `LoanTransaction.journalRef` was declared, indexed and written by nothing.
 */
export interface LedgerAccount {
  id: string;
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE';
  isActive: boolean;
  branchId: string | null;
}

export interface LedgerMapping {
  id: string;
  event: string;
  component: string;
  branchId: string | null;
  debitAccountId: string;
  creditAccountId: string;
  isActive: boolean;
  debitAccount?: LedgerAccount;
  creditAccount?: LedgerAccount;
}

export interface JournalLine {
  id: string;
  amount: string | number;
  component: string;
  narration: string | null;
  debitAccount?: LedgerAccount;
  creditAccount?: LedgerAccount;
}

export interface JournalEntry {
  id: string;
  reference: string;
  entryDate: string;
  narration: string | null;
  sourceType: string;
  sourceId: string;
  status: 'POSTED' | 'REVERSED' | 'REVERSAL';
  lines: JournalLine[];
}

class AccountingService {
  async accounts(includeInactive = false): Promise<ApiResponse<LedgerAccount[]>> {
    return axiosInstance.get('/accounting/accounts', {
      params: includeInactive ? { includeInactive: 'true' } : undefined,
    });
  }

  async createAccount(data: Partial<LedgerAccount>): Promise<ApiResponse<LedgerAccount>> {
    return axiosInstance.post('/accounting/accounts', data);
  }

  async mappings(): Promise<ApiResponse<LedgerMapping[]>> {
    return axiosInstance.get('/accounting/mappings');
  }

  async upsertMapping(data: {
    event: string;
    component?: string;
    debitAccountId: string;
    creditAccountId: string;
  }): Promise<ApiResponse<LedgerMapping>> {
    return axiosInstance.post('/accounting/mappings', data);
  }

  async removeMapping(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return axiosInstance.delete(`/accounting/mappings/${id}`);
  }

  async journal(params?: {
    from?: string;
    to?: string;
  }): Promise<ApiResponse<JournalEntry[]>> {
    return axiosInstance.get('/accounting/journal', { params });
  }

  /** Post everything not yet posted; reports what it could not map. */
  async postPending(): Promise<
    ApiResponse<{
      considered: number;
      posted: number;
      failures: Array<{ transactionId: string; reason: string }>;
    }>
  > {
    return axiosInstance.post('/accounting/journal/post-pending', {});
  }

  async reverse(id: string, reason: string): Promise<ApiResponse<JournalEntry>> {
    return axiosInstance.post(`/accounting/journal/${id}/reverse`, { reason });
  }
}

export default new AccountingService();
