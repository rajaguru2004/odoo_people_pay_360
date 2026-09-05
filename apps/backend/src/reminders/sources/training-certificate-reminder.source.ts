import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType } from '../../notifications/dto/create-notification.dto';
import {
  type ReminderCandidate,
  type ReminderRecipient,
  type ReminderSource,
} from '../reminder-source';

const TRAINING_ALERT_RECIPIENT_ROLES = ['ADMIN', 'HR_MANAGER'];

/**
 * Training certificate expiry — the fourth reminder registration.
 *
 * `certificateExpiry` is derived when attendance is recorded, from the course's
 * `certValidMonths`. Nothing here needs its own cron.
 */
@Injectable()
export class TrainingCertificateReminderSource implements ReminderSource {
  readonly key = 'training_certificate';
  readonly thresholdSettingKey = 'reminder_days_training_certificate';
  // A lapsed safety or compliance certificate can stop someone working, so the
  // notice window matches a visa's rather than a warranty's.
  readonly defaultThresholds = [90, 60, 30, 7];
  readonly notificationType = NotificationType.WARNING;

  constructor(private readonly prisma: PrismaService) {}

  async findExpiring(from: Date, to: Date): Promise<ReminderCandidate[]> {
    const rows = await this.prisma.trainingNomination.findMany({
      where: {
        certificateExpiry: { gte: from, lte: to },
        // Only someone who actually attended holds a certificate.
        status: 'ATTENDED',
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
        session: {
          select: { course: { select: { code: true, title: true } } },
        },
      },
    });

    return rows.map((n) => ({
      id: n.id,
      expiryDate: n.certificateExpiry as Date,
      entityLabel: 'Training certificate',
      subjectName: n.employee.fullName,
      link: '/dashboard/my-training',
      fields: [
        { label: 'Employee', value: n.employee.fullName },
        { label: 'Employee code', value: n.employee.employeeCode },
        { label: 'Department', value: n.employee.department?.name ?? '—' },
        { label: 'Course', value: n.session.course.title },
        { label: 'Course code', value: n.session.course.code },
        { label: 'Score', value: n.score !== null ? String(n.score) : '—' },
      ],
      ownerUserId: n.employee.user?.isActive ? n.employee.user.id : null,
      ownerEmail: n.employee.user?.isActive ? n.employee.user.email : null,
    }));
  }

  async recipients(candidate: ReminderCandidate): Promise<ReminderRecipient[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: { in: TRAINING_ALERT_RECIPIENT_ROLES }, isActive: true },
      select: { id: true, email: true, employee: { select: { fullName: true } } },
    });

    const list: ReminderRecipient[] = admins.map((u) => ({
      userId: u.id,
      email: u.email,
      name: u.employee?.fullName || 'there',
      isOwner: false,
    }));

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
