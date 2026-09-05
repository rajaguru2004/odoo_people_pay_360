import axiosInstance from '@/lib/axios';

export interface SettingItem {
  key: string;
  value: string;
  description: string;
}

export type CountryPreset = 'IN' | 'US' | 'GB' | 'AE' | 'OM' | 'SG' | 'DE' | 'CUSTOM';

class SystemSettingsService {
  /**
   * Fetches all system settings as a list of { key, value, description } (ADMIN/HR only).
   */
  async getAll(): Promise<{ success: boolean; data: SettingItem[] }> {
    return axiosInstance.get('/system-settings');
  }

  /**
   * Fetches public branding and payroll settings (all roles).
   */
  async getPublic(): Promise<{ success: boolean; data: Record<string, string> }> {
    return axiosInstance.get('/system-settings/public');
  }

  /**
   * Bulk-updates a map of setting keys → string values.
   */
  async update(
    settings: Record<string, string>,
  ): Promise<{ success: boolean; message: string }> {
    return axiosInstance.post('/system-settings', { settings });
  }

  /**
   * Applies a country payroll preset (ADMIN only).
   * Supported: 'IN' (India), 'US' (USA), 'GB' (UK), 'AE' (UAE),
   *            'SG' (Singapore), 'DE' (Germany), 'CUSTOM' (blank slate).
   */
  async applyPreset(
    preset: CountryPreset,
  ): Promise<{ success: boolean; message: string }> {
    return axiosInstance.post('/system-settings/apply-preset', { preset });
  }

  /**
   * DESTRUCTIVE: resets the database to the base-seed baseline (ADMIN only).
   * Wipes all operational data and restores the base accounts + active Head
   * Office branch. The caller is signed out afterwards (base account IDs change).
   */
  async resetToBaseline(): Promise<{ success: boolean; message: string }> {
    return axiosInstance.post('/system-settings/reset', { confirm: 'RESET' });
  }

  /**
   * Uploads a company logo image.
   */
  async uploadLogo(file: File): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    return axiosInstance.post('/upload/logo', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  }
}

export default new SystemSettingsService();
