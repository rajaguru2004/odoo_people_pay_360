import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { AuthModule } from '../../src/auth/auth.module';
import { TelegramModule } from '../../src/telegram/telegram.module';
import { TelegramInboundModule } from '../../src/telegram/telegram-inbound.module';
import { BranchesModule } from '../../src/branches/branches.module';
import { DepartmentsModule } from '../../src/departments/departments.module';
import { OrganizationHubModule } from '../../src/organization-hub/organization-hub.module';
import { TalentModule } from '../../src/talent/talent.module';
import { WorkplaceModule } from '../../src/workplace/workplace.module';
import { EmployeesModule } from '../../src/employees/employees.module';
import { AttendancesModule } from '../../src/attendances/attendances.module';
import { AttendanceIntegrationsModule } from '../../src/attendance-integrations/attendance-integrations.module';
import { ContractsModule } from '../../src/contracts/contracts.module';
import { RemindersModule } from '../../src/reminders/reminders.module';
import { AssetsModule } from '../../src/assets/assets.module';
import { TrainingModule } from '../../src/training/training.module';
import { LettersModule } from '../../src/letters/letters.module';
import { GrievancesModule } from '../../src/grievances/grievances.module';
import { DocumentVaultModule } from '../../src/document-vault/document-vault.module';
import { DocumentsModule } from '../../src/documents/documents.module';
import { SystemSettingsModule } from '../../src/system-settings/system-settings.module';
import { AuditModule } from '../../src/audit/audit.module';
import { AuditInterceptor } from '../../src/audit/audit.interceptor';
import { CopilotSettingsModule } from '../../src/copilot-settings/copilot-settings.module';
import { DevModeModule } from '../../src/dev-mode/dev-mode.module';
import { LeaveRequestsModule } from '../../src/leave-requests/leave-requests.module';
import { LeaveAttachmentsModule } from '../../src/leave-attachments/leave-attachments.module';
import { OvertimeModule } from '../../src/overtime/overtime.module';
import { ApprovalsModule } from '../../src/approvals/approvals.module';
import { SupervisorsModule } from '../../src/supervisors/supervisors.module';
import { TeamsModule } from '../../src/teams/teams.module';
import { ExportModule } from '../../src/export/export.module';
import { ProfileTemplatesModule } from '../../src/profile-templates/profile-templates.module';
import { LegalDocumentsModule } from '../../src/legal-documents/legal-documents.module';
import { OvertimePolicyModule } from '../../src/overtime-policy/overtime-policy.module';
import { PayrollsModule } from '../../src/payrolls/payrolls.module';
// Absent until Phase 4: every /payroll-batches route 404'd under test, so the
// whole batch surface was structurally untestable rather than merely untested.
import { PayrollBatchesModule } from '../../src/payroll-batches/payroll-batches.module';
import { HolidaysModule } from '../../src/holidays/holidays.module';
import { SalaryComponentsModule } from '../../src/salary-components/salary-components.module';
import { LibraryItemsModule } from '../../src/library-items/library-items.module';
import { AttendanceCorrectionsModule } from '../../src/attendance-corrections/attendance-corrections.module';
import { DashboardModule } from '../../src/dashboard/dashboard.module';
import { CalendarModule } from '../../src/calendar/calendar.module';
import { ProjectsModule } from '../../src/projects/projects.module';
import { TasksModule } from '../../src/tasks/tasks.module';
import { SprintsModule } from '../../src/sprints/sprints.module';
import { ProjectRbacModule } from '../../src/projects/rbac/project-rbac.module';
import { ProjectStatusesModule } from '../../src/project-statuses/project-statuses.module';
import { LabelsModule } from '../../src/labels/labels.module';
import { TaskCommentsModule } from '../../src/task-comments/task-comments.module';
import { TaskAttachmentsModule } from '../../src/task-attachments/task-attachments.module';
import { TaskDashboardModule } from '../../src/task-dashboard/task-dashboard.module';
import { BranchContextMiddleware } from '../../src/common/branch/branch-context.middleware';
import { BranchContextInterceptor } from '../../src/common/branch/branch-context.interceptor';

/**
 * Faithful multi-branch slice of the production AppModule for e2e tests.
 *
 * Replicates the EXACT global wiring that governs branch behaviour — the
 * BranchContextMiddleware, the ordered BranchContextInterceptor + AuditInterceptor,
 * the per-controller JwtAuthGuard/RolesGuard, and the Prisma $use scoping (which
 * lives in PrismaService and applies globally). Heavy, branch-irrelevant modules
 * (chatbot/embeddings [ESM dynamic import], face-recognition/TensorFlow, projects,
 * payroll batches, schedule crons) are excluded so the suite boots fast and clean
 * in CI. Because branch scoping is enforced globally at the Prisma + interceptor
 * layer, this slice verifies the same behaviour production exhibits.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    // @Global(), and every gated controller in this slice puts DevModeGuard in
    // its @UseGuards — so leaving it out fails module resolution, not just the
    // dev-mode tests.
    DevModeModule,
    BranchesModule,
    DepartmentsModule,
    OrganizationHubModule,
    // Module hub aggregates, mirroring app.module.ts. Without these the e2e
    // app answers 404 on a route the real app serves.
    TalentModule,
    WorkplaceModule,
    EmployeesModule,
    AttendancesModule,
    // Was never mounted, so every /attendance-corrections/* request 404'd
    // rather than failing honestly (Phase 3, WP-0). Pulls NotificationsModule
    // -> WhatsAppModule + DiscordModule, both of which import only
    // PrismaModule + AuditModule by design, so the edge is cheap. The outbox
    // scheduler's @Cron is inert for the same reason as the line below.
    AttendanceCorrectionsModule,
    // Its @Cron is inert here: ScheduleModule.forRoot() is deliberately not
    // registered in this slice, so no scheduler ever fires during a test run.
    AttendanceIntegrationsModule,
    ContractsModule,
    RemindersModule,
    AssetsModule,
    TrainingModule,
    LettersModule,
    GrievancesModule,
    DocumentVaultModule,
    DocumentsModule,
    SystemSettingsModule,
    AuditModule,
    CopilotSettingsModule,
    // Supervisor / configurable approval-hierarchy feature + its dependencies.
    LeaveRequestsModule,
    // Was never mounted, so every /leave-requests/:id/attachments request 404'd
    // rather than failing honestly — the same class of lie Phase 3 found with
    // AttendanceCorrectionsModule. Pulls StorageModule only. Note that
    // StorageService falls back to LOCAL DISK when MinIO is unconfigured (and
    // falls back again when a configured MinIO fails), so an e2e upload really
    // writes a file under uploads/leave-attachments/ — which is why the leave
    // fixture's cleanup() unlinks them.
    LeaveAttachmentsModule,
    OvertimeModule,
    ApprovalsModule,
    SupervisorsModule,
    TeamsModule,
    // A real read surface that template fields now feed into.
    ExportModule,
    ProfileTemplatesModule,
    // Visa / legal documents. `visa-cron.e2e-spec.ts` reaches the service
    // directly, so the HTTP routes were never mounted here — every request to
    // /legal-documents answered 404 rather than failing honestly.
    LegalDocumentsModule,
    // Overtime Policy engine + the payroll run it feeds (daily-wage earnings and
    // per-policy overtime monetization are verified end to end against the DB).
    OvertimePolicyModule,
    HolidaysModule,
    SalaryComponentsModule,
    // Before PayrollsModule: `payrolls/reports/...` must be matched before
    // `payrolls/:id`, or every report name is read as a payroll id.
    PayrollsModule,
    PayrollBatchesModule,
    // EMPLOYMENT_TYPE items carry the payBasis flag that DERIVES an employee's
    // salaryType, so the pay-basis lifecycle can't be exercised without it.
    LibraryItemsModule,
    // Was never mounted, so /dashboard/attendance-summary 404'd (Phase 3, WP-0).
    // Imports PrismaModule + TimezoneModule only.
    DashboardModule,
    // Work schedules / shifts — the whole /calendar/* surface. Excluded until
    // now (the "schedule crons" in the note above), which is why the module had
    // no e2e coverage at all: every request to /calendar/* answered 404 rather
    // than failing honestly. Its ShiftNotificationScheduler carries a
    // @Cron('*/1 * * * *') that stays inert here for the same reason
    // AttendanceIntegrationsModule's does — ScheduleModule.forRoot() is not
    // registered in this slice — so the reminder rules have to be asserted by
    // calling the scheduler directly, never by waiting on a tick.
    CalendarModule,
    ProjectsModule,
    TasksModule,
    SprintsModule,
    ProjectRbacModule,
    ProjectStatusesModule,
    LabelsModule,
    TaskCommentsModule,
    TaskAttachmentsModule,
    TaskDashboardModule,
    // Payroll extensions. Gratuity and leave encashment reach the router
    // anyway, because PayrollsModule imports them for the lock seam — but
    // final settlements are imported by nothing else, so without this line the
    // routes 404 and every case asserting a refusal passes for the wrong reason.
    // Telegram channel. The outbound half arrives transitively through
    // NotificationsModule, but its ADMIN and self-service controllers do not —
    // and the webhook lives in the inbound leaf, so without these two lines
    // every /telegram/* route 404s and the cases asserting a refusal pass for
    // the wrong reason. Its @Cron is inert here, like every other scheduler in
    // this slice.
    TelegramModule,
    TelegramInboundModule,
  ],
  providers: [
    // Resolve + validate the effective branch BEFORE audit runs (same order as prod).
    { provide: APP_INTERCEPTOR, useClass: BranchContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class TestAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(BranchContextMiddleware).forRoutes('*');
  }
}
