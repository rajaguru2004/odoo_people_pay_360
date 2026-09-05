import axiosInstance from '@/lib/axios';

export interface DevModeStatus {
  /** A developer password is configured on the backend. */
  available: boolean;
  /** The gates are actually being enforced (DEV_MODE_ENFORCED). */
  enforced: boolean;
  elevated: boolean;
  expiresAt: string | null;
  ttlMinutes: number;
}

export interface DevModeElevation {
  devToken: string;
  expiresAt: string;
}

class DevModeService {
  /** ADMIN-only. Drives whether the header icon renders at all. */
  async status(): Promise<{ success: boolean; data: DevModeStatus }> {
    return axiosInstance.get('/dev-mode/status');
  }

  /** Exchanges the developer password for a short-lived elevation token.
   *  Rejects with 401 on a wrong password — deliberately the same response as
   *  when developer mode is not configured. */
  async elevate(password: string): Promise<{ success: boolean; data: DevModeElevation }> {
    return axiosInstance.post('/dev-mode/elevate', { password });
  }

  /** Drops every live elevation for the current user. */
  async revoke(): Promise<{ success: boolean; data: { revoked: number } }> {
    return axiosInstance.post('/dev-mode/revoke', {});
  }
}

export const devModeService = new DevModeService();
export default devModeService;
