import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DepartmentsModule } from '../departments/departments.module';
import { OrganizationHubController } from './organization-hub.controller';
import { OrganizationHubService } from './organization-hub.service';

/**
 * The Organization hub reads across departments, branches, employees and change
 * requests, so it belongs to none of them. A small module of its own keeps the
 * aggregate out of the services that own those writes — the same reason
 * `AttendanceHubService` was not bolted onto the 3.6k-line `AttendancesService`.
 */
@Module({
  imports: [PrismaModule, DepartmentsModule],
  controllers: [OrganizationHubController],
  providers: [OrganizationHubService],
  exports: [OrganizationHubService],
})
export class OrganizationHubModule {}
