import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditService } from './audit.service';
import { AUDIT_RESOURCE_KEY } from './audit-resource.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { extractRequestMeta } from '../common/utils/request-meta.util';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const method = request.method;

    // Only audit write methods: POST, PUT, PATCH, DELETE
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return next.handle();
    }

    const target = context.getClass();
    const resourceType = this.reflector.get<string>(AUDIT_RESOURCE_KEY, target);

    // If no resource type is set, don't audit
    if (!resourceType) {
      return next.handle();
    }

    const user = request.user;
    // Extraction and IPv6 normalisation moved to request-meta.util when login
    // alerts became a second consumer. Same rules, one copy.
    const { ip: ipAddress, userAgent } = extractRequestMeta(request);

    let action = 'CREATE';
    if (method === 'PATCH' || method === 'PUT') {
      action = 'UPDATE';
    } else if (method === 'DELETE') {
      action = 'DELETE';
    }

    // Try to get resource ID from route params (if present, e.g. for UPDATE/DELETE)
    let resourceId = request.params?.id || request.params?.empId || request.params?.userId || request.params?.batchId;

    // Fetch original/old state of record if modifying or deleting
    let oldData = null;
    if (['PATCH', 'PUT', 'DELETE'].includes(method) && resourceId) {
      try {
        const modelName = this.getPrismaModelName(resourceType);
        if (this.prisma[modelName]) {
          const oldRecord = await this.prisma[modelName].findUnique({
            where: { id: resourceId },
          });
          if (oldRecord) {
            oldData = this.sanitize(oldRecord);
          }
        }
      } catch (err) {
        this.logger.warn(`Failed to fetch old record for audit log resource ${resourceType}: ${err.message}`);
      }
    }

    const requestBody = request.body ? this.sanitize(request.body) : null;

    return next.handle().pipe(
      tap({
        next: (response) => {
          // If action is CREATE and response contains an ID, use it
          if (action === 'CREATE' && !resourceId) {
            resourceId = response?.data?.id || response?.id;
          }

          let newData = null;
          if (action === 'CREATE') {
            newData = response?.data ? this.sanitize(response.data) : requestBody;
          } else if (action === 'UPDATE') {
            newData = requestBody;
          }

          // Asynchronously log the audit entry without waiting/blocking
          void this.auditService.log({
            userId: user?.id,
            action,
            resourceType,
            resourceId,
            oldData,
            newData,
            // `log()` takes optionals; the extractor returns nulls.
            ipAddress: ipAddress ?? undefined,
            userAgent: userAgent ?? undefined,
            branchId: request.branchContext?.effectiveBranchId ?? null,
          });
        },
      }),
    );
  }

  private getPrismaModelName(resourceType: string): string {
    const mapping: Record<string, string> = {
      Employee: 'employee',
      Department: 'department',
      Contract: 'contract',
      LeaveRequest: 'leaveRequest',
      Attendance: 'attendance',
      AttendanceCorrection: 'attendanceCorrection',
      OvertimeRequest: 'overtimeRequest',
      Payroll: 'payroll',
      PayrollBatch: 'payrollBatch',
      Reward: 'reward',
      Discipline: 'discipline',
      SalaryComponent: 'salaryComponent',
      Timesheet: 'timesheet',
      Task: 'task',
      WorkLog: 'workLog',
      User: 'user',
      Holiday: 'holiday',
      Team: 'team',
    };
    return mapping[resourceType] || (resourceType.charAt(0).toLowerCase() + resourceType.slice(1));
  }

  private sanitize(data: any): any {
    if (!data) return data;
    if (typeof data !== 'object') return data;
    try {
      const sanitized = JSON.parse(JSON.stringify(data));
      const sensitiveKeys = [
        'password',
        'passwordhash',
        'token',
        'accesstoken',
        'refreshtoken',
        'secret',
        'password_hash',
      ];
      const sanitizeObject = (obj: any) => {
        for (const key in obj) {
          if (sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
            obj[key] = '[REDACTED]';
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            sanitizeObject(obj[key]);
          }
        }
      };
      sanitizeObject(sanitized);
      return sanitized;
    } catch {
      return '[UNPARSABLE DATA]';
    }
  }
}
