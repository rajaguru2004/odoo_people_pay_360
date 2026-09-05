import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ModelConfig {
  name: string;
  id: string;
  provider: string;
  priority: number;
}

@Injectable()
export class LLMService {
  private readonly logger = new Logger(LLMService.name);
  private readonly apiKey: string;
  private readonly baseURL: string;
  private currentModelIndex = 0;

  // List of free models in priority order
  private readonly freeModels: ModelConfig[] = [
    {
      name: 'GPT OSS 120B',
      id: 'openai/gpt-oss-120b:free',
      provider: 'OpenAI',
      priority: 1,
    },
    {
      name: 'MiMo V2 Flash',
      id: 'xiaomi/mimo-v2-flash:free',
      provider: 'Xiaomi',
      priority: 2,
    },
    {
      name: 'Gemini 2.0 Flash',
      id: 'google/gemini-2.0-flash-exp:free',
      provider: 'Google',
      priority: 3,
    },
    {
      name: 'Llama 3.3 70B',
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      provider: 'Meta',
      priority: 4,
    },
    {
      name: 'Mistral Small 3.1',
      id: 'mistralai/mistral-small-3.1:free',
      provider: 'Mistral',
      priority: 5,
    },
    {
      name: 'Llama 3.1 405B',
      id: 'meta-llama/llama-3.1-405b-instruct:free',
      provider: 'Meta',
      priority: 6,
    },
    {
      name: 'DeepSeek R1',
      id: 'deepseek/deepseek-r1:free',
      provider: 'DeepSeek',
      priority: 7,
    },
  ];

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('OPENROUTER_API_KEY') || '';
    this.baseURL =
      this.configService.get<string>('OPENROUTER_BASE_URL') ||
      'https://openrouter.ai/api/v1';
  }

  async chat(messages: LLMMessage[], context?: any): Promise<string> {
    // Try each model in order until one succeeds
    for (let i = 0; i < this.freeModels.length; i++) {
      const modelIndex = (this.currentModelIndex + i) % this.freeModels.length;
      const model = this.freeModels[modelIndex];

      try {
        this.logger.log(`Trying model: ${model.name} (${model.provider})`);

        const response = await axios.post(
          `${this.baseURL}/chat/completions`,
          {
            model: model.id,
            messages,
            temperature: 0.7,
            max_tokens: 1000,
          },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://ess-portal.company.com',
              'X-Title': 'Ess Portal Chatbot',
            },
            timeout: 30000, // 30 second timeout
          },
        );

        const content = response.data.choices[0]?.message?.content;
        if (!content) {
          throw new Error('No response from LLM');
        }

        // Success! Update current model index for next request
        this.currentModelIndex = modelIndex;
        this.logger.log(`✅ Success with ${model.name}`);

        return content.trim();
      } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        const statusCode = error.response?.status;

        this.logger.warn(
          `❌ ${model.name} failed (${statusCode || 'timeout'}): ${errorMsg}`,
        );

        // If this is the last model, throw error
        if (i === this.freeModels.length - 1) {
          this.logger.error('All models failed. Throwing error.');
          throw new Error('Could not connect to AI. Please try again later.');
        }

        // Otherwise, continue to next model
        this.logger.log(`Trying next model...`);
      }
    }

    // Should never reach here, but just in case
    throw new Error('Could not connect to AI. Please try again later.');
  }

  // Get current active model info
  getCurrentModel(): ModelConfig {
    return this.freeModels[this.currentModelIndex];
  }

  // Get all available models
  getAvailableModels(): ModelConfig[] {
    return this.freeModels;
  }

  buildSystemPrompt(context: any): string {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    return `You are an intelligent virtual assistant for Ess Portal (Employee Self-Service & Resource Management) at the company.

**USER INFORMATION:**
- Employee ID: ${context.employeeId || 'N/A'}
- Role: ${context.role || 'EMPLOYEE'}
- Current Time: ${now.toLocaleString('en-US')}
- Current Month: ${currentMonth}/${currentYear}

**YOUR TASKS:**
1. Answer questions about employee information, attendance, salary, annual leave, and overtime
2. Explain company policies clearly
3. Guide employees on how to use the system
4. Always be polite, friendly, and professional

**IMPORTANT RULES:**
- ALWAYS PRIORITIZE using data from "SYSTEM DATA" if available
- If employeeStats data is present, answer EXACTLY with the number of employees
- If companySalary data is present, answer EXACTLY with the total salary
- If expiringContracts data is present, list the contracts that are about to expire
- Only answer regarding COMPANY and HR information
- DO NOT answer about politics, religion, or sensitive topics
- If data is not available in the system, admit it and suggest contacting HR
- Answer in English, concisely, and clearly
- Use appropriate emojis to be more friendly
- Format your response with markdown (**, •, \n\n)

**COMPANY POLICIES:**
- Working Hours: ${context.officeStartTime || '8:30'}-${context.officeEndTime || '17:30'} (Mon-Fri)
- Annual Leave: 12 days/year (accrues 1 day/month)
- Sick Leave: 30 days/year
- Overtime: Maximum 30h/month, multiplier 150%
- Pay Day: 5th of every month
- Insurance: 10.5% (cap 36 million)
- PIT: Progressive 5-35%

**HOW TO ANSWER:**
- If asked about annual leave → Provide specific balance from data
- If asked about salary → Explain salary components from data
- If asked about attendance → Summarize days and hours worked from data
- If asked about employee count → Answer EXACTLY from employeeStats
- If asked about policies → Explain clearly and simply

Answer the employee's questions accurately and helpfully!`;
  }

  buildContextPrompt(data: any): string {
    if (!data) return '';

    let prompt = '\n\n**SYSTEM DATA:**\n';

    // Employee statistics (for HR/ADMIN)
    if (data.employeeStats) {
      prompt += `\n👥 **EMPLOYEE STATISTICS:**\n`;
      prompt += `- Total employees: **${data.employeeStats.total}**\n`;
      prompt += `- Active (ACTIVE): **${data.employeeStats.active}**\n`;
      prompt += `- Inactive (INACTIVE): **${data.employeeStats.inactive}**\n`;
      prompt += `\n⚠️ IMPORTANT: Use these figures to answer questions about the number of employees!\n`;
    }

    // Company salary (for HR/ADMIN)
    if (data.companySalary) {
      prompt += `\n💰 **COMPANY TOTAL SALARY for month ${data.companySalary.month}/${data.companySalary.year}:**\n`;
      prompt += `- Total cost: **${data.companySalary.totalAmount.toLocaleString('en-US')} VND**\n`;
      prompt += `- Employee count: **${data.companySalary.employeeCount}**\n`;
      prompt += `- Status: ${data.companySalary.status}\n`;
    }

    // Expiring contracts (for HR/ADMIN)
    if (data.expiringContracts && data.expiringContracts.length > 0) {
      prompt += `\n⚠️ **EXPIRING CONTRACTS (Next 30 days):**\n`;
      prompt += `Total: **${data.expiringContracts.length}** contracts\n\n`;
      data.expiringContracts.forEach((c: any, i: number) => {
        prompt += `${i + 1}. ${c.employeeName} (${c.employeeCode}) - ${c.contractType}\n`;
        prompt += `   Expires: ${c.endDate}\n`;
      });
    }

    if (data.leaveBalance) {
      prompt += `\n📅 Annual Leave ${data.leaveBalance.year}:\n`;
      prompt += `- Total leave: ${data.leaveBalance.annualLeave} days\n`;
      prompt += `- Used: ${data.leaveBalance.usedAnnual} days\n`;
      prompt += `- Remaining: ${Number(data.leaveBalance.annualLeave) - Number(data.leaveBalance.usedAnnual)} days\n`;
      prompt += `- Sick leave: ${data.leaveBalance.sickLeave} days (used: ${data.leaveBalance.usedSick})\n`;
    }

    if (data.attendance) {
      prompt += `\n⏰ Attendance for month ${data.attendance.month}/${data.attendance.year}:\n`;
      prompt += `- Days worked: ${data.attendance.present} days\n`;
      prompt += `- Late: ${data.attendance.late} times\n`;
      prompt += `- Early leave: ${data.attendance.earlyLeave} times\n`;
      prompt += `- Total hours: ${data.attendance.totalHours} hours\n`;
    }

    if (data.salary) {
      prompt += `\n💰 Salary for month ${data.salary.month}/${data.salary.year}:\n`;
      prompt += `- Base Salary: ${data.salary.baseSalary.toLocaleString('en-US')} VND\n`;
      prompt += `- Allowances: ${data.salary.allowances.toLocaleString('en-US')} VND\n`;
      prompt += `- Bonus: ${data.salary.bonus.toLocaleString('en-US')} VND\n`;
      prompt += `- Overtime Pay: ${data.salary.overtimePay.toLocaleString('en-US')} VND\n`;
      prompt += `- Insurance: ${data.salary.insurance.toLocaleString('en-US')} VND\n`;
      prompt += `- Tax: ${data.salary.tax.toLocaleString('en-US')} VND\n`;
      prompt += `- Net Salary: ${data.salary.netSalary.toLocaleString('en-US')} VND\n`;
    }

    if (data.overtime) {
      prompt += `\n⏱️ Overtime for month ${data.overtime.month}/${data.overtime.year}:\n`;
      prompt += `- Total hours: ${data.overtime.totalHours} hours\n`;
      prompt += `- Approved: ${data.overtime.approved} requests\n`;
      prompt += `- Pending: ${data.overtime.pending} requests\n`;
      prompt += `- Remaining: ${30 - data.overtime.totalHours} hours (limit 30h/month)\n`;
    }

    if (data.employee) {
      prompt += `\n👤 Employee Information:\n`;
      prompt += `- ID: ${data.employee.employeeCode}\n`;
      prompt += `- Full Name: ${data.employee.fullName}\n`;
      prompt += `- Position: ${data.employee.position}\n`;
      prompt += `- Department: ${data.employee.department}\n`;
      prompt += `- Email: ${data.employee.email}\n`;
    }

    if (data.leaveRequests) {
      prompt += `\n📝 Recent Leave Requests:\n`;
      data.leaveRequests.forEach((req: any, index: number) => {
        const statusIcon =
          req.status === 'APPROVED'
            ? '✅'
            : req.status === 'REJECTED'
              ? '❌'
              : '⏳';
        prompt += `${index + 1}. ${statusIcon} ${req.leaveType} - ${req.startDate} to ${req.endDate} (${req.totalDays} days)\n`;
      });
    }

    if (data.knowledgeBase && data.knowledgeBase.length > 0) {
      prompt += `\n\n📚 **COMPANY KNOWLEDGE (from Knowledge Base):**\n`;
      prompt += `Here are the documents related to the question:\n\n`;
      data.knowledgeBase.forEach((kb: any, index: number) => {
        prompt += `${index + 1}. **${kb.title}** (${kb.category}) - Relevance: ${(kb.similarity * 100).toFixed(1)}%\n`;
        prompt += `${kb.content}\n\n`;
      });
      prompt += `\nPlease use information from the Knowledge Base to answer the question accurately.\n`;
    }

    return prompt;
  }
}
