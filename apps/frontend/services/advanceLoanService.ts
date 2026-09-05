import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  AdvanceLoanRequest,
  AdvanceLoanAttachment,
  CreateAdvanceLoanData,
  EligibilityResult,
  LoanPayoffQuote,
  LoanScheduleRow,
  LoanType,
  PaginatedLoans,
  ReceivableLoan,
  SettlementDecision,
  SettlementQuote,
  SettlementResult,
} from '@/types/advanceLoan';

interface QueryAdvanceLoanParams {
  /** CSV accepted — `PENDING,DRAFT` asks for either. */
  status?: string;
  type?: string;
  employeeId?: string;
  /** Matches employee name, employee code or reference number. Server-side. */
  search?: string;
  /** Supplying page/limit switches the response to the paginated envelope. */
  page?: number;
  limit?: number;
}

class AdvanceLoanService {
  /**
   * The product catalogue.
   *
   * Open to every signed-in role on purpose: the terms are what a borrower is
   * agreeing to, so the request form cannot explain its own limits without
   * them. `includeInactive` is for the admin screen — a retired product cannot
   * be chosen, so offering one to a requester would only produce a refusal.
   */
  async getLoanTypes(includeInactive = false): Promise<ApiResponse<LoanType[]>> {
    return axiosInstance.get('/loan-types', {
      params: includeInactive ? { includeInactive: 'true' } : undefined,
    });
  }

  /**
   * Record that the money left the company. APPROVED → DISBURSED — a state the
   * product could not express, because approval and payout were one action.
   */
  async disburse(
    id: string,
    data: { disbursementDate?: string; disbursedAmount?: number; reference?: string },
  ): Promise<ApiResponse<AdvanceLoanRequest>> {
    return axiosInstance.post(`/advance-loans/${id}/disburse`, data);
  }

  /** Edit a request. What may change depends on its status; the server decides. */
  async update(
    id: string,
    data: Record<string, unknown>,
  ): Promise<ApiResponse<AdvanceLoanRequest>> {
    return axiosInstance.patch(`/advance-loans/${id}`, data);
  }

  /** Send a draft for approval. */
  async submitDraft(id: string): Promise<ApiResponse<AdvanceLoanRequest>> {
    return axiosInstance.post(`/advance-loans/${id}/submit`, {});
  }

  /** Reprice a running loan, writing a `LoanRateChange`. */
  async rateChange(
    id: string,
    data: {
      newRate: number;
      newMethod?: string;
      mode?: 'KEEP_TENURE' | 'KEEP_EMI';
      reason?: string;
      authorisedBy?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    return axiosInstance.post(`/advance-loans/${id}/rate-change`, data);
  }

  async rateHistory(id: string): Promise<ApiResponse<unknown[]>> {
    return axiosInstance.get(`/advance-loans/${id}/rate-history`);
  }

  /** Replace this loan with a larger one; only the difference is paid out. */
  async topup(
    id: string,
    data: {
      amount: number;
      installments: number;
      reason?: string;
      authorisedBy?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    return axiosInstance.post(`/advance-loans/${id}/topup`, data);
  }

  // ── Final settlement ──────────────────────────────────────────────────
  //
  // Complete server-side, with seven decisions and a reversal, and called by no
  // page at all — so `SETTLED` and `RECEIVABLE` were statuses no user could
  // reach, while the clearance banner told people to "settle or write off the
  // balance in Advances & Loans" on a screen that could not.

  async settlementQuote(employeeId: string): Promise<ApiResponse<SettlementQuote>> {
    return axiosInstance.get(`/advance-loans/settlement/${employeeId}`);
  }

  async settle(
    employeeId: string,
    decisions: SettlementDecision[],
    reason?: string,
  ): Promise<ApiResponse<SettlementResult>> {
    return axiosInstance.post(`/advance-loans/settlement/${employeeId}`, {
      decisions,
      reason,
    });
  }

  async reverseSettlement(
    settlementId: string,
    reason: string,
  ): Promise<ApiResponse<unknown>> {
    return axiosInstance.post(`/advance-loans/settlement/${settlementId}/reverse`, {
      reason,
    });
  }

  async receivableLoans(): Promise<ApiResponse<ReceivableLoan[]>> {
    return axiosInstance.get('/advance-loans/settlement/receivable');
  }

  async createLoanType(data: Partial<LoanType>): Promise<ApiResponse<LoanType>> {
    return axiosInstance.post('/loan-types', data);
  }

  async updateLoanType(
    id: string,
    data: Partial<LoanType>,
  ): Promise<ApiResponse<LoanType>> {
    return axiosInstance.patch(`/loan-types/${id}`, data);
  }

  async setLoanTypeActive(id: string, isActive: boolean): Promise<ApiResponse<LoanType>> {
    return axiosInstance.post(
      `/loan-types/${id}/${isActive ? 'activate' : 'deactivate'}`,
      {},
    );
  }

  async deleteLoanType(id: string): Promise<ApiResponse<{ success: boolean }>> {
    return axiosInstance.delete(`/loan-types/${id}`);
  }

  async getAll(
    params?: QueryAdvanceLoanParams,
  ): Promise<ApiResponse<AdvanceLoanRequest[]>> {
    return axiosInstance.get('/advance-loans', { params });
  }

  async getPending(): Promise<ApiResponse<AdvanceLoanRequest[]>> {
    return axiosInstance.get('/advance-loans/pending');
  }

  async getMyRequests(): Promise<ApiResponse<AdvanceLoanRequest[]>> {
    return axiosInstance.get('/advance-loans/my-requests');
  }

  async getById(id: string): Promise<ApiResponse<AdvanceLoanRequest>> {
    return axiosInstance.get(`/advance-loans/${id}`);
  }

  async create(
    data: CreateAdvanceLoanData,
  ): Promise<ApiResponse<AdvanceLoanRequest>> {
    return axiosInstance.post('/advance-loans', data);
  }

  async approve(
    id: string,
    remarks?: string,
    installments?: number,
  ): Promise<ApiResponse<AdvanceLoanRequest>> {
    return axiosInstance.post(`/advance-loans/${id}/approve`, {
      remarks,
      installments,
    });
  }

  async reject(
    id: string,
    remarks: string,
  ): Promise<ApiResponse<AdvanceLoanRequest>> {
    return axiosInstance.post(`/advance-loans/${id}/reject`, { remarks });
  }

  async cancel(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/advance-loans/${id}`);
  }

  /** Paginated list. The bare-array form stays available via getAll(). */
  async getPaged(params: QueryAdvanceLoanParams): Promise<PaginatedLoans> {
    return axiosInstance.get('/advance-loans', {
      params: { page: 1, limit: 25, ...params },
    });
  }

  /**
   * What-if eligibility. Persists nothing, so it is safe to call from the
   * request form on every (debounced) change.
   */
  async checkEligibility(
    data: {
      employeeId?: string;
      amount: number;
      installments?: number;
      type?: string;
    },
    // Lets the caller abort a superseded check while the user is still typing.
    signal?: AbortSignal,
  ): Promise<ApiResponse<EligibilityResult>> {
    return axiosInstance.post('/advance-loans/eligibility', data, { signal });
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  async getSchedule(id: string): Promise<LoanScheduleRow[]> {
    return axiosInstance.get(`/advance-loans/${id}/schedule`);
  }

  async getPayoffQuote(id: string): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.get(`/advance-loans/${id}/payoff-quote`);
  }

  async prepay(
    id: string,
    data: {
      amount: number;
      mode?: string;
      reference?: string;
      recalc?: 'REDUCE_EMI' | 'REDUCE_TENURE';
    },
  ): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.post(`/advance-loans/${id}/prepay`, data);
  }

  async close(id: string, reason: string): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.post(`/advance-loans/${id}/close`, { reason });
  }

  async foreclose(
    id: string,
    data: { waiveFutureInterest?: boolean; reason?: string },
  ): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.post(`/advance-loans/${id}/foreclose`, data);
  }

  async writeOff(
    id: string,
    data: { amount?: number; reason: string },
  ): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.post(`/advance-loans/${id}/write-off`, data);
  }

  async reinstate(id: string, reason: string): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.post(`/advance-loans/${id}/reinstate`, { reason });
  }

  async waive(
    id: string,
    data: { amount?: number; waiveType?: 'INTEREST' | 'PRINCIPAL' | 'BOTH'; reason: string },
  ): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.post(`/advance-loans/${id}/waive`, data);
  }

  async hold(
    id: string,
    data: { reason: string; until?: string },
  ): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.post(`/advance-loans/${id}/hold`, data);
  }

  async resume(id: string, reason?: string): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.post(`/advance-loans/${id}/resume`, { reason });
  }

  async skipInstallment(
    id: string,
    data: { installmentNo: number; mode?: 'EXTEND' | 'FORGIVE'; reason: string },
  ): Promise<ApiResponse<LoanPayoffQuote>> {
    return axiosInstance.post(`/advance-loans/${id}/skip-installment`, data);
  }

  async convert(
    id: string,
    data: { installments: number; interestRate?: number; reason?: string },
  ): Promise<ApiResponse<{ closedAdvanceId: string; newLoanId: string; amount: number }>> {
    return axiosInstance.post(`/advance-loans/${id}/convert`, data);
  }

  // ── import ──────────────────────────────────────────────────────────────

  /**
   * The import template workbook.
   *
   * The shared interceptor unwraps `response.data` for JSON but returns the
   * WHOLE response for `responseType: 'blob'` (`lib/axios.ts`) — so this used
   * to hand its caller an `AxiosResponse` while claiming `Promise<Blob>`. The
   * caller's `URL.createObjectURL(blob as any)` then threw, the `catch` turned
   * it into "Could not download the template", and the button did nothing for
   * every user. The `as any` at the call site is what kept the compiler quiet
   * about it.
   *
   * Unwrapped here rather than at the call site so the type is honest and the
   * next caller cannot repeat it. `vaultService.download` documents the same
   * trap and handles it the same way.
   */
  async downloadImportTemplate(): Promise<Blob> {
    const res = await axiosInstance.get('/advance-loans/import/template', {
      responseType: 'blob',
    });
    return ((res as any)?.data ?? res) as Blob;
  }

  async previewImport(file: File): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    return axiosInstance.post('/advance-loans/import/preview', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  }

  async confirmImport(rows: any[]): Promise<any> {
    return axiosInstance.post('/advance-loans/import/confirm', { rows });
  }

  async getAttachments(
    id: string,
  ): Promise<ApiResponse<AdvanceLoanAttachment[]>> {
    return axiosInstance.get(`/advance-loans/${id}/attachments`);
  }

  async uploadAttachment(
    id: string,
    file: File,
  ): Promise<ApiResponse<AdvanceLoanAttachment>> {
    const formData = new FormData();
    formData.append('file', file);
    return axiosInstance.post(`/advance-loans/${id}/attachments`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  }

  async deleteAttachment(
    id: string,
    attachmentId: string,
  ): Promise<ApiResponse<void>> {
    return axiosInstance.delete(
      `/advance-loans/${id}/attachments/${attachmentId}`,
    );
  }
}

export default new AdvanceLoanService();
