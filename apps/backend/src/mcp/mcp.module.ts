import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AttendanceCorrectionsModule } from '../attendance-corrections/attendance-corrections.module';
import { AttendancesModule } from '../attendances/attendances.module';
import { AuditModule } from '../audit/audit.module';
import { CalendarModule } from '../calendar/calendar.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { DepartmentsModule } from '../departments/departments.module';
import { EmployeesModule } from '../employees/employees.module';
import { HolidaysModule } from '../holidays/holidays.module';
import { LeaveBalancesModule } from '../leave-balances/leave-balances.module';
import { LeaveRequestsModule } from '../leave-requests/leave-requests.module';
import { LegalDocumentsModule } from '../legal-documents/legal-documents.module';
import { AssetsModule } from '../assets/assets.module';
import { TravelModule } from '../travel/travel.module';
import { TrainingModule } from '../training/training.module';
import { BudgetsModule } from '../budgets/budgets.module';
import { PayrollsModule } from '../payrolls/payrolls.module';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { IdEnricherService } from './id-enricher.service';
import { McpAuditHelper } from './mcp-audit.helper';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp-server.factory';
import { ToolExecutorService } from './tool-executor.service';
import { ToolCallerService } from './tool-caller.service';
import { OvertimeTools } from './tools/overtime.tools';
import { ReimbursementTools } from './tools/reimbursements.tools';
import { ChannelVerificationModule } from '../common/verification/channel-verification.module';
import { OvertimeModule } from '../overtime/overtime.module';
import { ReimbursementsModule } from '../reimbursements/reimbursements.module';
import { ToolRegistryService } from './tool-registry.service';
import { DomainToolProvider, MCP_TOOL_PROVIDERS } from './tool.types';
import { AnalyticsTools } from './tools/analytics.tools';
import { AttendanceTools } from './tools/attendance.tools';
import { DepartmentTools } from './tools/departments.tools';
import { EmployeeTools } from './tools/employees.tools';
import { ProfileTemplatesModule } from '../profile-templates/profile-templates.module';
import { HolidayTools } from './tools/holidays.tools';
import { LeaveTools } from './tools/leave.tools';
import { PayrollTools } from './tools/payroll.tools';
import { ProjectTools } from './tools/projects.tools';
import { ReportTools } from './tools/reports.tools';
import { ShiftTools } from './tools/shifts.tools';
import { TaskTools } from './tools/tasks.tools';
import { VisaTools } from './tools/visa.tools';
import { AssetsTools } from './tools/assets.tools';
import { TravelTools } from './tools/travel.tools';
import { TrainingTools } from './tools/training.tools';
import { BudgetsTools } from './tools/budgets.tools';
import { SupervisorTools } from './tools/supervisor.tools';
import { ApprovalsTools } from './tools/approvals.tools';
import { OvertimePolicyTools } from './tools/overtime-policy.tools';
import { LoanTools } from './tools/loans.tools';
import { AdvanceLoansModule } from '../advance-loans/advance-loans.module';
import { BankDetailsTools } from './tools/bank-details.tools';
import { SupervisorsModule } from '../supervisors/supervisors.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { OvertimePolicyModule } from '../overtime-policy/overtime-policy.module';
import { BankDetailsModule } from '../bank-details/bank-details.module';

@Module({
  imports: [
    AuditModule,
    // Loan tools delegate to the loan services, which own the ACL.
    AdvanceLoansModule,
    EmployeesModule,
    ProfileTemplatesModule,
    LeaveRequestsModule,
    LeaveBalancesModule,
    PayrollsModule,
    CalendarModule,
    DepartmentsModule,
    ProjectsModule,
    TasksModule,
    AttendancesModule,
    AttendanceCorrectionsModule,
    HolidaysModule,
    DashboardModule,
    AnalyticsModule,
    LegalDocumentsModule,
    AssetsModule,
    TravelModule,
    TrainingModule,
    BudgetsModule,
    SupervisorsModule,
    ApprovalsModule,
    OvertimePolicyModule,
    BankDetailsModule,
    OvertimeModule,
    ReimbursementsModule,
    // Prisma-only, so importing it cannot introduce a cycle. The attendance
    // tools need spendFaceProof to turn a verification receipt into `byFace`.
    ChannelVerificationModule,
  ],
  controllers: [McpController],
  providers: [
    McpServerFactory,
    ToolExecutorService,
    ToolCallerService,
    ToolRegistryService,
    McpAuditHelper,
    IdEnricherService,
    OvertimeTools,
    EmployeeTools,
    LeaveTools,
    PayrollTools,
    ShiftTools,
    DepartmentTools,
    ProjectTools,
    TaskTools,
    AttendanceTools,
    HolidayTools,
    ReportTools,
    AnalyticsTools,
    VisaTools,
    AssetsTools,
    TravelTools,
    TrainingTools,
    BudgetsTools,
    SupervisorTools,
    ApprovalsTools,
    OvertimePolicyTools,
    LoanTools,
    BankDetailsTools,
    ReimbursementTools,
    {
      provide: MCP_TOOL_PROVIDERS,
      useFactory: (...providers: DomainToolProvider[]) => providers,
      inject: [
        ReimbursementTools,
        EmployeeTools,
        LeaveTools,
        PayrollTools,
        ShiftTools,
        DepartmentTools,
        ProjectTools,
        TaskTools,
        AttendanceTools,
        HolidayTools,
        ReportTools,
        AnalyticsTools,
        VisaTools,
        AssetsTools,
        TravelTools,
        TrainingTools,
        BudgetsTools,
        SupervisorTools,
        ApprovalsTools,
        OvertimePolicyTools,
        LoanTools,
        BankDetailsTools,
        OvertimeTools,
      ],
    },
  ],
  // Exported so in-process callers (the copilot transport, the WhatsApp
  // channel) can invoke tools directly without a loopback HTTP hop. External
  // /mcp is unaffected.
  exports: [ToolRegistryService, ToolExecutorService, ToolCallerService],
})
export class McpModule {}
