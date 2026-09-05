import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { TrainingService } from '../../training/training.service';
import { TrainingNeedsService } from '../../training/training-needs.service';
import { DomainToolProvider, McpToolDef } from '../tool.types';

const NOMINATION_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'ATTENDED',
  'NO_SHOW',
] as const;

@Injectable()
export class TrainingTools implements DomainToolProvider {
  constructor(
    private readonly training: TrainingService,
    private readonly needs: TrainingNeedsService,
    private readonly prisma: PrismaService,
  ) {}

  private async nominationPreview(action: string, id: string) {
    const n = await this.prisma.trainingNomination.findUnique({
      where: { id },
      include: {
        employee: { select: { fullName: true, employeeCode: true } },
        session: { include: { course: { select: { title: true } } } },
      },
    });
    if (!n) return { action, id, warning: 'Nomination not found' };
    return {
      action,
      nomination: {
        id: n.id,
        employee: `${n.employee.fullName} (${n.employee.employeeCode})`,
        course: n.session.course.title,
        startDate: n.session.startDate,
        cost: n.cost,
        status: n.status,
        source: n.source,
      },
    };
  }

  getTools(): McpToolDef[] {
    return [
      {
        name: 'course_list',
        description: 'List the training course catalogue.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: { activeOnly: z.boolean().optional() },
        auditResourceType: 'Course',
        execute: (a) => this.training.listCourses(a.activeOnly === true),
      },

      {
        name: 'course_create',
        description:
          'Add a course to the catalogue. Set certValidMonths so certificates from it get expiry reminders. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          code: z.string().max(50),
          title: z.string().max(200),
          category: z.string().max(100).optional(),
          provider: z.string().max(200).optional(),
          description: z.string().optional(),
          durationHours: z.number().min(0).optional(),
          defaultCost: z.number().min(0).optional(),
          certValidMonths: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Months a certificate stays valid; omit if it never expires'),
        },
        auditResourceType: 'Course',
        preview: async (a) => ({
          action: 'Add course',
          code: a.code,
          title: a.title,
          certValidMonths: a.certValidMonths ?? 'never expires',
        }),
        execute: (a, user) => this.training.createCourse(a as any, user.id),
      },

      {
        name: 'training_session_list',
        description: 'List scheduled training sessions with their confirmed seat counts.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          status: z.enum(['SCHEDULED', 'RUNNING', 'COMPLETED', 'CANCELLED']).optional(),
          from: z.string().optional().describe('Start on/after, YYYY-MM-DD'),
          to: z.string().optional().describe('Start on/before, YYYY-MM-DD'),
        },
        auditResourceType: 'TrainingSession',
        execute: (a) => this.training.listSessions(a as any),
      },

      {
        name: 'training_session_create',
        description:
          'Schedule a session of a course. Omit branchId to open it to every branch. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          courseId: z.string().uuid(),
          branchId: z.string().uuid().optional(),
          startDate: z.string().describe('YYYY-MM-DD'),
          endDate: z.string().describe('YYYY-MM-DD'),
          location: z.string().max(200).optional(),
          trainer: z.string().max(200).optional(),
          seats: z.number().int().min(1).optional(),
          costPerSeat: z.number().min(0).optional(),
        },
        auditResourceType: 'TrainingSession',
        preview: async (a) => ({
          action: 'Schedule training session',
          dates: `${a.startDate} → ${a.endDate}`,
          seats: a.seats ?? 'unlimited',
          costPerSeat: a.costPerSeat ?? 'course default',
        }),
        execute: (a, user) => this.training.createSession(a as any, user.id),
      },

      {
        name: 'training_nomination_list',
        description: 'List training nominations. Managers see their own departments.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          sessionId: z.string().uuid().optional(),
          status: z.enum(NOMINATION_STATUSES).optional(),
        },
        auditResourceType: 'TrainingNomination',
        execute: (a, user) => this.training.listNominations(a as any, user),
      },

      {
        name: 'training_my_trainings',
        description:
          "An employee's training record: nominations, attendance, scores and certificate expiry.",
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        selfScope: { param: 'employeeId', forRoles: ['EMPLOYEE', 'MANAGER'] },
        inputSchema: { employeeId: z.string().uuid() },
        auditResourceType: 'TrainingNomination',
        execute: (a) => this.training.findByEmployee(a.employeeId as string),
      },

      {
        name: 'training_needs_from_appraisal',
        description:
          'Derive training needs from a completed AI appraisal run: reads each result\'s improvement areas and recommendation, then matches them to the course catalogue. Returns SUGGESTIONS only — nobody is nominated. By default covers only COACH/PIP results; set all:true for the whole cohort.',
        kind: 'read',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          runId: z.string().uuid(),
          all: z
            .boolean()
            .optional()
            .describe('true = every result, not just COACH/PIP'),
        },
        auditResourceType: 'AppraisalRun',
        resourceIdArg: 'runId',
        execute: (a) =>
          this.needs.deriveFromRun(a.runId as string, {
            onlyDevelopmentRecommendations: a.all !== true,
          }),
      },

      {
        name: 'training_nominate',
        description:
          'Nominate an employee for a session. Pass source:"APPRAISAL" with appraisalResultId to record that this came from the appraisal engine. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER'],
        inputSchema: {
          sessionId: z.string().uuid(),
          employeeId: z.string().uuid(),
          source: z.enum(['MANUAL', 'APPRAISAL']).optional(),
          appraisalResultId: z.string().uuid().optional(),
          justification: z.string().optional(),
        },
        auditResourceType: 'TrainingNomination',
        preview: async (a) => {
          const [session, employee] = await Promise.all([
            this.prisma.trainingSession.findUnique({
              where: { id: a.sessionId as string },
              include: { course: { select: { title: true } } },
            }),
            this.prisma.employee.findUnique({
              where: { id: a.employeeId as string },
              select: { fullName: true, employeeCode: true },
            }),
          ]);
          return {
            action: 'Nominate for training',
            course: session?.course.title ?? 'Session not found',
            employee: employee
              ? `${employee.fullName} (${employee.employeeCode})`
              : 'Employee not found',
            cost: session?.costPerSeat ?? 'no cost set',
            source: a.source ?? 'MANUAL',
          };
        },
        execute: (a, user) => this.training.nominate(a as any, user),
      },

      {
        name: 'training_nomination_decide',
        description:
          'Approve or reject a training nomination. On final approval this books the seat and, when training_paid_by is EMPLOYEE, raises the expense claim. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE'],
        inputSchema: {
          id: z.string().uuid(),
          decision: z.enum(['APPROVE', 'REJECT']),
          remarks: z.string().optional(),
        },
        auditResourceType: 'TrainingNomination',
        resourceIdArg: 'id',
        preview: (a) =>
          this.nominationPreview(
            `${a.decision === 'APPROVE' ? 'Approve' : 'Reject'} nomination`,
            a.id as string,
          ),
        execute: (a, user) =>
          this.training.decide(
            a.id as string,
            user,
            a.decision as 'APPROVE' | 'REJECT',
            a as any,
          ),
      },

      {
        name: 'training_record_attendance',
        description:
          'Record attendance, score and certificate for a nomination. Certificate expiry is derived from the course validity window and feeds the expiry reminder engine. Requires confirm:true.',
        kind: 'write',
        roles: ['ADMIN', 'HR_MANAGER'],
        inputSchema: {
          id: z.string().uuid(),
          attended: z.boolean().describe('false records a NO_SHOW'),
          attendedAt: z.string().optional().describe('YYYY-MM-DD; defaults to session end'),
          score: z.number().min(0).max(100).optional(),
          passed: z.boolean().optional(),
          certificateUrl: z.string().optional(),
        },
        auditResourceType: 'TrainingNomination',
        resourceIdArg: 'id',
        preview: (a) => this.nominationPreview('Record training attendance', a.id as string),
        execute: (a, user) =>
          this.training.recordAttendance(a.id as string, a as any, user.id),
      },
    ];
  }
}
