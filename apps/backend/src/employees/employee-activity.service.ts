import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface LogActivityDto {
  employeeId: string;
  activityType: string;
  action: string;
  description: string;
  oldValue?: any;
  newValue?: any;
  metadata?: any;
  performedBy?: string;
}

export interface GetActivitiesDto {
  employeeId: string;
  activityType?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class EmployeeActivityService {
  constructor(private prisma: PrismaService) {}

  /**
   * Log an employee activity
   */
  async logActivity(dto: LogActivityDto) {
    return this.prisma.employeeActivity.create({
      data: {
        employeeId: dto.employeeId,
        activityType: dto.activityType,
        action: dto.action,
        description: dto.description,
        oldValue: dto.oldValue,
        newValue: dto.newValue,
        metadata: dto.metadata,
        performedBy: dto.performedBy,
      },
    });
  }

  /**
   * Get employee activities with pagination and filters
   */
  async getActivities(dto: GetActivitiesDto) {
    const { employeeId, activityType, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = { employeeId };
    if (activityType) {
      where.activityType = activityType;
    }

    const [activities, total] = await Promise.all([
      this.prisma.employeeActivity.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          performer: {
            select: {
              id: true,
              email: true,
              employee: {
                select: {
                  fullName: true,
                  avatarUrl: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.employeeActivity.count({ where }),
    ]);

    return {
      success: true,
      data: activities,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get activity statistics
   */
  async getActivityStats(employeeId: string) {
    const stats = await this.prisma.employeeActivity.groupBy({
      by: ['activityType'],
      where: { employeeId },
      _count: { activityType: true },
    });

    return {
      success: true,
      data: stats.map((s) => ({
        type: s.activityType,
        count: s._count.activityType,
      })),
    };
  }
}
