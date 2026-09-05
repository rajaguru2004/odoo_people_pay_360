import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import type { VaultResponse } from '@/types/vault';

class VaultService {
  /** Everything the signed-in caller holds. */
  mine(): Promise<ApiResponse<VaultResponse>> {
    return axiosInstance.get('/document-vault/me');
  }

  /** HR only — a line manager has no access to a subordinate's vault. */
  forEmployee(employeeId: string): Promise<ApiResponse<VaultResponse>> {
    return axiosInstance.get(`/document-vault/employee/${employeeId}`);
  }

  /**
   * Download a privately stored file.
   *
   * Through axios, never `window.open`. The token lives in local storage, so a
   * plain tab navigation carries no Authorization header and the route answers
   * 401 — the file is handed to the browser as an object URL instead.
   */
  async download(kind: string, id: string, fileName?: string): Promise<void> {
    // The response interceptor unwraps JSON but returns the whole response for
    // a blob, so `.data` here is the Blob itself.
    const res = await axiosInstance.get(`/secure-files/${kind}/${id}`, {
      responseType: 'blob',
    });

    const blob = ((res as unknown as { data?: Blob })?.data ?? res) as Blob;
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName || `${kind}-${id}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      // Revoked on a later tick: revoking synchronously cancels the download in
      // some browsers before it has started.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }
}

export default new VaultService();
