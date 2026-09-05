import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType } from '../../notifications/dto/create-notification.dto';
import { LEGAL_DOC_ALERT_RECIPIENT_ROLES } from '../../legal-documents/legal-document.constants';
import {
  type ReminderCandidate,
  type ReminderRecipient,
  type ReminderSource,
} from '../reminder-source';

/**
 * Visa / legal-document expiry. Replaces the `legal-document-expiry-alerts`
 * cron that used to live in LegalDocumentsService.
 *
 * `autoExpireLegalDocuments` stays where it is — that is a status transition,
 * not a reminder.
 */
@Injectable()
export class LegalDocumentReminderSource implements ReminderSource {
  readonly key = 'legal_document';
  readonly thresholdSettingKey = 'reminder_days_legal_document';
  readonly defaultThresholds = [90, 60, 30, 7];
  readonly notificationType = NotificationType.VISA_EXPIRING;

  constructor(private readonly prisma: PrismaService) {}

  async findExpiring(from: Date, to: Date): Promise<ReminderCandidate[]> {
    const docs = await this.prisma.employeeLegalDocument.findMany({
      where: {
        status: 'ACTIVE',
        isCurrent: true,
        expiryDate: { gte: from, lte: to },
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

    return docs.map((doc) => ({
      id: doc.id,
      expiryDate: doc.expiryDate,
      entityLabel: doc.documentType || 'Visa',
      subjectName: doc.employee.fullName,
      link: `/dashboard/employees/${doc.employeeId}?section=visa`,
      fields: [
        { label: 'Employee', value: doc.employee.fullName },
        { label: 'Employee code', value: doc.employee.employeeCode },
        { label: 'Department', value: doc.employee.department?.name ?? '—' },
        { label: 'Document number', value: doc.documentNumber },
        { label: 'Document type', value: doc.documentType },
        { label: 'Country', value: doc.country },
      ],
      ownerUserId: doc.employee.user?.isActive ? doc.employee.user.id : null,
      ownerEmail: doc.employee.user?.isActive ? doc.employee.user.email : null,
    }));
  }

  async recipients(candidate: ReminderCandidate): Promise<ReminderRecipient[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: { in: LEGAL_DOC_ALERT_RECIPIENT_ROLES }, isActive: true },
      select: { id: true, email: true, employee: { select: { fullName: true } } },
    });

    const list: ReminderRecipient[] = admins.map((u) => ({
      userId: u.id,
      email: u.email,
      name: u.employee?.fullName || 'there',
      isOwner: false,
    }));

    // The employee themselves, when they have an active account. Guarded
    // against double-notifying an HR user about their own document.
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
