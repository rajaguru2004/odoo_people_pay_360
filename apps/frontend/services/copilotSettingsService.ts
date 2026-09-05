import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  AvailableModels,
  CopilotSettings,
  TestConnectionInput,
  TestConnectionResult,
  UpdateCopilotSettings,
} from '@/types/copilotSettings';

class CopilotSettingsService {
  getSettings(): Promise<ApiResponse<CopilotSettings>> {
    return axiosInstance.get('/copilot-settings');
  }

  update(dto: UpdateCopilotSettings): Promise<ApiResponse<CopilotSettings>> {
    return axiosInstance.put('/copilot-settings', dto);
  }

  getAvailableModels(input: TestConnectionInput = {}): Promise<ApiResponse<AvailableModels>> {
    return axiosInstance.post('/copilot-settings/available-models', input, { timeout: 20_000 });
  }

  testConnection(input: TestConnectionInput): Promise<ApiResponse<TestConnectionResult>> {
    return axiosInstance.post('/copilot-settings/test-connection', input, { timeout: 30_000 });
  }
}

export default new CopilotSettingsService();
