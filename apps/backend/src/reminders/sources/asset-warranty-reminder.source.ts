import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType } from '../../notifications/dto/create-notification.dto';
import {
  type ReminderCandidate,
  type ReminderRecipient,
  type ReminderSource,
} from '../reminder-source';

const ASSET_ALERT_RECIPIENT_ROLES = ['ADMIN', 'HR_MANAGER'];

/**
 * Asset warranty expiry.
 *
 * The third registration rather than the third copy-pasted cron — which is the
 * whole reason RemindersModule exists.
 */
@Injectable()
export class AssetWarrantyReminderSource implements ReminderSource {
  readonly key = 'asset_warranty';
  readonly thresholdSettingKey = 'reminder_days_asset_warranty';
  // Shorter tiers than a visa: a warranty is a purchasing decision, not a legal
  // deadline, so 90 days of notice is noise.
  readonly defaultThresholds = [60, 30, 7];
  readonly notificationType = NotificationType.WARNING;

  constructor(private readonly prisma: PrismaService) {}

  async findExpiring(from: Date, to: Date): Promise<ReminderCandidate[]> {
    const assets = await this.prisma.assetItem.findMany({
      where: {
        warrantyExpiry: { gte: from, lte: to },
        // A retired or lost asset's warranty is nobody's problem.
        status: { notIn: ['RETIRED', 'LOST'] },
      },
      include: { branch: { select: { name: true } } },
    });

    return assets.map((a) => ({
      id: a.id,
      expiryDate: a.warrantyExpiry as Date,
      entityLabel: 'Asset warranty',
      subjectName: `${a.name} (${a.assetTag})`,
      link: `/dashboard/assets?assetId=${a.id}`,
      fields: [
        { label: 'Asset tag', value: a.assetTag },
        { label: 'Asset', value: a.name },
        { label: 'Category', value: a.category },
        { label: 'Serial number', value: a.serialNumber ?? '—' },
        { label: 'Branch', value: a.branch?.name ?? '—' },
      ],
      // An asset is company property; there is no employee owner to notify.
      ownerUserId: null,
      ownerEmail: null,
    }));
  }

  async recipients(): Promise<ReminderRecipient[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: { in: ASSET_ALERT_RECIPIENT_ROLES }, isActive: true },
      select: { id: true, email: true, employee: { select: { fullName: true } } },
    });
    return admins.map((u) => ({
      userId: u.id,
      email: u.email,
      name: u.employee?.fullName || 'there',
      isOwner: false,
    }));
  }
}
