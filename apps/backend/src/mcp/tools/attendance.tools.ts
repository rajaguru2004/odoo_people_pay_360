import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AttendanceCorrectionsService } from '../../attendance-corrections/attendance-corrections.service';
import { AttendancesService } from '../../attendances/attendances.service';
import { ChannelVerificationTokenService } from '../../common/verification/channel-verification-token.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

const month = z.number().int().min(1).max(12);
const year = z.number().int().min(2020).max(2100);

/**
 * A RECEIPT id, not an assertion.
 *
 * It is worthless on its own: `spendFaceProof` only returns true when a
 * server-side row says a real descriptor match happened — for THIS employee, on
 * THIS actor channel, for THIS purpose, before the row expired, and not already
 * spent. So a caller can pass any uuid it likes and still get `byFace: false`.
 *
 * This is what lets `byFace` be reachable from a channel at all. It was a
 * hardcoded `false` here, and zod strips unknown keys, so there was previously
 * no wire path to it whatsoever — that property is preserved, because what
 * crosses the wire is still not the boolean.
 */
const faceProofId = z
  .string()
  .uuid()
  .optional()
  .describe('Receipt from a completed face verification. Validated server-side.');

@Injectable()
export class AttendanceTools implements DomainToolProvider {
  constructor(
    private readonly attendances: AttendancesService,
    private readonly corrections: AttendanceCorrectionsService,
    private readonly proofs: ChannelVerificationTokenService,
  ) {}

  getTools(): McpToolDef[] {
    return [
      {
        name: 'attendance_employee_history',
        description:
          'Get attendance records of an employee for a month (defaults to current). Employees always get their own.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          month: month.optional(),
          year: year.optional(),
        },
        auditResourceType: 'Attendance',
        resourceIdArg: 'employeeId',
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.attendances.getEmployeeAttendances(employeeId, a.month, a.year);
        },
      },
      {
        name: 'attendance_monthly_report',
        description: 'Company attendance report for a month (presence, late, hours per employee).',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: { month, year },
        auditResourceType: 'Attendance',
        execute: (a) => this.attendances.getMonthlyReport(a.month, a.year),
      },
      {
        name: 'attendance_manual_create',
        description:
          'Create a manual attendance record for an employee (date YYYY-MM-DD, times HH:MM). Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          employeeId: z.string().uuid(),
          date: z.string().describe('YYYY-MM-DD'),
          checkIn: z.string().optional().describe('HH:MM or ISO timestamp'),
          checkOut: z.string().optional().describe('HH:MM or ISO timestamp'),
          status: z.enum(['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY']).optional(),
          notes: z.string().max(500).optional(),
        },
        auditResourceType: 'Attendance',
        resourceIdArg: 'employeeId',
        // Service takes dto:any (no controller DTO validation in this path) —
        // the zod shape above is the whitelist.
        execute: (a) => this.attendances.createManualAttendance(a),
      },
      {
        name: 'attendance_correction_pending_list',
        description: 'List attendance correction requests waiting for review.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {},
        auditResourceType: 'AttendanceCorrection',
        execute: () => this.corrections.findPending(),
      },
      {
        name: 'attendance_correction_approve',
        description: 'Approve an attendance correction request. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          notes: z.string().max(500).optional(),
        },
        auditResourceType: 'AttendanceCorrection',
        resourceIdArg: 'id',
        preview: (a) => this.correctionPreview('Approve attendance correction', a.id),
        execute: (a, user) => this.corrections.approve(a.id, user.id, { notes: a.notes }),
      },
      {
        name: 'attendance_correction_reject',
        description: 'Reject an attendance correction request with a reason. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          rejectedReason: z.string().min(1).max(500),
        },
        auditResourceType: 'AttendanceCorrection',
        resourceIdArg: 'id',
        preview: (a) => this.correctionPreview('Reject attendance correction', a.id),
        execute: (a, user) =>
          this.corrections.reject(a.id, user.id, { rejectedReason: a.rejectedReason }),
      },
      {
        name: 'attendance_correction_create',
        description:
          "Request a correction to the caller's own attendance for a past date. " +
          'Times are ISO timestamps. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          date: z.string().describe('YYYY-MM-DD'),
          requestedCheckIn: z.string().optional().describe('ISO timestamp'),
          requestedCheckOut: z.string().optional().describe('ISO timestamp'),
          reason: z.string().min(1).max(500),
        },
        auditResourceType: 'AttendanceCorrection',
        resourceIdArg: 'employeeId',
        preview: async (a, user) => ({
          action: 'Request attendance correction',
          employeeId: a.employeeId ?? user.employeeId,
          date: a.date,
          requestedCheckIn: a.requestedCheckIn,
          requestedCheckOut: a.requestedCheckOut,
          reason: a.reason,
        }),
        // The service owns the monthly self-service limit, so a chat request
        // inherits exactly the same allowance as a web one.
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.corrections.create(employeeId, {
            date: a.date,
            requestedCheckIn: a.requestedCheckIn,
            requestedCheckOut: a.requestedCheckOut,
            reason: a.reason,
          } as any);
        },
      },
      // ---------------------------------------------------------- self-service
      // Punching in and out was previously reachable only over HTTP, which meant
      // the copilot and any non-web channel could read attendance but not record
      // it. These wrap the same service methods the web controller uses, so
      // geofencing, face-only enforcement, multi-session rules and the day
      // boundary all behave identically.
      {
        name: 'attendance_check_in',
        description:
          'Record the start of the caller\'s working day. Optional coordinates satisfy branch geofencing.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
          faceProofId,
        },
        auditResourceType: 'Attendance',
        resourceIdArg: 'employeeId',
        preview: async (a, user) => ({
          action: 'Check in',
          employeeId: a.employeeId ?? user.employeeId,
          withLocation: a.latitude !== undefined && a.longitude !== undefined,
        }),
        execute: async (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          const coords =
            a.latitude !== undefined && a.longitude !== undefined
              ? { latitude: a.latitude, longitude: a.longitude }
              : undefined;
          // Spend commits before checkIn runs, and checkIn can still refuse
          // (geofence). There is no transaction spanning the two, which is
          // exactly why the caller's failure path calls release() — that
          // clears proofSpentAt so a retry does not demand a fresh selfie.
          const byFace = await this.proofs.spendFaceProof(a.faceProofId, employeeId, 'CHECKIN');
          return this.attendances.checkIn(employeeId, byFace, coords, false);
        },
      },
      {
        name: 'attendance_check_out',
        description: "Record the end of the caller's working day.",
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          // Optional, and validated only when present: the portal has never
          // sent a checkout position. The chat verification link always
          // collects one, which is what makes a chat checkout range-checked.
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
          faceProofId,
        },
        auditResourceType: 'Attendance',
        resourceIdArg: 'employeeId',
        preview: async (a, user) => ({
          action: 'Check out',
          employeeId: a.employeeId ?? user.employeeId,
        }),
        execute: async (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          const coords =
            a.latitude !== undefined && a.longitude !== undefined
              ? { latitude: a.latitude, longitude: a.longitude }
              : undefined;
          const byFace = await this.proofs.spendFaceProof(a.faceProofId, employeeId, 'CHECKOUT');
          return this.attendances.checkOut(employeeId, byFace, coords);
        },
      },
      {
        name: 'attendance_today_status',
        description:
          "Today's attendance for the caller: whether checked in, times so far, and hours worked.",
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
        },
        auditResourceType: 'Attendance',
        resourceIdArg: 'employeeId',
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.attendances.getTodayAttendance(employeeId);
        },
      },
      {
        name: 'attendance_lunch_start',
        description: 'Start the caller\'s lunch break.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          faceProofId,
        },
        auditResourceType: 'Attendance',
        resourceIdArg: 'employeeId',
        preview: async (a, user) => ({
          action: 'Start lunch break',
          employeeId: a.employeeId ?? user.employeeId,
        }),
        // Starting lunch is checking OUT, hence the LUNCH_OUT purpose. The
        // tool names read from the employee's point of view; the service's
        // read from the clock's.
        execute: async (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          const byFace = await this.proofs.spendFaceProof(a.faceProofId, employeeId, 'LUNCH_OUT');
          return this.attendances.lunchCheckOut(employeeId, byFace);
        },
      },
      {
        name: 'attendance_lunch_end',
        description: 'End the caller\'s lunch break.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
          faceProofId,
        },
        auditResourceType: 'Attendance',
        resourceIdArg: 'employeeId',
        preview: async (a, user) => ({
          action: 'End lunch break',
          employeeId: a.employeeId ?? user.employeeId,
        }),
        execute: async (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          const byFace = await this.proofs.spendFaceProof(a.faceProofId, employeeId, 'LUNCH_IN');
          return this.attendances.lunchCheckIn(employeeId, byFace);
        },
      },
      {
        name: 'attendance_lunch_status',
        description: 'Whether the caller is currently on a lunch break, and how long is left.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: {
          employeeId: z.string().uuid().optional().describe('Defaults to the caller'),
        },
        auditResourceType: 'Attendance',
        resourceIdArg: 'employeeId',
        execute: (a, user) => {
          const employeeId = a.employeeId ?? user.employeeId;
          if (!employeeId) throw new Error('employeeId is required');
          return this.attendances.getLunchBreakStatus(employeeId);
        },
      },
    ];
  }

  private async correctionPreview(action: string, id: string) {
    const r: any = await this.corrections.findOne(id);
    const d = r?.data ?? r;
    return {
      action,
      correction: {
        id,
        employee: d?.employee?.fullName,
        date: d?.date,
        requestedCheckIn: d?.requestedCheckIn,
        requestedCheckOut: d?.requestedCheckOut,
        reason: d?.reason,
        currentStatus: d?.status,
      },
    };
  }
}
