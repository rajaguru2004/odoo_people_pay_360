import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType } from '../../notifications/dto/create-notification.dto';
import {
  type ReminderCandidate,
  type ReminderRecipient,
  type ReminderSource,
} from '../reminder-source';

const CONTRACT_ALERT_RECIPIENT_ROLES = ['ADMIN', 'HR_MANAGER'];

/**
 * Employment-contract expiry. Replaces the `contract-expiry-alerts` cron that
 * used to live in ContractsService; `autoExpireContracts` stays there.
 */
@Injectable()
export class ContractReminderSource implements ReminderSource {
  readonly key = 'contract';
  readonly thresholdSettingKey = 'reminder_days_contract';
  readonly defaultThresholds = [90, 60, 30, 7];
  readonly notificationType = NotificationType.CONTRACT_EXPIRING;

  constructor(private readonly prisma: PrismaService) {}

  async findExpiring(from: Date, to: Date): Promise<ReminderCandidate[]> {
    const contracts = await this.prisma.contract.findMany({
      where: {
        status: 'ACTIVE',
        endDate: { not: null, gte: from, lte: to },
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
            department: { select: { name: true } },
            user: { select: { id: true, email: true, isActive: true } },
          },
        },
      },
    });

    return contracts.map((c) => ({
      id: c.id,
      // Narrowed by the `not: null` filter above.
      expiryDate: c.endDate as Date,
      entityLabel: 'Employment contract',
      subjectName: c.employee.fullName,
      link: `/dashboard/contracts`,
      fields: [
        { label: 'Employee', value: c.employee.fullName },
        { label: 'Employee code', value: c.employee.employeeCode },
        { label: 'Department', value: c.employee.department?.name ?? '—' },
        { label: 'Contract type', value: c.contractType ?? '—' },
      ],
      ownerUserId: c.employee.user?.isActive ? c.employee.user.id : null,
      ownerEmail: c.employee.user?.isActive ? c.employee.user.email : null,
    }));
  }

  async recipients(candidate: ReminderCandidate): Promise<ReminderRecipient[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: { in: CONTRACT_ALERT_RECIPIENT_ROLES }, isActive: true },
      select: { id: true, email: true, employee: { select: { fullName: true } } },
    });

    const list: ReminderRecipient[] = admins.map((u) => ({
      userId: u.id,
      email: u.email,
      name: u.employee?.fullName || 'there',
      isOwner: false,
    }));

    // The legacy contract cron notified HR only. The employee is added here for
    // parity with the visa flow — both are their own record.
    if (
      candidate.ownerUserId &&
      candidate.ownerEmail &&
      !list.some((r) => r.userId === candidate.ownerUserId)
    ) {
      list.push({
        userId: candidate.ownerUserId,
        email: candidate.ownerEmail,
        name: candidate.subjectName,
        isOwner: true,
      });
    }
    return list;
  }
}
