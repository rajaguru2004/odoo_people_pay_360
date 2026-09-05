import { Injectable, Logger } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { SystemSettingsService } from '../system-settings/system-settings.service';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private lastConfig = '';

  constructor(
    private mailerService: MailerService,
    private settingsService: SystemSettingsService,
  ) {
    this.logger.log(
      'Dynamic Mail Service initialized with fallback to environment variables',
    );
  }

  private async getCompanyContext(): Promise<{
    companyName: string;
    companyLogoUrl: string;
  }> {
    const companyName =
      (await this.settingsService.getSetting('company_name')) ||
      'The Company';
    const companyLogoUrl =
      (await this.settingsService.getSetting('company_logo_url')) || '';
    return { companyName, companyLogoUrl };
  }

  private async ensureTransporter(): Promise<boolean> {
    try {
      // Resolved by SystemSettingsService so the SMTP settings screen and this
      // transporter cannot disagree: stored row wins, an empty one falls
      // through to the environment. Reading the keys here as well was how the
      // two drifted — the screen used a different fallback rule and rendered
      // blank over a live env-configured server.
      const mail = await this.settingsService.getMailConfig();
      if (mail.mail_enabled !== 'true') {
        return false;
      }

      const host = mail.mail_host;
      const port = parseInt(mail.mail_port, 10) || 587;
      const user = mail.mail_user;
      const pass = mail.mail_password;
      const from = mail.mail_from;
      const fromName = mail.mail_from_name;
      const bcc = mail.mail_bcc;
      const configStr = `${host}:${port}:${user}:${pass}:${from}:${fromName}:${bcc}`;
      if (this.lastConfig === configStr && this.mailerService['transporter']) {
        return true;
      }

      // Recreate transporter with dynamic config
      const defaults: any = {};
      if (from || user) {
        // Hostinger strict SMTP can throw 554 5.7.1 if FROM is formatted with a name or doesn't match the authenticated user exactly.
        // Fallback strictly to the authenticated user's raw email address to ensure delivery.
        defaults.from = from || user;
      }
      if (bcc) {
        defaults.bcc = bcc;
      }

      const transporter = this.mailerService[
        'transportFactory'
      ].createTransport(
        {
          host,
          port,
          secure: port === 465,
          auth: {
            user,
            pass,
          },
        },
        defaults,
      );

      this.mailerService['initTemplateAdapter'](
        this.mailerService['templateAdapter'],
        transporter,
      );

      // Set default sender
      if (from || user) {
        if (!this.mailerService['mailerOptions'].defaults) {
          this.mailerService['mailerOptions'].defaults = {};
        }
        this.mailerService['mailerOptions'].defaults.from = from || user;
      }
      if (bcc) {
        if (!this.mailerService['mailerOptions'].defaults) {
          this.mailerService['mailerOptions'].defaults = {};
        }
        this.mailerService['mailerOptions'].defaults.bcc = bcc;
      }

      this.mailerService['transporter'] = transporter;
      this.lastConfig = configStr;
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to configure dynamic email transporter: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Send email for leave request submission
   */
  async sendLeaveApplied(
    to: string,
    data: {
      employeeName: string;
      leaveType: string;
      startDate: string;
      endDate: string;
      days: number;
      reason?: string;
      isUserRecipient: boolean;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send leave applied email to ${to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'New Leave Request Submitted',
        template: './leave-applied',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent leave applied email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send leave applied email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send email for leave request approval
   */
  async sendLeaveApproved(
    to: string,
    data: {
      employeeName: string;
      leaveType: string;
      startDate: string;
      endDate: string;
      days: number;
      approverName: string;
      comment?: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send leave approved email to ${to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Leave Request Approved',
        template: './leave-approved',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent leave approved email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send leave approved email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send email for leave request rejection
   */
  async sendLeaveRejected(
    to: string,
    data: {
      employeeName: string;
      leaveType: string;
      startDate: string;
      endDate: string;
      days: number;
      approverName: string;
      reason: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send leave rejected email to ${to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Leave Request Rejected',
        template: './leave-rejected',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent leave rejected email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send leave rejected email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send email for overtime approval
   */
  async sendOvertimeApproved(
    to: string,
    data: {
      employeeName: string;
      date: string;
      hours: number;
      approverName: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(
        `[DISABLED] Would send overtime approved email to ${to}`,
      );
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Overtime Request Approved',
        template: './overtime-approved',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent overtime approved email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send overtime approved email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send email for overtime rejection
   */
  async sendOvertimeRejected(
    to: string,
    data: {
      employeeName: string;
      date: string;
      hours: number;
      approverName: string;
      reason: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(
        `[DISABLED] Would send overtime rejected email to ${to}`,
      );
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Overtime Request Rejected',
        template: './overtime-rejected',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent overtime rejected email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send overtime rejected email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send email for contract expiration alert
   */
  async sendContractExpiringAlert(
    to: string,
    data: {
      employeeName: string;
      contractType: string;
      endDate: string;
      daysRemaining: number;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(
        `[DISABLED] Would send contract expiring alert to ${to}`,
      );
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Notice: Contract Expiring Soon',
        template: './contract-expiring',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent contract expiring alert to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send contract expiring alert to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send contract expiry alert to an admin/HR manager recipient
   */
  async sendContractExpiringAdminAlert(
    to: string,
    data: {
      recipientName: string;
      employeeName: string;
      employeeCode?: string;
      department?: string;
      contractType: string;
      endDate: string;
      daysRemaining: number;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(
        `[DISABLED] Would send contract expiring admin alert to ${to}`,
      );
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: `Contract Expiring Soon: ${data.employeeName}`,
        template: './contract-expiring-admin',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent contract expiring admin alert to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send contract expiring admin alert to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send visa expiry alert to the employee
   */
  async sendVisaExpiringAlert(
    to: string,
    data: {
      employeeName: string;
      visaNumber: string;
      visaType: string;
      country: string;
      expiryDate: string;
      daysRemaining: number;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send visa expiring alert to ${to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Notice: Your Visa Is Expiring Soon',
        template: './visa-expiring',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent visa expiring alert to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send visa expiring alert to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Generic expiry reminder — one method and one template for every expiring
   * entity (visa, contract, asset warranty, training certificate). The caller
   * supplies the label and the detail rows, so a new expiring thing needs no
   * new mail method and no new `.hbs`.
   */
  async sendExpiryReminder(
    to: string,
    data: {
      recipientName: string;
      /** Owner copy is second-person; admin copy names the subject. */
      isOwner: boolean;
      entityLabel: string;
      subjectName: string;
      expiryDate: string;
      daysRemaining: number;
      fields: Array<{ label: string; value: string }>;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(
        `[DISABLED] Would send ${data.entityLabel} expiry reminder to ${to}`,
      );
      return;
    }

    const company = await this.getCompanyContext();
    const subject = data.isOwner
      ? `Your ${data.entityLabel} expires in ${data.daysRemaining} day(s)`
      : `${data.entityLabel} Expiring Soon: ${data.subjectName}`;
    try {
      await this.mailerService.sendMail({
        to,
        subject,
        template: './expiry-reminder',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent ${data.entityLabel} expiry reminder to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send expiry reminder to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send visa expiry alert to an admin/HR manager recipient
   */
  async sendVisaExpiringAdminAlert(
    to: string,
    data: {
      recipientName: string;
      employeeName: string;
      employeeCode?: string;
      department?: string;
      visaNumber: string;
      visaType: string;
      country: string;
      expiryDate: string;
      daysRemaining: number;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(
        `[DISABLED] Would send visa expiring admin alert to ${to}`,
      );
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: `Visa Expiring Soon: ${data.employeeName}`,
        template: './visa-expiring-admin',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent visa expiring admin alert to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send visa expiring admin alert to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send payslip email
   */
  async sendPayslip(
    to: string,
    data: {
      employeeName: string;
      month: number;
      year: number;
      netSalary: number;
      baseSalary: number;
      allowances: number;
      bonus: number;
      deduction: number;
      overtimePay: number;
      insurance: number;
      tax: number;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send payslip email to ${to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: `Payslip for Month ${data.month}/${data.year}`,
        template: './payslip',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent payslip email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send payslip email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send welcome email to new employee
   */
  async sendWelcomeEmail(
    to: string,
    data: {
      employeeName: string;
      employeeCode: string;
      position: string;
      department: string;
      startDate: string;
      email: string;
      temporaryPassword?: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send welcome email to ${to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Welcome to the Company',
        template: './welcome',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent welcome email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send welcome email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send attendance correction approval
   */
  async sendAttendanceCorrectionApproved(
    to: string,
    data: {
      employeeName: string;
      date: string;
      originalCheckIn: string;
      originalCheckOut: string;
      requestedCheckIn: string;
      requestedCheckOut: string;
      approverName: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(
        `[DISABLED] Would send attendance correction approved email to ${to}`,
      );
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Attendance Correction Request Approved',
        template: './attendance-correction-approved',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent attendance correction approved email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send attendance correction approved email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send attendance correction rejection
   */
  async sendAttendanceCorrectionRejected(
    to: string,
    data: {
      employeeName: string;
      date: string;
      approverName: string;
      reason: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(
        `[DISABLED] Would send attendance correction rejected email to ${to}`,
      );
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Attendance Correction Request Rejected',
        template: './attendance-correction-rejected',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent attendance correction rejected email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send attendance correction rejected email to ${to}:`,
        error.message,
      );
    }
  }

  async sendLunchBreakReminder(
    to: string,
    data: {
      employeeName: string;
      lunchStartTime: string;
      lunchDurationMinutes: number;
      checkInUrl: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send lunch break reminder email to ${to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: 'Lunch Break Reminder — Time to Check Back In',
        template: './lunch-break-reminder',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent lunch break reminder email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send lunch break reminder email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Send daily attendance summary report (self-mail)
   */
  async sendDailyAttendanceReport(data: {
    date: string;
    totalEmployees: number;
    presentCount: number;
    absentCount: number;
    onLeaveCount: number;
    lateCount: number;
    earlyLeaveCount: number;
    presentEmployees: Array<{
      name: string;
      department: string;
      checkIn: string;
      checkOut: string;
      workHours: string;
      isLate: boolean;
      isEarlyLeave: boolean;
    }>;
    absentEmployees: Array<{ name: string; department: string }>;
    onLeaveEmployees: Array<{ name: string; department: string; leaveType: string }>;
    generatedAt: string;
    companyName: string;
  }) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send daily attendance report`);
      return;
    }

    // Same resolution as the transporter — the report goes to the configured
    // sender address, wherever that address actually comes from.
    const to = (await this.settingsService.getMailConfig()).mail_from;

    if (!to) {
      this.logger.error(
        '❌ Cannot send daily attendance report: sender/recipient email (mail_from) not configured.',
      );
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: `Daily Attendance Report — ${data.date}`,
        template: './daily-attendance-report',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent daily attendance report to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send daily attendance report to ${to}:`,
        error.message,
      );
    }
  }

  async sendProjectMemberAdded(
    to: string,
    data: {
      recipientName: string;
      projectName: string;
      projectCode: string;
      roleName: string;
      addedByName?: string;
      projectUrl: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(
        `[DISABLED] Would send project-member-added email to ${to}`,
      );
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: `You've been added to project: ${data.projectName}`,
        template: './project-member-added',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent project-member-added email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send project-member-added email to ${to}:`,
        error.message,
      );
    }
  }

  async sendTaskAssigned(
    to: string,
    data: {
      recipientName: string;
      taskTitle: string;
      taskCode: string;
      projectName?: string;
      priority: string;
      dueDate?: string;
      reporterName?: string;
      taskUrl: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send task-assigned email to ${to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: `Task assigned to you: [${data.taskCode}] ${data.taskTitle}`,
        template: './task-assigned',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent task-assigned email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send task-assigned email to ${to}:`,
        error.message,
      );
    }
  }

  async sendTaskCompleted(
    to: string,
    data: {
      recipientName: string;
      taskTitle: string;
      taskCode: string;
      projectName?: string;
      completedByName: string;
      completedDate: string;
      taskUrl: string;
    },
  ) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send task-completed email to ${to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to,
        subject: `Task completed: [${data.taskCode}] ${data.taskTitle}`,
        template: './task-completed',
        context: { ...data, ...company },
      });
      this.logger.log(`Sent task-completed email to ${to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send task-completed email to ${to}:`,
        error.message,
      );
    }
  }

  /**
   * Generic send mail method for custom emails
   */
  async sendMail(options: {
    to: string;
    subject: string;
    template: string;
    context: any;
  }) {
    const isEnabled = await this.ensureTransporter();
    if (!isEnabled) {
      this.logger.debug(`[DISABLED] Would send email to ${options.to}`);
      return;
    }

    const company = await this.getCompanyContext();
    try {
      await this.mailerService.sendMail({
        to: options.to,
        subject: options.subject,
        template: `./${options.template}`,
        context: { ...options.context, ...company },
      });
      this.logger.log(`Sent email to ${options.to}`);
    } catch (error) {
      this.logger.error(
        `Failed to send email to ${options.to}:`,
        error.message,
      );
      throw error;
    }
  }
}
