import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { TimezoneService } from '../common/timezone/timezone.service';
import {
  CompanyCronGate,
  COMPANY_CRON_TICK,
} from '../common/timezone/company-cron.gate';
import { LoanNotificationService } from './loan-notification.service';

/**
 * Delinquency: the state a late loan was never allowed to be in.
 *
 * `loan_overdue_after_cycles` was seeded (default 2) and read by nothing, there
 * was no `OVERDUE` status, and `GET /advance-loans/reports/overdue` computed
 * ageing buckets at query time and changed nothing. So a loan two cycles behind
 * looked exactly like a healthy one everywhere except that one report — no
 * notification, no filter, no flag on the list.
 *
 * The rule is deliberately narrow. A loan is overdue when at least N of its
 * scheduled instalments are past due and unpaid, where N is the setting. It
 * does NOT hold, cancel or otherwise punish the loan: escalation is a decision
 * for a person, and the gap being closed here is that the person was never told.
 *
 * Recovering brings it back: a loan that catches up returns to ACTIVE, because
 * a status nobody clears is a status nobody trusts.
 */
@Injectable()
export class LoanOverdueService {
  private readonly logger = new Logger(LoanOverdueService.name);
  private readonly gate: CompanyCronGate;

  constructor(
    private prisma: PrismaService,
    private settings: SystemSettingsService,
    private tzSvc: TimezoneService,
    private loanNotifications: LoanNotificationService,
  ) {
    // Company-local morning, so the notice arrives on the day it describes.
    this.gate = new CompanyCronGate(this.tzSvc, '06:00');
  }

  @Cron(COMPANY_CRON_TICK, { name: 'loan-overdue-sweep' })
  async tick() {
    if (!(await this.gate.due())) return;
    return this.sweep();
  }

  /**
   * Move loans in and out of OVERDUE.
   *
   * Idempotent by construction: it compares the state it computes with the
   * status already on the row and writes only differences, so running it twice
   * in a day is a no-op and the notification log dedupes the notice anyway.
   */
  async sweep(now: Date = new Date()) {
    const afterCycles = Number(
      await this.settings.getSetting('loan_overdue_after_cycles', '2'),
    );
    // 0 disables the sweep rather than marking every late loan overdue at once,
    // which is what a company turning it "off" means by it.
    if (!Number.isFinite(afterCycles) || afterCycles <= 0) {
      return { checked: 0, markedOverdue: 0, recovered: 0 };
    }

    const live = await this.prisma.advanceLoanRequest.findMany({
      where: { status: { in: ['ACTIVE', 'DISBURSED', 'APPROVED', 'OVERDUE'] } },
      select: {
        id: true,
        status: true,
        employeeId: true,
        referenceNo: true,
        type: true,
        scheduleVersion: true,
      },
    });

    let markedOverdue = 0;
    let recovered = 0;

    for (const loan of live) {
      const missed = await this.prisma.loanSchedule.count({
        where: {
          requestId: loan.id,
          version: loan.scheduleVersion,
          dueDate: { lt: now },
          // PARTIAL counts as missed: part of an instalment is not an
          // instalment, and treating it as paid is how a slipping loan stays
          // invisible.
          status: { in: ['SCHEDULED', 'PARTIAL'] },
        },
      });

      const shouldBeOverdue = missed >= afterCycles;

      if (shouldBeOverdue && loan.status !== 'OVERDUE') {
        // Compare-and-set on the status we read, so a loan closed or held
        // between the read and the write is not dragged back into OVERDUE.
        const res = await this.prisma.advanceLoanRequest.updateMany({
          where: { id: loan.id, status: loan.status },
          data: { status: 'OVERDUE' },
        });
        if (res.count === 0) continue;
        markedOverdue += 1;

        const user = await this.prisma.user.findFirst({
          where: { employeeId: loan.employeeId },
          select: { id: true },
        });
        if (user) {
          const label = loan.type === 'LOAN' ? 'loan' : 'salary advance';
          await this.loanNotifications.notifyOnce({
            requestId: loan.id,
            event: 'LOAN_OVERDUE',
            // Once per calendar month: an overdue loan stays overdue, and a
            // daily sweep must not become a daily letter.
            periodKey: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
            recipientUserId: user.id,
            title: `Your ${label} is overdue`,
            message:
              `${missed} instalment(s) on ${loan.referenceNo ?? 'your ' + label} are past due. ` +
              `Contact HR if the deduction did not reach your payslip.`,
            link: `/dashboard/advance-loans/${loan.id}`,
          });
        }
      } else if (!shouldBeOverdue && loan.status === 'OVERDUE') {
        // Back to ACTIVE. A status nobody clears is a status nobody trusts.
        const res = await this.prisma.advanceLoanRequest.updateMany({
          where: { id: loan.id, status: 'OVERDUE' },
          data: { status: 'ACTIVE' },
        });
        if (res.count > 0) recovered += 1;
      }
    }

    if (markedOverdue > 0 || recovered > 0) {
      this.logger.log(
        `Overdue sweep: ${markedOverdue} marked overdue, ${recovered} recovered.`,
      );
    }
    return { checked: live.length, markedOverdue, recovered };
  }
}
