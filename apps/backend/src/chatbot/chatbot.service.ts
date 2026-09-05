import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LLMService } from './llm.service';
import { KnowledgeService } from './knowledge.service';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatContext {
  employeeId?: string;
  departmentId?: string;
  role?: string;
}

enum Permission {
  VIEW_OWN_DATA = 'VIEW_OWN_DATA',
  VIEW_PUBLIC_POLICY = 'VIEW_PUBLIC_POLICY',
  VIEW_ALL_DATA = 'VIEW_ALL_DATA',
  VIEW_STATISTICS = 'VIEW_STATISTICS',
  VIEW_HR_POLICY = 'VIEW_HR_POLICY',
  VIEW_SYSTEM = 'VIEW_SYSTEM',
  VIEW_AUDIT = 'VIEW_AUDIT',
  VIEW_DEPT_DATA = 'VIEW_DEPT_DATA',
  VIEW_TEAM_REPORTS = 'VIEW_TEAM_REPORTS',
}

@Injectable()
export class ChatbotService {
  constructor(
    private prisma: PrismaService,
    private llmService: LLMService,
    private knowledgeService: KnowledgeService,
  ) {}

  async chat(
    message: string,
    context: ChatContext,
    history: ChatMessage[] = [],
  ) {
    try {
      // Search knowledge base using RAG first
      const knowledgeResults = await this.knowledgeService.search(message, 3);

      // Fetch relevant data from database based on message content
      const data = await this.fetchRelevantData(message, context);

      // Add knowledge base results to data
      if (knowledgeResults.length > 0) {
        data.knowledgeBase = knowledgeResults.map((r) => ({
          title: r.title,
          content: r.content,
          category: r.category,
          similarity: r.similarity,
        }));
      }

      // Fetch settings dynamically for LLM context
      const startSetting = await this.prisma.systemSetting.findUnique({
        where: { key: 'office_start_time' },
      });
      const endSetting = await this.prisma.systemSetting.findUnique({
        where: { key: 'office_end_time' },
      });
      const officeStartTime = startSetting?.value || '08:30';
      const officeEndTime = endSetting?.value || '17:30';

      const enrichedContext = {
        ...context,
        officeStartTime,
        officeEndTime,
      };

      // If no employee data but have knowledge base, still try LLM
      if (!context.employeeId && knowledgeResults.length > 0) {
        // Build system prompt with company context
        const systemPrompt = this.llmService.buildSystemPrompt(enrichedContext);

        // Build context prompt with knowledge base only
        const contextPrompt = this.llmService.buildContextPrompt(data);

        // Prepare messages for LLM
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt + contextPrompt },
          ...history.slice(-5),
          { role: 'user', content: message },
        ];

        try {
          // Call LLM
          const response = await this.llmService.chat(
            messages,
            enrichedContext,
          );

          return {
            success: true,
            data: {
              message: response,
              intent: 'LLM_RESPONSE',
              additionalData: data,
            },
          };
        } catch (llmError) {
          // If LLM fails, return knowledge base directly
          return this.buildKnowledgeBaseResponse(knowledgeResults, message);
        }
      }

      // Build system prompt with company context
      const systemPrompt = this.llmService.buildSystemPrompt(enrichedContext);

      // Build context prompt with fetched data
      const contextPrompt = this.llmService.buildContextPrompt(data);

      // Prepare messages for LLM
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt + contextPrompt },
        ...history.slice(-5), // Keep last 5 messages for context
        { role: 'user', content: message },
      ];

      // Call LLM
      const response = await this.llmService.chat(messages, enrichedContext);

      return {
        success: true,
        data: {
          message: response,
          intent: 'LLM_RESPONSE',
          additionalData: data,
        },
      };
    } catch (error) {
      // Fallback to rule-based if LLM fails
      return this.fallbackRuleBasedChat(message, context, history);
    }
  }

  // Build response directly from knowledge base
  private buildKnowledgeBaseResponse(knowledgeResults: any[], query: string) {
    if (knowledgeResults.length === 0) {
      return {
        success: true,
        data: {
          message: `❓ Sorry, I couldn't find any information related to your question.\n\nYou can:\n• Ask about company policies\n• Ask about workflows\n• Contact HR: hr@company.com`,
          intent: 'NO_KNOWLEDGE',
          additionalData: null,
        },
      };
    }

    const topResult = knowledgeResults[0];
    let response = `📚 **${topResult.title}**\n\n`;
    response += `${topResult.content}\n\n`;

    if (knowledgeResults.length > 1) {
      response += `\n**See more:**\n`;
      knowledgeResults.slice(1).forEach((r, i) => {
        response += `${i + 1}. ${r.title} (${r.category})\n`;
      });
    }

    response += `\n💡 If you need more information, please contact HR: hr@company.com`;

    return {
      success: true,
      data: {
        message: response,
        intent: 'KNOWLEDGE_BASE',
        additionalData: { knowledgeBase: knowledgeResults },
      },
    };
  }

  private async fetchRelevantData(
    message: string,
    context: ChatContext,
  ): Promise<any> {
    const lowerMessage = message.toLowerCase();
    const data: any = {};
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // Extract month from message if specified
    const monthMatch = lowerMessage.match(/month (\d+)/);
    const month = monthMatch
      ? parseInt(monthMatch[1] || monthMatch[2])
      : currentMonth;

    // Fetch employee info if asking about personal info
    if (lowerMessage.match(/me|my|information/)) {
      if (context.employeeId) {
        const employee = await this.prisma.employee.findUnique({
          where: { id: context.employeeId },
          include: {
            department: true,
            contracts: {
              where: { status: 'ACTIVE' },
              take: 1,
            },
          },
        });

        if (employee) {
          data.employee = {
            employeeCode: employee.employeeCode,
            fullName: employee.fullName,
            position: employee.position,
            department: employee.department.name,
            email: employee.email,
            startDate: employee.startDate.toLocaleDateString('en-US'),
          };
        }
      }
    }

    // Fetch leave balance
    if (lowerMessage.match(/leave|annual leave|leave days/)) {
      if (context.employeeId) {
        const balance = await this.prisma.leaveBalance.findFirst({
          where: { employeeId: context.employeeId, year: currentYear },
        });

        if (balance) {
          data.leaveBalance = {
            year: balance.year,
            annualLeave: Number(balance.annualLeave),
            usedAnnual: Number(balance.usedAnnual),
            sickLeave: Number(balance.sickLeave),
            usedSick: Number(balance.usedSick),
          };
        }
      }
    }

    // Fetch attendance
    if (lowerMessage.match(/attendance|work/)) {
      if (context.employeeId) {
        const startDate = new Date(currentYear, month - 1, 1);
        const endDate = new Date(currentYear, month, 0);

        const attendances = await this.prisma.attendance.findMany({
          where: {
            employeeId: context.employeeId,
            date: { gte: startDate, lte: endDate },
          },
        });

        const present = attendances.filter(
          (a) => a.status === 'PRESENT',
        ).length;
        const late = attendances.filter((a) => a.isLate).length;
        const earlyLeave = attendances.filter((a) => a.isEarlyLeave).length;
        const totalHours = attendances.reduce(
          (sum, a) => sum + Number(a.workHours || 0),
          0,
        );

        data.attendance = {
          month,
          year: currentYear,
          present,
          late,
          earlyLeave,
          totalHours: totalHours.toFixed(1),
        };
      }
    }

    // Fetch salary
    if (lowerMessage.match(/salary|income|payroll/)) {
      if (context.employeeId) {
        const payroll = await this.prisma.payroll.findFirst({
          where: { month, year: currentYear },
          include: {
            items: {
              where: { employeeId: context.employeeId },
            },
          },
        });

        if (payroll && payroll.items.length > 0) {
          const item = payroll.items[0];
          data.salary = {
            month,
            year: currentYear,
            baseSalary: Number(item.baseSalary),
            allowances: Number(item.allowances),
            bonus: Number(item.bonus),
            overtimePay: Number(item.overtimePay),
            deduction: Number(item.deduction),
            insurance: Number(item.insurance),
            tax: Number(item.tax),
            netSalary: Number(item.netSalary),
            status: payroll.status,
          };
        }
      }
    }

    // Fetch overtime
    if (lowerMessage.match(/overtime|extra work/)) {
      if (context.employeeId) {
        const startDate = new Date(currentYear, month - 1, 1);
        const endDate = new Date(currentYear, month, 0);

        const overtimes = await this.prisma.overtimeRequest.findMany({
          where: {
            employeeId: context.employeeId,
            date: { gte: startDate, lte: endDate },
          },
        });

        const approved = overtimes.filter((o) => o.status === 'APPROVED');
        const totalHours = approved.reduce(
          (sum, o) => sum + Number(o.hours),
          0,
        );

        data.overtime = {
          month,
          year: currentYear,
          totalHours,
          approved: approved.length,
          pending: overtimes.filter((o) => o.status === 'PENDING').length,
        };
      }
    }

    // Fetch leave requests
    if (lowerMessage.match(/leave request|leave form/)) {
      if (context.employeeId) {
        const requests = await this.prisma.leaveRequest.findMany({
          where: { employeeId: context.employeeId },
          orderBy: { createdAt: 'desc' },
          take: 5,
        });

        data.leaveRequests = requests.map((req) => ({
          leaveType: req.leaveType,
          startDate: req.startDate.toLocaleDateString('en-US'),
          endDate: req.endDate.toLocaleDateString('en-US'),
          totalDays: Number(req.totalDays),
          status: req.status,
        }));
      }
    }

    // Fetch company statistics for HR_MANAGER and ADMIN
    if (context.role === 'HR_MANAGER' || context.role === 'ADMIN') {
      if (lowerMessage.match(/total salary|payroll cost|company salary/)) {
        const payroll = await this.prisma.payroll.findFirst({
          where: { month, year: currentYear },
          include: {
            _count: { select: { items: true } },
          },
        });

        if (payroll) {
          data.companySalary = {
            month,
            year: currentYear,
            totalAmount: Number(payroll.totalAmount),
            employeeCount: payroll._count.items,
            status: payroll.status,
          };
        }
      }

      if (lowerMessage.match(/employee count|number of employees/)) {
        const total = await this.prisma.employee.count();
        const active = await this.prisma.employee.count({
          where: { status: 'ACTIVE' },
        });
        const inactive = await this.prisma.employee.count({
          where: { status: 'INACTIVE' },
        });

        data.employeeStats = { total, active, inactive };
      }

      if (lowerMessage.match(/contract expiring/)) {
        const now = new Date();
        const thirtyDaysLater = new Date(
          now.getTime() + 30 * 24 * 60 * 60 * 1000,
        );

        const contracts = await this.prisma.contract.findMany({
          where: {
            status: 'ACTIVE',
            endDate: { gte: now, lte: thirtyDaysLater },
          },
          include: {
            employee: {
              select: { fullName: true, employeeCode: true },
            },
          },
          take: 10,
        });

        data.expiringContracts = contracts.map((c) => ({
          employeeName: c.employee.fullName,
          employeeCode: c.employee.employeeCode,
          endDate: c.endDate?.toLocaleDateString('en-US'),
          contractType: c.contractType,
        }));
      }
    }

    return data;
  }

  private async fallbackRuleBasedChat(
    message: string,
    context: ChatContext,
    history: ChatMessage[] = [],
  ) {
    // Get permissions based on role
    const permissions = this.getPermissions(context.role || 'EMPLOYEE');

    // Analyze intent from message
    const intent = await this.detectIntent(message, context.role);

    // Check access permission
    if (!this.hasAccess(intent.type, permissions)) {
      return {
        success: false,
        data: {
          message:
            '❌ **Access Denied**\n\n' +
            'You do not have permission to access this information.\n\n' +
            `Your role: **${this.getRoleLabel(context.role)}**\n\n` +
            'Type "help" to see questions you can ask.',
          intent: 'ACCESS_DENIED',
          additionalData: null,
        },
      };
    }

    // Process by intent
    let response: string;
    const data: any = null;

    switch (intent.type) {
      case 'LEAVE_BALANCE':
        response = await this.handleLeaveBalanceQuery(context);
        break;

      case 'ATTENDANCE_SUMMARY':
        response = await this.handleAttendanceSummary(context, intent.params);
        break;

      case 'SALARY_INFO':
        response = await this.handleSalaryInfo(context, intent.params);
        break;

      case 'COMPANY_POLICY':
        response = await this.handleCompanyPolicy(intent.params);
        break;

      case 'EMPLOYEE_INFO':
        response = await this.handleEmployeeInfo(context, intent.params);
        break;

      case 'DEPARTMENT_INFO':
        response = await this.handleDepartmentInfo(intent.params);
        break;

      case 'LEAVE_REQUEST_STATUS':
        response = await this.handleLeaveRequestStatus(context);
        break;

      case 'OVERTIME_INFO':
        response = await this.handleOvertimeInfo(context, intent.params);
        break;

      // HR_MANAGER & ADMIN intents
      case 'COMPANY_SALARY_TOTAL':
        response = await this.handleCompanySalaryTotal(context, intent.params);
        break;

      case 'EMPLOYEE_COUNT':
        response = await this.handleEmployeeCount(context);
        break;

      case 'CONTRACT_EXPIRING':
        response = await this.handleContractExpiring(context);
        break;

      case 'DEPARTMENT_STATS':
        response = await this.handleDepartmentStats(context);
        break;

      case 'ATTENDANCE_REPORT':
        response = await this.handleAttendanceReport(context, intent.params);
        break;

      // ADMIN intents
      case 'SYSTEM_STATUS':
        response = await this.handleSystemStatus(context);
        break;

      case 'USER_ACTIVITY':
        response = await this.handleUserActivity(context);
        break;

      case 'AUDIT_LOGS':
        response = await this.handleAuditLogs(context);
        break;

      case 'GREETING':
        response = this.handleGreeting(context);
        break;

      case 'HELP':
        response = this.handleHelp();
        break;

      default:
        response = this.handleUnknown(message);
    }

    return {
      success: true,
      data: {
        message: response,
        intent: intent.type,
        additionalData: data,
      },
    };
  }

  private async detectIntent(
    message: string,
    role?: string,
  ): Promise<{ type: string; params: any }> {
    const lowerMessage = message.toLowerCase();

    // HR_MANAGER & ADMIN only intents
    if (role === 'HR_MANAGER' || role === 'ADMIN') {
      // Company statistics
      if (lowerMessage.match(/total salary|company salary|payroll cost/)) {
        const monthMatch = lowerMessage.match(/month (\d+)/);
        return {
          type: 'COMPANY_SALARY_TOTAL',
          params: {
            month: monthMatch ? parseInt(monthMatch[1] || monthMatch[2]) : null,
          },
        };
      }

      // All employees count
      if (
        lowerMessage.match(/how many employees|employee count|total employees/)
      ) {
        return { type: 'EMPLOYEE_COUNT', params: {} };
      }

      // Contract expiring
      if (lowerMessage.match(/contract expiring|contracts ending/)) {
        return { type: 'CONTRACT_EXPIRING', params: {} };
      }

      // Department statistics
      if (lowerMessage.match(/department stats|department report/)) {
        return { type: 'DEPARTMENT_STATS', params: {} };
      }

      // Attendance report
      if (lowerMessage.match(/attendance report|attendance stats/)) {
        const monthMatch = lowerMessage.match(/month (\d+)/);
        return {
          type: 'ATTENDANCE_REPORT',
          params: {
            month: monthMatch ? parseInt(monthMatch[1] || monthMatch[2]) : null,
          },
        };
      }
    }

    // ADMIN only intents
    if (role === 'ADMIN') {
      // System status
      if (lowerMessage.match(/system status|server status/)) {
        return { type: 'SYSTEM_STATUS', params: {} };
      }

      // User activity
      if (lowerMessage.match(/who logged in|user activity/)) {
        return { type: 'USER_ACTIVITY', params: {} };
      }

      // Audit logs
      if (lowerMessage.match(/audit log|change history/)) {
        return { type: 'AUDIT_LOGS', params: {} };
      }
    }

    // Leave balance queries (All roles - own data)
    if (lowerMessage.match(/leave|annual leave|leave days/)) {
      return { type: 'LEAVE_BALANCE', params: {} };
    }

    // Attendance queries
    if (lowerMessage.match(/attendance|work/)) {
      const monthMatch = lowerMessage.match(/month (\d+)/);
      return {
        type: 'ATTENDANCE_SUMMARY',
        params: {
          month: monthMatch ? parseInt(monthMatch[1] || monthMatch[2]) : null,
        },
      };
    }

    // Salary queries
    if (lowerMessage.match(/salary|income|payroll/)) {
      const monthMatch = lowerMessage.match(/month (\d+)/);
      return {
        type: 'SALARY_INFO',
        params: {
          month: monthMatch ? parseInt(monthMatch[1] || monthMatch[2]) : null,
        },
      };
    }

    // Company policy
    if (lowerMessage.match(/regulation|policy|rules/)) {
      return { type: 'COMPANY_POLICY', params: { topic: lowerMessage } };
    }

    // Employee info
    if (lowerMessage.match(/employee|staff|information/)) {
      return { type: 'EMPLOYEE_INFO', params: {} };
    }

    // Department info
    if (lowerMessage.match(/department|unit/)) {
      return { type: 'DEPARTMENT_INFO', params: {} };
    }

    // Leave request status
    if (lowerMessage.match(/leave request|leave status/)) {
      return { type: 'LEAVE_REQUEST_STATUS', params: {} };
    }

    // Overtime info
    if (lowerMessage.match(/overtime|extra work/)) {
      const monthMatch = lowerMessage.match(/month (\d+)/);
      return {
        type: 'OVERTIME_INFO',
        params: {
          month: monthMatch ? parseInt(monthMatch[1] || monthMatch[2]) : null,
        },
      };
    }

    // Greeting
    if (lowerMessage.match(/^(hello|hi|hey)/)) {
      return { type: 'GREETING', params: {} };
    }

    // Help
    if (lowerMessage.match(/help|support|guide/)) {
      return { type: 'HELP', params: {} };
    }

    return { type: 'UNKNOWN', params: {} };
  }

  private async handleLeaveBalanceQuery(context: ChatContext): Promise<string> {
    if (!context.employeeId) {
      return 'Sorry, I cannot identify your employee information.';
    }

    const year = new Date().getFullYear();
    const balance = await this.prisma.leaveBalance.findFirst({
      where: { employeeId: context.employeeId, year },
    });

    if (!balance) {
      return `You do not have annual leave information for ${year}.`;
    }

    const remaining = Number(balance.annualLeave) - Number(balance.usedAnnual);

    return (
      `📊 **Annual Leave Information ${year}:**\n\n` +
      `• Total annual leave: ${balance.annualLeave} days\n` +
      `• Used: ${balance.usedAnnual} days\n` +
      `• Remaining: ${remaining} days\n` +
      `• Sick leave: ${balance.sickLeave} days (used: ${balance.usedSick})`
    );
  }

  private async handleAttendanceSummary(
    context: ChatContext,
    params: any,
  ): Promise<string> {
    if (!context.employeeId) {
      return 'Sorry, I cannot identify your employee information.';
    }

    const now = new Date();
    const month = params.month || now.getMonth() + 1;
    const year = now.getFullYear();
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    const attendances = await this.prisma.attendance.findMany({
      where: {
        employeeId: context.employeeId,
        date: { gte: startDate, lte: endDate },
      },
    });

    const present = attendances.filter((a) => a.status === 'PRESENT').length;
    const late = attendances.filter((a) => a.isLate).length;
    const earlyLeave = attendances.filter((a) => a.isEarlyLeave).length;
    const totalHours = attendances.reduce(
      (sum, a) => sum + Number(a.workHours || 0),
      0,
    );

    return (
      `📅 **Attendance Summary for ${month}/${year}:**\n\n` +
      `• Days worked: ${present} days\n` +
      `• Times late: ${late} times\n` +
      `• Times early leave: ${earlyLeave} times\n` +
      `• Total working hours: ${totalHours.toFixed(1)} hours\n` +
      `• Average: ${(totalHours / present || 0).toFixed(1)} hours/day`
    );
  }

  private async handleSalaryInfo(
    context: ChatContext,
    params: any,
  ): Promise<string> {
    if (!context.employeeId) {
      return 'Sorry, I cannot identify your employee information.';
    }

    const now = new Date();
    const month = params.month || now.getMonth() + 1;
    const year = now.getFullYear();

    const payroll = await this.prisma.payroll.findFirst({
      where: { month, year },
      include: {
        items: {
          where: { employeeId: context.employeeId },
        },
      },
    });

    if (!payroll || payroll.items.length === 0) {
      return `No salary information for ${month}/${year}.`;
    }

    const item = payroll.items[0];

    return (
      `💰 **Salary Information for ${month}/${year}:**\n\n` +
      `• Base Salary: ${Number(item.baseSalary).toLocaleString('en-US')} VND\n` +
      `• Allowances: ${Number(item.allowances).toLocaleString('en-US')} VND\n` +
      `• Bonus: ${Number(item.bonus).toLocaleString('en-US')} VND\n` +
      `• Overtime Pay: ${Number(item.overtimePay).toLocaleString('en-US')} VND\n` +
      `• Deduction: ${Number(item.deduction).toLocaleString('en-US')} VND\n` +
      `• Insurance: ${Number(item.insurance).toLocaleString('en-US')} VND\n` +
      `• PIT: ${Number(item.tax).toLocaleString('en-US')} VND\n` +
      `• **Net Salary: ${Number(item.netSalary).toLocaleString('en-US')} VND**\n\n` +
      `Status: ${payroll.status === 'LOCKED' ? '✅ Finalized' : '⏳ Processing'}`
    );
  }

  private async handleCompanyPolicy(params: any): Promise<string> {
    const startSetting = await this.prisma.systemSetting.findUnique({
      where: { key: 'office_start_time' },
    });
    const endSetting = await this.prisma.systemSetting.findUnique({
      where: { key: 'office_end_time' },
    });
    const officeStart = startSetting?.value || '08:30';
    const officeEnd = endSetting?.value || '17:30';

    const policies = {
      'working hours': `⏰ **Working Hours:**\n• Work Shift: ${officeStart} - ${officeEnd}\n• Monday - Friday`,
      'annual leave':
        '📅 **Leave Policy:**\n• Annual leave: 12 days/year\n• Accrual: 1 day/month\n• Sick leave: 30 days/year\n• Register in advance: 3 days (annual leave)',
      overtime: `⏱️ **Overtime Policy:**\n• Maximum: 30 hours/month, 200 hours/year\n• Multiplier: 150% hourly wage\n• Time: Outside office hours (before ${officeStart} or after ${officeEnd})`,
      salary:
        '💰 **Salary Policy:**\n• Payment date: 5th of every month\n• Insurance: 10.5% (cap 36M)\n• PIT: Progressive 5-35%\n• Deduction: 11M/person',
    };

    const topic = params.topic.toLowerCase();
    for (const [key, value] of Object.entries(policies)) {
      if (topic.includes(key)) {
        return value;
      }
    }

    return (
      '📋 **Company Policies:**\n\n' +
      `1. Working hours: ${officeStart}-${officeEnd} (Mon-Fri)\n` +
      '2. Annual leave: 12 days/year\n' +
      '3. Overtime: Maximum 30h/month\n' +
      '4. Salary: Paid on the 5th of every month\n\n' +
      'Ask specifically for more details!'
    );
  }

  private async handleEmployeeInfo(
    context: ChatContext,
    params: any,
  ): Promise<string> {
    if (!context.employeeId) {
      return 'Sorry, I cannot identify your employee information.';
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: context.employeeId },
      include: {
        department: true,
        contracts: {
          where: { status: 'ACTIVE' },
          take: 1,
        },
      },
    });

    if (!employee) {
      return 'Employee information not found.';
    }

    return (
      `👤 **Employee Information:**\n\n` +
      `• ID: ${employee.employeeCode}\n` +
      `• Full Name: ${employee.fullName}\n` +
      `• Position: ${employee.position}\n` +
      `• Department: ${employee.department.name}\n` +
      `• Email: ${employee.email}\n` +
      `• Join Date: ${employee.startDate.toLocaleDateString('en-US')}\n` +
      `• Status: ${employee.status}`
    );
  }

  private async handleDepartmentInfo(params: any): Promise<string> {
    const departments = await this.prisma.department.findMany({
      include: {
        _count: {
          select: { employees: true },
        },
      },
    });

    let response = '🏢 **Department List:**\n\n';
    departments.forEach((dept) => {
      response += `• ${dept.name} (${dept.code}): ${dept._count.employees} employees\n`;
    });

    return response;
  }

  private async handleLeaveRequestStatus(
    context: ChatContext,
  ): Promise<string> {
    if (!context.employeeId) {
      return 'Sorry, I cannot identify your employee information.';
    }

    const requests = await this.prisma.leaveRequest.findMany({
      where: { employeeId: context.employeeId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    if (requests.length === 0) {
      return 'You do not have any leave requests.';
    }

    let response = '📝 **Recent Leave Requests:**\n\n';
    requests.forEach((req, index) => {
      const statusIcon =
        req.status === 'APPROVED'
          ? '✅'
          : req.status === 'REJECTED'
            ? '❌'
            : '⏳';
      response +=
        `${index + 1}. ${statusIcon} ${req.leaveType} - ` +
        `${req.startDate.toLocaleDateString('en-US')} to ` +
        `${req.endDate.toLocaleDateString('en-US')} ` +
        `(${req.totalDays} days) - ${req.status}\n`;
    });

    return response;
  }

  private async handleOvertimeInfo(
    context: ChatContext,
    params: any,
  ): Promise<string> {
    if (!context.employeeId) {
      return 'Sorry, I cannot identify your employee information.';
    }

    const now = new Date();
    const month = params.month || now.getMonth() + 1;
    const year = now.getFullYear();
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    const overtimes = await this.prisma.overtimeRequest.findMany({
      where: {
        employeeId: context.employeeId,
        date: { gte: startDate, lte: endDate },
      },
    });

    const approved = overtimes.filter((o) => o.status === 'APPROVED');
    const totalHours = approved.reduce((sum, o) => sum + Number(o.hours), 0);

    return (
      `⏱️ **Overtime Information for ${month}/${year}:**\n\n` +
      `• Total hours: ${totalHours} hours\n` +
      `• Approved requests: ${approved.length}\n` +
      `• Pending requests: ${overtimes.filter((o) => o.status === 'PENDING').length}\n` +
      `• Monthly limit: 30 hours\n` +
      `• Remaining: ${Math.max(0, 30 - totalHours)} hours`
    );
  }

  private handleGreeting(context: ChatContext): string {
    const hour = new Date().getHours();
    let greeting = 'Hello';

    if (hour < 12) greeting = 'Good morning';
    else if (hour < 18) greeting = 'Good afternoon';
    else greeting = 'Good evening';

    return (
      `${greeting}! 👋\n\n` +
      'I am the Ess Portal virtual assistant. I can help you with:\n\n' +
      '• Check leave balance\n' +
      '• View attendance summary\n' +
      '• Look up salary information\n' +
      '• Ask about company policies\n' +
      '• Check request status\n\n' +
      'How can I help you?'
    );
  }

  private handleHelp(): string {
    return (
      '❓ **How to use:**\n\n' +
      '**Sample questions:**\n' +
      '• "How many leave days do I have left?"\n' +
      '• "How is my attendance this month?"\n' +
      '• "How much is my salary for December?"\n' +
      '• "What are the working hours?"\n' +
      '• "How many overtime hours have I worked?"\n' +
      '• "What is the status of my leave request?"\n\n' +
      '**Supported topics:**\n' +
      '✅ Annual leave & time off\n' +
      '✅ Attendance & overtime\n' +
      '✅ Salary & taxes\n' +
      '✅ Company policies\n' +
      '✅ Employee information'
    );
  }

  private handleUnknown(message: string): string {
    return (
      `🤔 Sorry, I didn't understand your question.\n\n` +
      'You can ask about:\n' +
      '• Annual leave (remaining days)\n' +
      '• Attendance (monthly summary)\n' +
      '• Salary (monthly payroll info)\n' +
      '• Company policies\n' +
      '• Overtime (total hours)\n\n' +
      'Or type "help" to see detailed instructions.'
    );
  }

  // Save chat history
  async saveChatHistory(employeeId: string, message: string, response: string) {
    await this.prisma.chatHistory.create({
      data: {
        employeeId,
        userMessage: message,
        botResponse: response,
      },
    });
  }

  // Get chat history
  async getChatHistory(employeeId: string, limit: number = 10) {
    return this.prisma.chatHistory.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // =====================================================
  // ROLE-BASED ACCESS CONTROL
  // =====================================================

  private getPermissions(role: string): Permission[] {
    const permissionMap: Record<string, Permission[]> = {
      EMPLOYEE: [Permission.VIEW_OWN_DATA, Permission.VIEW_PUBLIC_POLICY],
      MANAGER: [
        Permission.VIEW_OWN_DATA,
        Permission.VIEW_PUBLIC_POLICY,
        Permission.VIEW_DEPT_DATA,
        Permission.VIEW_TEAM_REPORTS,
      ],
      HR_MANAGER: [
        Permission.VIEW_OWN_DATA,
        Permission.VIEW_PUBLIC_POLICY,
        Permission.VIEW_ALL_DATA,
        Permission.VIEW_STATISTICS,
        Permission.VIEW_HR_POLICY,
      ],
      ADMIN: [
        Permission.VIEW_OWN_DATA,
        Permission.VIEW_PUBLIC_POLICY,
        Permission.VIEW_ALL_DATA,
        Permission.VIEW_STATISTICS,
        Permission.VIEW_HR_POLICY,
        Permission.VIEW_SYSTEM,
        Permission.VIEW_AUDIT,
      ],
    };

    return permissionMap[role] || permissionMap['EMPLOYEE'];
  }

  private hasAccess(intentType: string, permissions: Permission[]): boolean {
    const intentPermissions: Record<string, Permission[]> = {
      // Employee intents (own data)
      LEAVE_BALANCE: [Permission.VIEW_OWN_DATA],
      ATTENDANCE_SUMMARY: [Permission.VIEW_OWN_DATA],
      SALARY_INFO: [Permission.VIEW_OWN_DATA],
      OVERTIME_INFO: [Permission.VIEW_OWN_DATA],
      LEAVE_REQUEST_STATUS: [Permission.VIEW_OWN_DATA],
      EMPLOYEE_INFO: [Permission.VIEW_OWN_DATA],

      // Public intents
      COMPANY_POLICY: [Permission.VIEW_PUBLIC_POLICY],
      GREETING: [Permission.VIEW_PUBLIC_POLICY],
      HELP: [Permission.VIEW_PUBLIC_POLICY],

      // HR Manager intents
      COMPANY_SALARY_TOTAL: [Permission.VIEW_ALL_DATA],
      EMPLOYEE_COUNT: [Permission.VIEW_STATISTICS],
      CONTRACT_EXPIRING: [Permission.VIEW_ALL_DATA],
      DEPARTMENT_STATS: [Permission.VIEW_STATISTICS],
      ATTENDANCE_REPORT: [Permission.VIEW_ALL_DATA],
      DEPARTMENT_INFO: [Permission.VIEW_ALL_DATA],

      // Admin intents
      SYSTEM_STATUS: [Permission.VIEW_SYSTEM],
      USER_ACTIVITY: [Permission.VIEW_SYSTEM],
      AUDIT_LOGS: [Permission.VIEW_AUDIT],
    };

    const required = intentPermissions[intentType] || [];
    if (required.length === 0) return true; // Unknown intent = allow

    return required.every((p) => permissions.includes(p));
  }

  private getRoleLabel(role?: string): string {
    const labels: Record<string, string> = {
      EMPLOYEE: 'Employee',
      MANAGER: 'Department Manager',
      HR_MANAGER: 'HR Manager',
      ADMIN: 'Administrator',
    };

    return labels[role || 'EMPLOYEE'] || 'Employee';
  }

  // HR/ADMIN handler methods (simplified for fallback)
  private async handleCompanySalaryTotal(
    context: ChatContext,
    params: any,
  ): Promise<string> {
    const now = new Date();
    const month = params.month || now.getMonth() + 1;
    const year = now.getFullYear();

    const payroll = await this.prisma.payroll.findFirst({
      where: { month, year },
      include: {
        _count: { select: { items: true } },
      },
    });

    if (!payroll) {
      return `No salary information for ${month}/${year}.`;
    }

    return (
      `💰 **Company Total Salary for ${month}/${year}:**\n\n` +
      `• Total Cost: **${Number(payroll.totalAmount).toLocaleString('en-US')} VND**\n` +
      `• Employee Count: **${payroll._count.items}** employees\n` +
      `• Average: **${(Number(payroll.totalAmount) / payroll._count.items).toLocaleString('en-US')} VND/employee**\n` +
      `• Status: ${payroll.status === 'LOCKED' ? '✅ Finalized' : '⏳ Processing'}`
    );
  }

  private async handleEmployeeCount(context: ChatContext): Promise<string> {
    const total = await this.prisma.employee.count();
    const active = await this.prisma.employee.count({
      where: { status: 'ACTIVE' },
    });
    const inactive = await this.prisma.employee.count({
      where: { status: 'INACTIVE' },
    });

    return (
      `👥 **Employee Statistics:**\n\n` +
      `• Total Employees: **${total}**\n` +
      `• Active: **${active}**\n` +
      `• Inactive: **${inactive}**\n\n` +
      `📊 Active Rate: **${((active / total) * 100).toFixed(1)}%**`
    );
  }

  private async handleContractExpiring(context: ChatContext): Promise<string> {
    const now = new Date();
    const thirtyDaysLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const contracts = await this.prisma.contract.findMany({
      where: {
        status: 'ACTIVE',
        endDate: { gte: now, lte: thirtyDaysLater },
      },
      include: {
        employee: {
          select: { fullName: true, employeeCode: true },
        },
      },
      take: 10,
    });

    if (contracts.length === 0) {
      return '✅ **No contracts expiring in the next 30 days.**';
    }

    let response = `⚠️ **Expiring Contracts (Next 30 days):**\n\n`;
    response += `Total: **${contracts.length}** contracts\n\n`;

    contracts.forEach((c, index) => {
      const daysLeft = Math.ceil(
        (c.endDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      response += `${index + 1}. **${c.employee.fullName}** (${c.employee.employeeCode})\n`;
      response += `   • Type: ${c.contractType}\n`;
      response += `   • Expires: ${c.endDate?.toLocaleDateString('en-US')} (${daysLeft} days left)\n\n`;
    });

    return response;
  }

  private async handleDepartmentStats(context: ChatContext): Promise<string> {
    const departments = await this.prisma.department.findMany({
      include: {
        _count: {
          select: { employees: true },
        },
      },
      orderBy: {
        employees: {
          _count: 'desc',
        },
      },
    });

    let response = '🏢 **Department Statistics:**\n\n';
    const totalEmployees = departments.reduce(
      (sum, d) => sum + d._count.employees,
      0,
    );

    departments.forEach((dept, index) => {
      const percentage =
        totalEmployees > 0
          ? ((dept._count.employees / totalEmployees) * 100).toFixed(1)
          : '0';
      response += `${index + 1}. **${dept.name}** (${dept.code})\n`;
      response += `   • Employees: ${dept._count.employees} (${percentage}%)\n`;
      if (dept.managerId) {
        response += `   • Manager: Yes\n`;
      }
      response += `\n`;
    });

    response += `\n📊 **Total: ${totalEmployees} employees in ${departments.length} departments**`;

    return response;
  }

  private async handleAttendanceReport(
    context: ChatContext,
    params: any,
  ): Promise<string> {
    const now = new Date();
    const month = params.month || now.getMonth() + 1;
    const year = now.getFullYear();
    const startDate = new Date(Date.UTC(year, month - 1, 1));
    const endDate = new Date(Date.UTC(year, month, 0));

    const attendances = await this.prisma.attendance.findMany({
      where: {
        date: { gte: startDate, lte: endDate },
      },
    });

    const totalRecords = attendances.length;
    const present = attendances.filter((a) => a.status === 'PRESENT').length;
    const absent = attendances.filter((a) => a.status === 'ABSENT').length;
    const late = attendances.filter((a) => a.isLate).length;
    const earlyLeave = attendances.filter((a) => a.isEarlyLeave).length;

    const uniqueEmployees = new Set(attendances.map((a) => a.employeeId)).size;

    return (
      `📊 **Company-wide Attendance Report - ${month}/${year}:**\n\n` +
      `• Total records: **${totalRecords}**\n` +
      `• Employees: **${uniqueEmployees}**\n` +
      `• Present: **${present}** (${((present / totalRecords) * 100).toFixed(1)}%)\n` +
      `• Absent: **${absent}** (${((absent / totalRecords) * 100).toFixed(1)}%)\n` +
      `• Late: **${late}** times\n` +
      `• Early Leave: **${earlyLeave}** times\n\n` +
      `📈 **Attendance Rate: ${((present / totalRecords) * 100).toFixed(1)}%**`
    );
  }

  private async handleSystemStatus(context: ChatContext): Promise<string> {
    return 'This function is being processed by AI. Please try again.';
  }

  private async handleUserActivity(context: ChatContext): Promise<string> {
    return 'This function is being processed by AI. Please try again.';
  }

  private async handleAuditLogs(context: ChatContext): Promise<string> {
    return 'This function is being processed by AI. Please try again.';
  }
}
