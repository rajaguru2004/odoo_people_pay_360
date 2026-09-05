import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TimezoneService } from '../common/timezone/timezone.service';

@Injectable()
export class ShiftNotificationScheduler {
  private readonly logger = new Logger(ShiftNotificationScheduler.name);

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private settingsService: SystemSettingsService,
    private notificationsService: NotificationsService,
    private timezoneService: TimezoneService,
  ) { }

  @Cron('*/1 * * * *') // Runs every minute
  async checkAndSendShiftNotifications() {
    try {
      // Fetch dynamic offsets from SystemSettingsService
      const priorOffsetStr = await this.settingsService.getSetting(
        'shift_reminder_prior_mins',
        '5',
      );
      const postOffsetStr = await this.settingsService.getSetting(
        'shift_reminder_post_mins',
        '5',
      );

      const priorOffset = parseInt(priorOffsetStr, 10) || 5;
      const postOffset = parseInt(postOffsetStr, 10) || 5;

      const companyName = await this.settingsService.getSetting(
        'company_name',
        'The Company',
      );
      const companyLogoUrl = await this.settingsService.getSetting(
        'company_logo_url',
        '',
      );

      const now = new Date();
      const prisma = this.prisma as any;

      // 1. Process Prior Notifications
      // Target shifts starting between [now, now + priorOffset + 2 minutes]
      const priorMin = new Date(now.getTime());
      const priorMax = new Date(now.getTime() + (priorOffset + 2) * 60 * 1000);

      const priorSchedules = await prisma.workSchedule.findMany({
        where: {
          startTime: {
            gte: priorMin,
            lte: priorMax,
          },
          priorEmailSent: false,
          isWorkDay: true,
          // Flexible shifts have no fixed start, so no time-based reminders.
          shiftType: { not: 'FLEXIBLE' },
        },
        include: {
          employee: {
            select: {
              id: true,
              fullName: true,
              email: true,
              timezone: true,
              user: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      });

      for (const schedule of priorSchedules) {
        const employee = schedule.employee;
        if (!employee) continue;

        try {
          this.logger.log(
            `[Prior Shift Reminder] Sending to ${employee.fullName} for shift starting at ${schedule.startTime}`,
          );

          const tz = await this.timezoneService.getEffectiveTZ(
            employee.timezone,
          );

          const startTimeStr = schedule.startTime.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: tz,
          });
          const endTimeStr = schedule.endTime.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: tz,
          });

          // Send Email
          try {
            await this.mailService.sendMail({
              to: employee.email,
              subject: `🔔 Upcoming Shift Reminder: Starts in ${priorOffset} Minutes`,
              template: 'shift-prior-reminder',
              context: {
                employeeName: employee.fullName,
                shiftType: schedule.shiftType,
                startTime: startTimeStr,
                endTime: endTimeStr,
                offsetMins: priorOffset,
                companyName,
                companyLogoUrl,
              },
            });
          } catch (mailError) {
            this.logger.error(
              `Failed to send prior reminder email to ${employee.email}: ${mailError.message}`,
            );
          }

          // Send In-App Notification if user has an account. `priorEmailSent`
          // below is what stops a replayed cron tick telling the same person
          // twice about one shift.
          if (employee.user?.id) {
            await this.notificationsService.notifyUser(
              employee.user.id,
              'Upcoming Shift Reminder',
              `Your ${schedule.shiftType.toLowerCase()} shift starts in ${priorOffset} minutes at ${startTimeStr}.`,
              'INFO',
              '/dashboard/schedules',
            );
          }

          // Mark as sent
          await prisma.workSchedule.update({
            where: { id: schedule.id },
            data: { priorEmailSent: true },
          });
        } catch (error) {
          this.logger.error(
            `Failed to process prior reminder for schedule ${schedule.id}: ${error.message}`,
          );
        }
      }

      // 2. Process Post-Start Alerts
      // Target shifts that started between [now - postOffset - 10 minutes, now - postOffset]
      const postMin = new Date(now.getTime() - (postOffset + 10) * 60 * 1000);
      const postMax = new Date(now.getTime() - postOffset * 60 * 1000);

      const postSchedules = await prisma.workSchedule.findMany({
        where: {
          startTime: {
            gte: postMin,
            lte: postMax,
          },
          postEmailSent: false,
          isWorkDay: true,
          // Flexible shifts have no fixed start, so no time-based reminders.
          shiftType: { not: 'FLEXIBLE' },
        },
        include: {
          employee: {
            select: {
              id: true,
              fullName: true,
              email: true,
              timezone: true,
              user: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      });

      for (const schedule of postSchedules) {
        const employee = schedule.employee;
        if (!employee) continue;

        try {
          this.logger.log(
            `[Post Shift Alert] Sending to ${employee.fullName} for shift that started at ${schedule.startTime}`,
          );

          const tz = await this.timezoneService.getEffectiveTZ(
            employee.timezone,
          );

          const startTimeStr = schedule.startTime.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: tz,
          });
          const endTimeStr = schedule.endTime.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: tz,
          });

          // Send Email
          try {
            await this.mailService.sendMail({
              to: employee.email,
              subject: `🕒 Shift Started Notice: ${postOffset} Minutes Ago`,
              template: 'shift-post-reminder',
              context: {
                employeeName: employee.fullName,
                shiftType: schedule.shiftType,
                startTime: startTimeStr,
                endTime: endTimeStr,
                offsetMins: postOffset,
                companyName,
                companyLogoUrl,
              },
            });
          } catch (mailError) {
            this.logger.error(
              `Failed to send post reminder email to ${employee.email}: ${mailError.message}`,
            );
          }

          // Send In-App Warning if user has an account.
          if (employee.user?.id) {
            await this.notificationsService.notifyUser(
              employee.user.id,
              'Shift Started Warning',
              `Your ${schedule.shiftType.toLowerCase()} shift started ${postOffset} minutes ago at ${startTimeStr}.`,
              'WARNING',
              '/dashboard/schedules',
            );
          }

          // Mark as sent
          await prisma.workSchedule.update({
            where: { id: schedule.id },
            data: { postEmailSent: true },
          });
        } catch (error) {
          this.logger.error(
            `Failed to process post alert for schedule ${schedule.id}: ${error.message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Global error in shift notification scheduler: ${error.message}`,
      );
    }
  }
}
