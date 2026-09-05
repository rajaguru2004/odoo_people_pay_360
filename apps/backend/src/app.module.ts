import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BranchContextMiddleware } from './common/branch/branch-context.middleware';
import { BranchContextInterceptor } from './common/branch/branch-context.interceptor';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DepartmentsModule } from './departments/departments.module';
import { OrganizationHubModule } from './organization-hub/organization-hub.module';
import { FinanceModule } from './finance/finance.module';
import { TalentModule } from './talent/talent.module';
import { WorkplaceModule } from './workplace/workplace.module';
import { BranchesModule } from './branches/branches.module';
import { EmployeesModule } from './employees/employees.module';
import { ContractsModule } from './contracts/contracts.module';
import { LegalDocumentsModule } from './legal-documents/legal-documents.module';
import { RemindersModule } from './reminders/reminders.module';
import { AssetsModule } from './assets/assets.module';
import { TravelModule } from './travel/travel.module';
import { TrainingModule } from './training/training.module';
import { BudgetsModule } from './budgets/budgets.module';
import { LettersModule } from './letters/letters.module';
import { GrievancesModule } from './grievances/grievances.module';
import { DocumentVaultModule } from './document-vault/document-vault.module';
import { DocumentsModule } from './documents/documents.module';
import { AttendancesModule } from './attendances/attendances.module';
import { LeaveRequestsModule } from './leave-requests/leave-requests.module';
import { PayrollsModule } from './payrolls/payrolls.module';
import { RewardsModule } from './rewards/rewards.module';
import { DisciplinesModule } from './disciplines/disciplines.module';
import { HolidaysModule } from './holidays/holidays.module';
import { LeaveBalancesModule } from './leave-balances/leave-balances.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AttendanceCorrectionsModule } from './attendance-corrections/attendance-corrections.module';
import { AttendanceIntegrationsModule } from './attendance-integrations/attendance-integrations.module';
import { OvertimeModule } from './overtime/overtime.module';
import { OvertimePolicyModule } from './overtime-policy/overtime-policy.module';
import { MailModule } from './mail/mail.module';
import { ExportModule } from './export/export.module';
import { UploadModule } from './upload/upload.module';
import { SalaryComponentsModule } from './salary-components/salary-components.module';
import { ChatbotModule } from './chatbot/chatbot.module';
import { TeamsModule } from './teams/teams.module';
import { CalendarModule } from './calendar/calendar.module';
import { NotificationsModule } from './notifications/notifications.module';
import { FaceRecognitionModule } from './face-recognition/face-recognition.module';
import { SystemSettingsModule } from './system-settings/system-settings.module';
import { TimezoneModule } from './common/timezone/timezone.module';
import { PayrollBatchesModule } from './payroll-batches/payroll-batches.module';
import { GratuityModule } from './gratuity/gratuity.module';
import { LeaveEncashmentModule } from './leave-encashment/leave-encashment.module';
import { FinalSettlementsModule } from './final-settlements/final-settlements.module';
import { PayrollCalendarModule } from './payroll-calendar/payroll-calendar.module';
import { EmployeeRecoveriesModule } from './employee-recoveries/employee-recoveries.module';
import { LibraryItemsModule } from './library-items/library-items.module';
// Timesheet Management
import { TimesheetsModule } from './timesheets/timesheets.module';
import { AuditModule } from './audit/audit.module';
import { AuditInterceptor } from './audit/audit.interceptor';
import { LeaveAttachmentsModule } from './leave-attachments/leave-attachments.module';
import { ReimbursementsModule } from './reimbursements/reimbursements.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { SupervisorsModule } from './supervisors/supervisors.module';
import { BankDetailsModule } from './bank-details/bank-details.module';
import { ProfileTemplatesModule } from './profile-templates/profile-templates.module';
import { WpsModule } from './wps/wps.module';
import { AdvanceLoansModule } from './advance-loans/advance-loans.module';
import { GarnishmentsModule } from './garnishments/garnishments.module';
import { AccountingModule } from './accounting/accounting.module';
import { SampleDataModule } from './sample-data/sample-data.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { McpModule } from './mcp/mcp.module';
import { CopilotModule } from './copilot/copilot.module';
import { CopilotSettingsModule } from './copilot-settings/copilot-settings.module';
import { DevModeModule } from './dev-mode/dev-mode.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { WhatsAppInboundModule } from './whatsapp/whatsapp-inbound.module';
import { DiscordModule } from './discord/discord.module';
import { DiscordInboundModule } from './discord/discord-inbound.module';
import { TelegramModule } from './telegram/telegram.module';
import { TelegramInboundModule } from './telegram/telegram-inbound.module';
import { ChannelVerificationInboundModule } from './common/verification/channel-verification-inbound.module';
import { AppraisalModule } from './appraisal/appraisal.module';
import { EmployeeTransfersModule } from './employee-transfers/employee-transfers.module';
import { GradesModule } from './grades/grades.module';
import { PayrollReportsModule } from './payroll-reports/payroll-reports.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    MailModule,
    ExportModule,
    AuthModule,
    // Registered early and @Global(): a dozen controllers across unrelated
    // modules put DevModeGuard in their @UseGuards(...).
    DevModeModule,
    UsersModule,
    DepartmentsModule,
    // Registered explicitly rather than left to a transitive import — the same
    // rule Phase B applied to analytics.controller.ts.
    OrganizationHubModule,
    // Module hub aggregates. Each reads across four or five feature modules,
    // so none of them belongs to one — same reason OrganizationHubModule is
    // its own module rather than a method on DepartmentsService.
    FinanceModule,
    TalentModule,
    WorkplaceModule,
    BranchesModule,
    EmployeesModule,
    ContractsModule,
    LegalDocumentsModule,
    RemindersModule,
    AssetsModule,
    TravelModule,
    TrainingModule,
    BudgetsModule,
    LettersModule,
    GrievancesModule,
    DocumentVaultModule,
    DocumentsModule,
    AttendancesModule,
    LeaveRequestsModule,
    LeaveAttachmentsModule,
    ReimbursementsModule,
    AdvanceLoansModule,
    // Before PayrollsModule: `payrolls/reports/...` must be matched before
    // `payrolls/:id`, or every report name is read as a payroll id.
    PayrollReportsModule,
    AccountingModule,
    PayrollsModule,
    PayrollBatchesModule,
    GarnishmentsModule,
    GratuityModule,
    LeaveEncashmentModule,
    FinalSettlementsModule,
    PayrollCalendarModule,
    EmployeeRecoveriesModule,
    EmployeeTransfersModule,
    GradesModule,
    RewardsModule,
    DisciplinesModule,
    HolidaysModule,
    LeaveBalancesModule,
    DashboardModule,
    AttendanceCorrectionsModule,
    AttendanceIntegrationsModule,
    OvertimeModule,
    OvertimePolicyModule,
    UploadModule,
    SalaryComponentsModule,
    ChatbotModule,
    TeamsModule,
    CalendarModule,
    NotificationsModule,
    FaceRecognitionModule,
    SystemSettingsModule,
    SampleDataModule,
    CopilotSettingsModule,
    WhatsAppModule,
    DiscordModule,
    TelegramModule,
    // Imported explicitly even though McpModule already pulls it in: the
    // analytics HTTP routes must not depend on the MCP surface staying
    // registered. Nest dedupes the module either way.
    AnalyticsModule,
    McpModule,
    // Inbound is registered AFTER McpModule: it is a leaf that depends on the
    // tool registry, and nothing depends on it.
    WhatsAppInboundModule,
    DiscordInboundModule,
    TelegramInboundModule,
    // Leaf, after every channel: it serves the browser page they hand out.
    ChannelVerificationInboundModule,
    CopilotModule,
    AppraisalModule,
    TimezoneModule,
    LibraryItemsModule,
    // Timesheet Management
    TimesheetsModule,
    AuditModule,
    ApprovalsModule,
    SupervisorsModule,
    BankDetailsModule,
    ProfileTemplatesModule,
    WpsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Resolves + validates the effective branch BEFORE audit runs.
    {
      provide: APP_INTERCEPTOR,
      useClass: BranchContextInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Seed the AsyncLocalStorage branch store for every request.
    consumer.apply(BranchContextMiddleware).forRoutes('*');
  }
}
