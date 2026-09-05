import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { PublicBranding } from '@/types/settings';

class SettingsService {
  /** Unauthenticated — safe to call from the login screen. */
  getPublic(): Promise<ApiResponse<PublicBranding>> {
    return axiosInstance.get('/system-settings/public');
  }

  getAll(): Promise<ApiResponse<Record<string, string>>> {
    return axiosInstance.get('/system-settings');
  }

  update(settings: Record<string, string>): Promise<ApiResponse<Record<string, string>>> {
    return axiosInstance.patch('/system-settings', { settings });
  }
}

export default new SettingsService();
