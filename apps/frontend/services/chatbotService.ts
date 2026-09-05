import axiosInstance from '@/lib/axios';
import { ApiResponse } from '@/types/api';
import { ChatRequest, ChatResponse, ChatHistory, ChatSuggestion } from '@/types/chatbot';

class ChatbotService {
  async sendMessage(data: ChatRequest): Promise<ApiResponse<ChatResponse>> {
    return axiosInstance.post('/chatbot/chat', data);
  }

  async getHistory(): Promise<ApiResponse<ChatHistory[]>> {
    return axiosInstance.get('/chatbot/history');
  }

  async getSuggestions(): Promise<ApiResponse<ChatSuggestion[]>> {
    return axiosInstance.get('/chatbot/suggestions');
  }
}

export default new ChatbotService();
