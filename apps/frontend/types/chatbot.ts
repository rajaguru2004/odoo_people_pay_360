export type ChatIntent = 
  | 'LEAVE_BALANCE'
  | 'ATTENDANCE_SUMMARY'
  | 'PAYSLIP_INFO'
  | 'OVERTIME_HOURS'
  | 'COMPANY_POLICY'
  | 'HOLIDAY_INFO'
  | 'GENERAL_QUESTION'
  | 'UNKNOWN';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  intent?: ChatIntent;
}

export interface ChatHistory {
  id: string;
  userId: string;
  employeeId?: string;
  message: string;
  response: string;
  intent: ChatIntent;
  createdAt: string;
}

export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  response: string;
  intent: ChatIntent;
  suggestions?: string[];
}

export interface ChatSuggestion {
  text: string;
  intent: ChatIntent;
}
