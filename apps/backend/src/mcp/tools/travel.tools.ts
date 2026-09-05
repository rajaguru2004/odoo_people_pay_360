import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { TravelService } from '../../travel/travel.service';
import { TRAVEL_STATUSES } from '../../travel/dto/query-travel.dto';
import { TRAVEL_TYPES } from '../../travel/dto/create-travel-request.dto';
import { DomainToolProvider, McpToolDef } from '../tool.types';

@Injectable()
export class TravelTools implements DomainToolProvider {
  constructor(
    private readonly travel: TravelService,
    private readonly prisma: PrismaService,
  ) {}

  private async tripPreview(action: string, id: string, extra?: Record<string, unknown>) {
    const trip = await this.prisma.travelRequest.findUnique({
      where: { id },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
    });
    if (!trip) return { action, id, warning: 'Travel request not found' };
    return {
      action,
      trip: {
        id: trip.id,
        employee: `${trip.employee.fullName} (${trip.employee.employeeCode})`,
        destination: trip.destination,
        travelType: trip.travelType,
        departureDate: trip.departureDate,
        returnDate: trip.returnDate,
        estimatedCost: trip.estimatedCost,
        status: trip.status,
      },
      ...extra,
    };
  }

  getTools(): McpToolDef[] {
    return [
      {
        name: 'travel_list',
        description:
          'List travel requests with filters (status, employee, domestic/international, departure window). Managers see their own departments.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          status: z.enum(TRAVEL_STATUSES).optional(),
          employeeId: z.string().uuid().optional(),
          travelType: z.enum(TRAVEL_TYPES).optional(),
          from: z.string().optional().describe('Departure on/after, YYYY-MM-DD'),
          to: z.string().optional().describe('Departure on/before, YYYY-MM-DD'),
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        auditResourceType: 'TravelRequest',
        execute: (a, user) => this.travel.findAll(a as any, user),
      },

      {
        name: 'travel_get',
        description:
          'Get one travel request with its itinerary and every expense claim it spawned.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'TravelRequest',
        resourceIdArg: 'id',
        execute: (a) => this.travel.findOne(a.id as string),
      },

      {
        name: 'travel_my_requests',
        description: 'Travel requests raised by an employee. Employees see only their own.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: { employeeId: z.string().uuid() },
        auditResourceType: 'TravelRequest',
        execute: (a) => this.travel.findByEmployee(a.employeeId as string),
      },

      {
        name: 'travel_on_trip',
        description:
          'Who is away in a date window — approved trips overlapping the range. Read-only: a trip is not leave and never affects attendance or payroll days.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          from: z.string().describe('YYYY-MM-DD'),
          to: z.string().describe('YYYY-MM-DD'),
        },
        auditResourceType: 'TravelRequest',
        execute: (a, user) =>
          this.travel.findOnTrip(
            new Date(a.from as string),
            new Date(a.to as string),
            user.role === 'MANAGER' ? (user as any).managedDepartmentIds : undefined,
          ),
      },

      {
        name: 'travel_create',
        description:
          'Raise a trip request. On final approval this automatically creates a per-diem expense claim (an ordinary reimbursement), a cash advance in the loans ledger when advanceAmount is set, and alerts HR if an international trip has no covering visa. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid(),
          purpose: z.string(),
          travelType: z.enum(TRAVEL_TYPES),
          destination: z
            .string()
            .max(200)
            .describe('PER_DIEM_DESTINATION library label; its rate is snapshotted now'),
          country: z.string().max(100).optional().describe('Required for INTERNATIONAL'),
          departureDate: z.string().describe('YYYY-MM-DD'),
          returnDate: z.string().describe('YYYY-MM-DD'),
          perDiemDays: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Defaults to the inclusive day count of the trip'),
          estimatedCost: z.number().min(0),
          advanceAmount: z
            .number()
            .min(0)
            .optional()
            .describe('Cash advance, recovered through the existing loans ledger'),
        },
        auditResourceType: 'TravelRequest',
        preview: async (a) => {
          const destination = await this.prisma.libraryItem.findFirst({
            where: {
              libraryType: 'PER_DIEM_DESTINATION',
              label: a.destination as string,
            },
            select: { perDiemRate: true },
          });
          return {
            action: 'Raise travel request',
            destination: a.destination,
            dates: `${a.departureDate} → ${a.returnDate}`,
            estimatedCost: a.estimatedCost,
            perDiemRate: destination?.perDiemRate ?? 'no rate configured',
            advanceAmount: a.advanceAmount ?? 0,
          };
        },
        execute: (a, user) =>
          this.travel.create(a.employeeId as string, a as any, user),
      },

      {
        name: 'travel_approve',
        description:
          'Approve a travel request. On the final approval step this spawns the per-diem claim and any advance. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          id: z.string().uuid(),
          remarks: z.string().optional(),
        },
        auditResourceType: 'TravelRequest',
        resourceIdArg: 'id',
        preview: (a) => this.tripPreview('Approve travel request', a.id as string),
        execute: (a, user) =>
          this.travel.decide(a.id as string, user, 'APPROVE', a as any),
      },

      {
        name: 'travel_reject',
        description: 'Reject a travel request. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          id: z.string().uuid(),
          remarks: z.string().optional().describe('Rejection reason'),
        },
        auditResourceType: 'TravelRequest',
        resourceIdArg: 'id',
        preview: (a) => this.tripPreview('Reject travel request', a.id as string),
        execute: (a, user) =>
          this.travel.decide(a.id as string, user, 'REJECT', a as any),
      },

      {
        name: 'travel_cancel',
        description:
          'Cancel a travel request and withdraw the expense claims it spawned. Claims already linked to a payroll item are left alone — reversing paid money belongs in payroll. Requires confirm:true.',
        kind: 'destructive',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { id: z.string().uuid() },
        auditResourceType: 'TravelRequest',
        resourceIdArg: 'id',
        preview: async (a) => {
          const claims = await this.prisma.reimbursement.findMany({
            where: { sourceType: 'TRAVEL', sourceId: a.id as string },
            select: { id: true, amount: true, status: true, payrollItemId: true },
          });
          return this.tripPreview('Cancel travel request', a.id as string, {
            claimsToWithdraw: claims.filter(
              (c) => !c.payrollItemId && ['PENDING', 'APPROVED'].includes(c.status),
            ).length,
            claimsUntouchedInPayroll: claims.filter((c) => c.payrollItemId).length,
          });
        },
        execute: (a, user) => this.travel.cancel(a.id as string, user),
      },
    ];
  }
}
