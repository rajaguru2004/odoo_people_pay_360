import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AnalyticsService } from '../../analytics/analytics.service';
import { DomainToolProvider, McpToolDef, Role } from '../tool.types';

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
  .describe('YYYY-MM-DD');

const HR_ROLES: Role[] = ['ADMIN', 'HR_MANAGER', 'MANAGER'];

/**
 * Read-only, period-bounded per-employee performance aggregates. Added for the
 * AI Appraisal agent (which needs date-range summaries rather than the
 * month-scoped operational tools), but available to the interactive copilot too.
 */
@Injectable()
export class AnalyticsTools implements DomainToolProvider {
  constructor(private readonly analytics: AnalyticsService) {}

  getTools(): McpToolDef[] {
    const period = {
      employeeId: z.string().uuid(),
      startDate: dateStr,
      endDate: dateStr,
    };
    const parse = (a: any) => ({
      employeeId: a.employeeId as string,
      from: new Date(`${a.startDate}T00:00:00.000Z`),
      to: new Date(`${a.endDate}T23:59:59.999Z`),
    });

    const def = (
      name: string,
      description: string,
      auditResourceType: string,
      execute: (a: any) => Promise<unknown>,
    ): McpToolDef => ({
      name,
      description,
      kind: 'read',
      roles: HR_ROLES,
      inputSchema: { ...period },
      auditResourceType,
      resourceIdArg: 'employeeId',
      execute,
    });

    return [
      def(
        'attendance_employee_summary',
        'Attendance aggregate for one employee over a date range: present/absent/late days, hours, attendance and punctuality rates.',
        'Attendance',
        (a) => this.analytics.attendanceSummary(parse(a)),
      ),
      def(
        'leave_employee_summary',
        'Leave aggregate for one employee over a date range: approved/rejected/pending requests, days by type, yearly balances.',
        'LeaveRequest',
        (a) => this.analytics.leaveSummary(parse(a)),
      ),
      def(
        'overtime_employee_summary',
        'Overtime aggregate for one employee over a date range: approved hours split into regular/late/double tiers, food allowance.',
        'OvertimeRequest',
        (a) => this.analytics.overtimeSummary(parse(a)),
      ),
      def(
        'timesheet_employee_summary',
        'Timesheet discipline for one employee over a date range: submitted/approved/rejected entries, hours, approval rate, days covered.',
        'Timesheet',
        (a) => this.analytics.timesheetSummary(parse(a)),
      ),
      def(
        'conduct_records_get',
        'Rewards and disciplinary records for one employee over a date range (counts, amounts, recent entries).',
        'Employee',
        (a) => this.analytics.conductRecords(parse(a)),
      ),
      {
        name: 'team_membership_get',
        description:
          'Active team memberships for one employee: teams, roles, allocation percentages, lead roles.',
        kind: 'read',
        roles: HR_ROLES,
        inputSchema: { employeeId: z.string().uuid() },
        auditResourceType: 'Employee',
        resourceIdArg: 'employeeId',
        execute: (a) => this.analytics.teamMembership(a.employeeId),
      },
    ];
  }
}
