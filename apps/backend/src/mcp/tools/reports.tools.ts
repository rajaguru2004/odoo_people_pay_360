import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DashboardService } from '../../dashboard/dashboard.service';
import { DepartmentsService } from '../../departments/departments.service';
import { EmployeesService } from '../../employees/employees.service';
import { LeaveBalancesService } from '../../leave-balances/leave-balances.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

@Injectable()
export class ReportTools implements DomainToolProvider {
  constructor(
    private readonly employees: EmployeesService,
    private readonly departments: DepartmentsService,
    private readonly dashboard: DashboardService,
    private readonly leaveBalances: LeaveBalancesService,
  ) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'report_headcount',
        description: 'Headcount statistics: totals, by status, by department, recent joiners/leavers.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {},
        auditResourceType: 'Employee',
        execute: () => this.employees.getStatistics(),
      },
      {
        name: 'report_org_tree',
        description: 'Organization tree: departments hierarchy with managers and headcounts.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {},
        auditResourceType: 'Department',
        execute: () => this.departments.getOrganizationTree(),
      },
      {
        name: 'report_payroll_summary',
        description: 'Payroll cost summary per month for a year (defaults to current year).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          year: z.number().int().min(2020).max(2100).optional(),
        },
        auditResourceType: 'Payroll',
        execute: (a) => this.dashboard.getPayrollSummary(a.year),
      },
      {
        name: 'report_today_snapshot',
        description:
          'Today snapshot: who is present, absent, late, on leave (optionally another date YYYY-MM-DD).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          date: z.string().optional().describe('YYYY-MM-DD, defaults to today'),
        },
        auditResourceType: 'Attendance',
        execute: (a, user) => this.dashboard.getTodaySnapshot(user, a.date),
      },
      {
        name: 'report_leave_overview',
        description: 'Company-wide leave overview for a year: balances, usage, top consumers.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          year: z.number().int().min(2020).max(2100).optional(),
        },
        auditResourceType: 'LeaveBalance',
        execute: (a) => this.leaveBalances.getCompanyLeaveOverview(a.year),
      },
    ];
  }
}
