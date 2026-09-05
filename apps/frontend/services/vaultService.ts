import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { VaultResponse } from '@/types/vault';

class VaultService {
  async getMine(): Promise<ApiResponse<VaultResponse>> {
    return axiosInstance.get('/document-vault/me');
  }

  /** HR only — a line manager has no access to a subordinate's vault. */
  async getForEmployee(employeeId: string): Promise<ApiResponse<VaultResponse>> {
    return axiosInstance.get(`/document-vault/employee/${employeeId}`);
  }

  /**
   * Download a private file.
   *
   * Must go through axios, NOT `window.open`. The JWT lives in local storage,
   * so a plain tab navigation carries no `Authorization` header and the route
   * answers 401 — which is exactly what happened when this returned a bare URL
   * for the caller to open. Axios attaches the header, and the bytes are handed
   * to the browser as an object URL.
   */
  async download(kind: string, id: string, fileName?: string): Promise<void> {
    // The shared interceptor unwraps `response.data` for JSON but returns the
    // whole response for `responseType: 'blob'`, so `.data` is the Blob.
    const res = await axiosInstance.get(`/secure-files/${kind}/${id}`, {
      responseType: 'blob',
    });

    const blob = (res as any)?.data ?? res;
    const url = URL.createObjectURL(blob as Blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName || `${kind}-${id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // Revoked on the next tick — revoking synchronously can cancel the
      // download in some browsers before it starts.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }
}

export default new VaultService();
