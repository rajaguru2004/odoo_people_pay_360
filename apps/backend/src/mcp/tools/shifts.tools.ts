import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CalendarService } from '../../calendar/calendar.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

@Injectable()
export class ShiftTools implements DomainToolProvider {
  constructor(private readonly calendar: CalendarService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'shift_create',
        description:
          'Assign a work schedule (shift) to an employee for a date. FLEXIBLE shifts use requiredHours instead of start/end times. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          employeeId: z.string().uuid(),
          date: z.string().describe('YYYY-MM-DD'),
          shiftType: z.enum(['MORNING', 'AFTERNOON', 'FULL_DAY', 'NIGHT', 'CUSTOM', 'FLEXIBLE']),
          startTime: z.string().optional().describe('ISO 8601 datetime; omit for FLEXIBLE'),
          endTime: z.string().optional().describe('ISO 8601 datetime; omit for FLEXIBLE'),
          requiredHours: z.number().positive().optional().describe('Required for FLEXIBLE shifts'),
          isWorkDay: z.boolean().optional(),
          notes: z.string().max(500).optional(),
        },
        auditResourceType: 'WorkSchedule',
        execute: (a) => this.calendar.createSchedule(a as any),
      },
      {
        name: 'shift_delete',
        description: 'Delete a work schedule entry by id. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'WorkSchedule',
        resourceIdArg: 'id',
        preview: async (a) => {
          const s: any = await this.calendar.getScheduleById(a.id);
          const d = s?.data ?? s;
          return {
            action: 'Delete work schedule',
            schedule: {
              id: a.id,
              employee: d?.employee?.fullName,
              date: d?.date,
              shiftType: d?.shiftType,
            },
          };
        },
        execute: (a) => this.calendar.deleteSchedule(a.id),
      },
      {
        name: 'employee_calendar_get',
        description:
          'Get an employee calendar (shifts, leave, holidays) between two dates. Employees always get their own.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          startDate: z.string().describe('YYYY-MM-DD'),
          endDate: z.string().describe('YYYY-MM-DD'),
        },
        auditResourceType: 'WorkSchedule',
        resourceIdArg: 'employeeId',
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.calendar.getEmployeeCalendar(employeeId, a.startDate, a.endDate);
        },
      },
      {
        name: 'calendar_overview_get',
        description: 'Company-wide schedule overview between two dates (who works when).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          startDate: z.string().describe('YYYY-MM-DD'),
          endDate: z.string().describe('YYYY-MM-DD'),
        },
        auditResourceType: 'WorkSchedule',
        execute: (a) => this.calendar.getOverviewCalendar(a.startDate, a.endDate),
      },
    ];
  }
}
