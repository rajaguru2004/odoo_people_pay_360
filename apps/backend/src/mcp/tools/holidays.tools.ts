import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { HolidaysService } from '../../holidays/holidays.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

@Injectable()
export class HolidayTools implements DomainToolProvider {
  constructor(private readonly holidays: HolidaysService) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'holiday_list',
        description:
          'List company holidays, optionally for a year and/or a branch (branchId omitted = all-branch holidays included).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          year: z.number().int().min(2020).max(2100).optional(),
          branchId: z.string().uuid().optional(),
        },
        auditResourceType: 'Holiday',
        execute: (a) => this.holidays.findAll(a.year, a.branchId),
      },
      {
        name: 'holiday_create',
        description:
          'Create a holiday (date YYYY-MM-DD). branchId omitted = applies to all branches. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          name: z.string().min(1),
          date: z.string().describe('YYYY-MM-DD'),
          isRecurring: z.boolean().optional().describe('Rolls forward into each new year'),
          branchId: z.string().uuid().optional().describe('Omit for an all-branches holiday'),
        },
        auditResourceType: 'Holiday',
        execute: (a) => this.holidays.create(a as any),
      },
    ];
  }
}
