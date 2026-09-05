import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { EmployeesModule } from './employees/employees.module';
import { DepartmentsModule } from './departments/departments.module';
import { BranchesModule } from './branches/branches.module';
import { OrganizationModule } from './organization/organization.module';
import { TeamsModule } from './teams/teams.module';
import { ContractsModule } from './contracts/contracts.module';
import { LegalDocumentsModule } from './legal-documents/legal-documents.module';
import { AttendancesModule } from './attendances/attendances.module';
import { AttendanceCorrectionsModule } from './attendance-corrections/attendance-corrections.module';
import { WorkSchedulesModule } from './work-schedules/work-schedules.module';
import { SchedulesModule } from './schedules/schedules.module';
import { HolidaysModule } from './holidays/holidays.module';
import { FaceEnrollmentsModule } from './face-enrollments/face-enrollments.module';
import { SystemSettingsModule } from './system-settings/system-settings.module';
import { LibraryItemsModule } from './library-items/library-items.module';
import { LeaveBalancesModule } from './leave-balances/leave-balances.module';
import { LeaveAttachmentsModule } from './leave-attachments/leave-attachments.module';
import { LeaveRequestsModule } from './leave-requests/leave-requests.module';
import { OvertimePolicyModule } from './overtime-policy/overtime-policy.module';
import { OvertimeModule } from './overtime/overtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    EmployeesModule,
    DepartmentsModule,
    BranchesModule,
    OrganizationModule,
    TeamsModule,
    ContractsModule,
    LegalDocumentsModule,
    AttendancesModule,
    AttendanceCorrectionsModule,
    WorkSchedulesModule,
    SchedulesModule,
    HolidaysModule,
    FaceEnrollmentsModule,
    SystemSettingsModule,
    LibraryItemsModule,
    LeaveBalancesModule,
    // Listed BEFORE LeaveRequestsModule so `/leave-requests/:id/attachments` is
    // matched before `/leave-requests/:id` can claim the prefix.
    LeaveAttachmentsModule,
    LeaveRequestsModule,
    OvertimePolicyModule,
    OvertimeModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
