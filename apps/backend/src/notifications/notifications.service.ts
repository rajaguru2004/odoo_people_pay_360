import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateNotificationDto, NotifyOptions } from './dto/create-notification.dto';
import {
  NOTIFICATION_CHANNELS,
  NotificationChannelSink,
} from './notification-channel.sink';

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    /**
     * Every registered delivery channel.
     *
     * @Optional so `new NotificationsService(prisma)` keeps working in the specs
     * that construct it directly, and so a deployment can drop any or all
     * channel modules without touching this class.
     */
    @Optional()
    @Inject(NOTIFICATION_CHANNELS)
    private readonly channels?: NotificationChannelSink[],
  ) {}

  async create(createNotificationDto: CreateNotificationDto) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: createNotificationDto.userId,
        title: createNotificationDto.title,
        message: createNotificationDto.message,
        type: createNotificationDto.type || 'INFO',
        link: createNotificationDto.link,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            employee: {
              select: {
                fullName: true,
              },
            },
          },
        },
      },
    });

    this.teeToChannels([createNotificationDto]);

    return {
      success: true,
      message: 'Notification created successfully',
      data: notification,
    };
  }

  async createBulk(notifications: CreateNotificationDto[]) {
    const created = await this.prisma.notification.createMany({
      data: notifications.map((n) => ({
        userId: n.userId,
        title: n.title,
        message: n.message,
        type: n.type || 'INFO',
        link: n.link,
      })),
    });

    this.teeToChannels(notifications);

    return {
      success: true,
      message: `Created ${created.count} notifications`,
      data: { count: created.count },
    };
  }

  /**
   * Fan a notification out to every registered delivery channel.
   *
   * Fire-and-forget and error-swallowing, without exception: this runs inside
   * business transactions all over the codebase, and a messaging failure must
   * never break the in-app notification — let alone the leave approval that
   * triggered it. Each channel drops anything with no registered template, so
   * enabling one does not start messaging people about every one of the ~60
   * call sites.
   */
  private teeToChannels(dtos: CreateNotificationDto[]): void {
    if (!this.channels?.length || !dtos.length) return;

    const payload = dtos.map((d) => ({
      userId: d.userId,
      title: d.title,
      message: d.message,
      type: d.type,
      link: d.link,
      decision: d.decision,
    }));

    for (const channel of this.channels) {
      // try/catch as well as .catch(): a synchronous throw inside
      // enqueueFromNotifications would happen before any promise exists, so
      // `.catch()` alone would let it escape into the caller's transaction.
      // One failing channel must also not stop the others.
      try {
        void channel.enqueueFromNotifications(payload).catch(() => undefined);
      } catch {
        /* a delivery channel must never break an in-app notification */
      }
    }
  }

  async findAll(userId: string, unreadOnly: boolean = false) {
    const where: any = { userId };
    if (unreadOnly) {
      where.isRead = false;
    }

    const notifications = await this.prisma.notification.findMany({
      where,
      select: {
        id: true,
        title: true,
        type: true,
        isRead: true,
        createdAt: true,
        link: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50, // Limit to 50 most recent
    });

    return {
      success: true,
      data: notifications,
    };
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: {
        userId,
        isRead: false,
      },
    });

    return {
      success: true,
      data: { count },
    };
  }

  async markAsRead(id: string, userId: string) {
    const notification = await this.prisma.notification.updateMany({
      where: {
        id,
        userId, // Ensure user owns this notification
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    if (notification.count === 0) {
      return {
        success: false,
        message: 'Notification not found or access denied',
      };
    }

    return {
      success: true,
      message: 'Notification marked as read',
    };
  }

  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return {
      success: true,
      message: `Marked ${result.count} notifications as read`,
      data: { count: result.count },
    };
  }

  async delete(id: string, userId: string) {
    const result = await this.prisma.notification.deleteMany({
      where: {
        id,
        userId, // Ensure user owns this notification
      },
    });

    if (result.count === 0) {
      return {
        success: false,
        message: 'Notification not found or access denied',
      };
    }

    return {
      success: true,
      message: 'Notification deleted',
    };
  }

  async deleteAll(userId: string) {
    const result = await this.prisma.notification.deleteMany({
      where: { userId },
    });

    return {
      success: true,
      message: `Deleted ${result.count} notifications`,
      data: { count: result.count },
    };
  }

  // Helper method to send notification to user.
  // `opts` is an additive trailing argument so all existing call sites compile
  // unchanged; it carries the transient fields the delivery channels read.
  async notifyUser(
    userId: string,
    title: string,
    message: string,
    type: string = 'INFO',
    link?: string,
    opts?: NotifyOptions,
  ) {
    return this.create({
      userId,
      title,
      message,
      type: type as any,
      link,
      ...opts,
    });
  }

  // Helper method to send notification to multiple users
  async notifyUsers(
    userIds: string[],
    title: string,
    message: string,
    type: string = 'INFO',
    link?: string,
    opts?: NotifyOptions,
  ) {
    const notifications = userIds.map((userId) => ({
      userId,
      title,
      message,
      type: type as any,
      link,
      ...opts,
    }));

    return this.createBulk(notifications);
  }
}
