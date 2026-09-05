import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(data: {
    userId?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    oldData?: any;
    newData?: any;
    ipAddress?: string;
    userAgent?: string;
    branchId?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: data.userId || null,
          action: data.action,
          resourceType: data.resourceType,
          resourceId: data.resourceId || null,
          oldData: data.oldData || null,
          newData: data.newData || null,
          ipAddress: data.ipAddress || null,
          userAgent: data.userAgent || null,
          branchId: data.branchId ?? null,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to write audit log: ${error.message}`, error.stack);
    }
  }

  async findAll(query: QueryAuditLogsDto) {
    const {
      page = 1,
      limit = 20,
      userId,
      resourceType,
      action,
      dateFrom,
      dateTo,
      search,
    } = query;

    const skip = (page - 1) * limit;
    const where: any = {};

    if (userId) {
      where.userId = userId;
    }
    if (resourceType) {
      where.resourceType = { equals: resourceType, mode: 'insensitive' };
    }
    if (action) {
      where.action = { equals: action, mode: 'insensitive' };
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        where.createdAt.gte = new Date(dateFrom);
      }
      if (dateTo) {
        where.createdAt.lte = new Date(dateTo);
      }
    }

    if (search) {
      const orConditions: any[] = [
        { userAgent: { contains: search, mode: 'insensitive' } },
        {
          user: {
            email: { contains: search, mode: 'insensitive' },
          },
        },
      ];

      // Validate if search matches UUID pattern before querying resourceId
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(search)) {
        orConditions.push({ resourceId: search });
      }

      // Check if it is a valid IP address format
      const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
      const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
      if (ipRegex.test(search) || ipv6Regex.test(search)) {
        orConditions.push({ ipAddress: search });
      }

      where.OR = orConditions;
    }

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              role: true,
              employee: {
                select: {
                  fullName: true,
                },
              },
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      success: true,
      data: logs,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getResourceTypes(): Promise<string[]> {
    const result = await this.prisma.auditLog.groupBy({
      by: ['resourceType'],
    });
    return result.map((r) => r.resourceType);
  }

  /**
   * What the log has seen in the last day, aggregated in the database.
   *
   * The System hub previously derived these in the browser from one page of
   * the log, which meant a busy day silently under-reported and the numbers
   * were only ever as wide as the page size. Counting server-side removes the
   * window entirely.
   */
  async stats(hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const [total, byAction, byResource, actors, destructive] = await Promise.all([
      this.prisma.auditLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.auditLog.groupBy({
        by: ['action'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { action: 'desc' } },
        take: 10,
      }),
      this.prisma.auditLog.groupBy({
        by: ['resourceType'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { resourceType: 'desc' } },
        take: 10,
      }),
      this.prisma.auditLog.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 5,
      }),
      this.prisma.auditLog.count({
        where: { createdAt: { gte: since }, action: { contains: 'DELETE', mode: 'insensitive' } },
      }),
    ]);

    // groupBy gives ids; the hub wants names, and five lookups is cheaper than
    // joining the whole window.
    const userIds = actors.map((a) => a.userId).filter((id): id is string => Boolean(id));
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, employee: { select: { fullName: true } } },
        })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.employee?.fullName ?? u.email]));

    return {
      success: true,
      data: {
        windowHours: hours,
        total,
        destructive,
        byAction: byAction.map((r) => ({ action: r.action, count: r._count._all })),
        byResource: byResource.map((r) => ({ resource: r.resourceType, count: r._count._all })),
        topActors: actors.map((a) => ({
          userId: a.userId,
          name: a.userId ? (nameOf.get(a.userId) ?? 'unknown') : 'system',
          count: a._count._all,
        })),
      },
    };
  }
}
