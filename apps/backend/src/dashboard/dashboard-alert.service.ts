import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export enum AlertSeverity {
  HIGH = 'HIGH', // ≤ 7 days
  MEDIUM = 'MEDIUM', // ≤ 15 days
  LOW = 'LOW', // ≤ 30 days
  INFO = 'INFO', // ≤ 60 days
}

export interface DashboardAlert {
  contractId: string;
  employeeName: string;
  employeeCode: string;
  contractNumber: string | null;
  contractType: string;
  expirationDate: Date;
  daysRemaining: number;
  severity: AlertSeverity;
}

@Injectable()
export class DashboardAlertService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get contracts expiring within specified days
   * @param days Number of days to look ahead (default: 60)
   * @returns Array of expiring contracts
   */
  async getExpiringContracts(days: number = 60): Promise<DashboardAlert[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const futureDate = new Date(today);
    futureDate.setDate(today.getDate() + days);

    const contracts = await this.prisma.contract.findMany({
      where: {
        status: 'ACTIVE',
        endDate: {
          not: null,
          gte: today,
          lte: futureDate,
        },
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            email: true,
            position: true,
            department: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: {
        endDate: 'asc',
      },
    });

    return contracts.map((contract) => {
      const daysRemaining = this.calculateDaysRemaining(
        today,
        contract.endDate!,
      );
      const severity = this.getAlertSeverity(daysRemaining);

      return {
        contractId: contract.id,
        employeeName: contract.employee.fullName,
        employeeCode: contract.employee.employeeCode,
        contractNumber: contract.contractNumber,
        contractType: contract.contractType,
        expirationDate: contract.endDate!,
        daysRemaining,
        severity,
      };
    });
  }

  /**
   * Get dashboard alerts for a specific user
   * @param userId User ID (for future role-based filtering)
   * @returns Dashboard alerts with all relevant information
   */
  async getDashboardAlerts(userId?: string): Promise<{
    total: number;
    bySeverity: Record<AlertSeverity, number>;
    alerts: DashboardAlert[];
  }> {
    const alerts = await this.getExpiringContracts(60);

    // Count by severity
    const bySeverity: Record<AlertSeverity, number> = {
      [AlertSeverity.HIGH]: 0,
      [AlertSeverity.MEDIUM]: 0,
      [AlertSeverity.LOW]: 0,
      [AlertSeverity.INFO]: 0,
    };

    alerts.forEach((alert) => {
      bySeverity[alert.severity]++;
    });

    return {
      total: alerts.length,
      bySeverity,
      alerts,
    };
  }

  /**
   * Calculate alert severity based on days remaining
   * Property 7: Alert Severity Calculation
   * @param daysRemaining Number of days until expiration
   * @returns Alert severity level
   */
  getAlertSeverity(daysRemaining: number): AlertSeverity {
    if (daysRemaining <= 7) {
      return AlertSeverity.HIGH;
    } else if (daysRemaining <= 15) {
      return AlertSeverity.MEDIUM;
    } else if (daysRemaining <= 30) {
      return AlertSeverity.LOW;
    } else {
      return AlertSeverity.INFO;
    }
  }

  /**
   * Calculate days remaining between two dates
   * @param fromDate Start date
   * @param toDate End date
   * @returns Number of days remaining
   */
  private calculateDaysRemaining(fromDate: Date, toDate: Date): number {
    const diffTime = toDate.getTime() - fromDate.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  }

  /**
   * Get color code for severity level (for UI)
   * @param severity Alert severity
   * @returns Color code
   */
  getSeverityColor(severity: AlertSeverity): string {
    switch (severity) {
      case AlertSeverity.HIGH:
        return 'red';
      case AlertSeverity.MEDIUM:
        return 'orange';
      case AlertSeverity.LOW:
        return 'yellow';
      case AlertSeverity.INFO:
        return 'blue';
      default:
        return 'gray';
    }
  }

  /**
   * Get English label for severity
   * @param severity Alert severity
   * @returns English label
   */
  getSeverityLabel(severity: AlertSeverity): string {
    switch (severity) {
      case AlertSeverity.HIGH:
        return 'High';
      case AlertSeverity.MEDIUM:
        return 'Medium';
      case AlertSeverity.LOW:
        return 'Low';
      case AlertSeverity.INFO:
        return 'Info';
      default:
        return 'Unknown';
    }
  }
}
