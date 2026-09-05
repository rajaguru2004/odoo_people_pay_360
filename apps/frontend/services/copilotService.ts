import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import {
  ConversationDetail,
  ConversationSummary,
  CopilotTurn,
} from '@/types/copilot';

// Agent loops can take a while (LLM + tool calls) — allow up to 2 minutes.
const LONG_TIMEOUT = { timeout: 120_000 };

class CopilotService {
  async sendMessage(body: {
    message: string;
    conversationId?: string;
  }): Promise<ApiResponse<CopilotTurn>> {
    return axiosInstance.post('/copilot/chat', body, LONG_TIMEOUT);
  }

  async confirmAction(body: {
    actionId: string;
    approve: boolean;
  }): Promise<ApiResponse<CopilotTurn>> {
    return axiosInstance.post('/copilot/confirm', body, LONG_TIMEOUT);
  }

  async getConversations(): Promise<ApiResponse<ConversationSummary[]>> {
    return axiosInstance.get('/copilot/conversations');
  }

  async getConversation(id: string): Promise<ApiResponse<ConversationDetail>> {
    return axiosInstance.get(`/copilot/conversations/${id}`);
  }

  async deleteConversation(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    return axiosInstance.delete(`/copilot/conversations/${id}`);
  }
}

export default new CopilotService();
