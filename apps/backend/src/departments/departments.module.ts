import { Module } from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import { DepartmentsController } from './departments.controller';
import { DepartmentChangeRequestsService } from './change-requests/department-change-requests.service';
import { DepartmentChangeRequestsController } from './change-requests/department-change-requests.controller';

@Module({
  // Order matters. Nest registers routes in this order and Express matches the
  // first that fits, so the change-request routes have to be declared before
  // DepartmentsController's `:id` or `departments/change-requests` is read as a
  // department id and rejected by ParseUUIDPipe.
  controllers: [DepartmentChangeRequestsController, DepartmentsController],
  providers: [DepartmentsService, DepartmentChangeRequestsService],
  exports: [DepartmentsService],
})
export class DepartmentsModule {}
