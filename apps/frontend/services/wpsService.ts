import axiosInstance from '@/lib/axios';
import vaultService from './vaultService';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

/** Mirrors DynamicConfigField on the backend — drives the settings form. */
export interface WpsConfigField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'boolean';
  required: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  help?: string;
  placeholder?: string;
  secret?: boolean;
}

export interface WpsFormatInfo {
  key: string;
  displayName: string;
  description: string;
  /** ISO-2, or '*' for country-neutral. */
  country: string;
  currency: string;
  currencyExponent: number;
  specVersion: string;
  employerConfigSchema: WpsConfigField[];
  runOptionsSchema: WpsConfigField[];
  requiredIdentifiers: {
    category: string;
    label: string;
    severity: 'BLOCKING' | 'WARNING';
  }[];
}

export interface WpsEmployerProfile {
  id: string;
  name: string;
  legalName: string;
  country: string;
  format: string;
  isActive: boolean;
  /** Secret values arrive as a mask placeholder, never the real value. */
  data: Record<string, string>;
  usedByBranchIds: string[];
}

export interface WpsConfig {
  id: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  branchCountry: string | null;
  employerProfile: { id: string; name: string; legalName: string; country: string };
  format: string;
  enabled: boolean;
  defaultRunOptions: Record<string, unknown>;
  acceptedWarnings: string[];
}

export interface WpsFinding {
  code: string;
  severity: 'BLOCKING' | 'WARNING';
  scope: 'RUN' | 'EMPLOYER' | 'EMPLOYEE';
  message: string;
  employeeId?: string;
  employeeCode?: string;
  employeeName?: string;
  field?: string;
  fix?: { label: string; href: string };
}

export interface WpsEmployeeStatus {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  status: 'READY' | 'WARNING' | 'BLOCKED';
  findings: WpsFinding[];
}

export interface WpsPreflight {
  payrollId: string;
  branchId: string;
  branchCode: string;
  format: string;
  formatName: string;
  specVersion: string;
  currency: string;
  period: { month: number; year: number };
  ready: number;
  total: number;
  blockedEmployees: number;
  warningEmployees: number;
  canGenerate: boolean;
  runFindings: WpsFinding[];
  byEmployee: WpsEmployeeStatus[];
  requiresAcknowledgement: string[];
  totalPreview: { minor: string; formatted: string; currency: string };
}

export type WpsFileStatus =
  | 'GENERATING'
  | 'GENERATED'
  | 'FAILED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_REJECTED'
  | 'REJECTED'
  | 'SUPERSEDED'
  | 'CANCELLED';

export interface WpsFileRow {
  id: string;
  sequence: number;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  bankCode: string | null;
  /** Masked to last-4. */
  account: string | null;
  identifiers: Record<string, string>;
  basic: { minor: string; formatted: string };
  allowances: { minor: string; formatted: string };
  deductions: { minor: string; formatted: string };
  net: { minor: string; formatted: string };
  currency: string;
  status: 'INCLUDED' | 'ACCEPTED' | 'REJECTED';
  rejectionCode: string | null;
  rejectionReason: string | null;
}

export interface WpsFile {
  id: string;
  branchId: string;
  branchCode?: string;
  payrollId: string;
  period: { month: number; year: number };
  format: string;
  formatName: string;
  specVersion: string;
  status: WpsFileStatus;
  version: number;
  previousVersionId: string | null;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  employeeCount: number;
  total: { minor: string; formatted: string };
  currency: string;
  paymentDate: string;
  generatedAt: string;
  submittedAt: string | null;
  submissionReference: string | null;
  bankResponseAt: string | null;
  bankResponseRef: string | null;
  bankResponseNotes: string | null;
  rejectedCount: number;
  downloadCount: number;
  downloadable: boolean;
}

export interface WpsFileDetail extends WpsFile {
  rows: WpsFileRow[];
  employerSnapshot: unknown;
  preflightSnapshot: unknown;
  runOptions: Record<string, unknown>;
  generationError: string | null;
  previousVersion: { id: string; version: number; status: string } | null;
  nextVersions: { id: string; version: number; status: string }[];
}

class WpsService {
  // ── Catalogue + configuration ───────────────────────────────────────────
  async formats(country?: string): Promise<ApiResponse<WpsFormatInfo[]>> {
    return axiosInstance.get('/wps/formats', { params: country ? { country } : {} });
  }

  async profiles(): Promise<ApiResponse<WpsEmployerProfile[]>> {
    return axiosInstance.get('/wps/employer-profiles');
  }

  async createProfile(data: {
    name: string;
    legalName: string;
    country: string;
    format: string;
    data?: Record<string, unknown>;
  }): Promise<ApiResponse<{ id: string }>> {
    return axiosInstance.post('/wps/employer-profiles', data);
  }

  async updateProfile(
    id: string,
    data: {
      name?: string;
      legalName?: string;
      isActive?: boolean;
      data?: Record<string, unknown>;
    },
  ): Promise<ApiResponse<void>> {
    return axiosInstance.patch(`/wps/employer-profiles/${id}`, data);
  }

  async deleteProfile(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/wps/employer-profiles/${id}`);
  }

  async configs(): Promise<ApiResponse<WpsConfig[]>> {
    return axiosInstance.get('/wps/config');
  }

  async saveConfig(data: {
    branchId: string;
    employerProfileId: string;
    format: string;
    enabled?: boolean;
    defaultRunOptions?: Record<string, unknown>;
    acceptedWarnings?: string[];
  }): Promise<ApiResponse<{ id: string }>> {
    return axiosInstance.post('/wps/config', data);
  }

  async deleteConfig(id: string): Promise<ApiResponse<void>> {
    return axiosInstance.delete(`/wps/config/${id}`);
  }

  // ── Pre-flight + generation ─────────────────────────────────────────────
  async preflight(
    payrollId: string,
    runOptions?: Record<string, unknown>,
  ): Promise<ApiResponse<WpsPreflight>> {
    return axiosInstance.post('/wps/preflight', { payrollId, runOptions });
  }

  async generate(data: {
    payrollId: string;
    runOptions?: Record<string, unknown>;
    acknowledgeWarnings?: string[];
  }): Promise<ApiResponse<WpsFile>> {
    return axiosInstance.post('/wps/generate', data);
  }

  // ── Files ───────────────────────────────────────────────────────────────
  async files(params?: {
    payrollId?: string;
    branchId?: string;
    status?: string;
  }): Promise<ApiResponse<WpsFile[]>> {
    return axiosInstance.get('/wps/files', { params });
  }

  async file(id: string): Promise<ApiResponse<WpsFileDetail>> {
    return axiosInstance.get(`/wps/files/${id}`);
  }

  async verify(id: string): Promise<
    ApiResponse<{
      matches: boolean;
      storedSha256: string;
      computedSha256: string;
      byteSize: number;
    }>
  > {
    return axiosInstance.get(`/wps/files/${id}/verify`);
  }

  async submit(
    id: string,
    data: { submittedAt?: string; reference?: string },
  ): Promise<ApiResponse<WpsFileDetail>> {
    return axiosInstance.post(`/wps/files/${id}/submit`, data);
  }

  async recordBankResponse(
    id: string,
    data: {
      outcome: 'ACKNOWLEDGED' | 'PARTIALLY_REJECTED' | 'REJECTED';
      reference?: string;
      notes?: string;
      rejectedRows?: { employeeId: string; code?: string; reason?: string }[];
    },
  ): Promise<ApiResponse<WpsFileDetail>> {
    return axiosInstance.post(`/wps/files/${id}/response`, data);
  }

  async cancel(id: string, reason?: string): Promise<ApiResponse<WpsFileDetail>> {
    return axiosInstance.post(`/wps/files/${id}/cancel`, { reason });
  }

  /**
   * Download the bytes.
   *
   * Goes through the shared secure-file helper — an authenticated XHR that hands
   * the browser an object URL. A plain link or window.open would arrive without
   * the bearer token and 401, since the token lives in localStorage.
   */
  async download(file: Pick<WpsFile, 'id' | 'fileName'>): Promise<void> {
    return vaultService.download('wps-file', file.id, file.fileName ?? undefined);
  }
}

export default new WpsService();
