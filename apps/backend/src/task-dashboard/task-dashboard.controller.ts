import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TaskDashboardService } from './task-dashboard.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Task Dashboard')
@ApiBearerAuth('JWT-auth')
@Controller('task-dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TaskDashboardController {
  constructor(private readonly service: TaskDashboardService) {}

  @Get('employee')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Employee task dashboard — tasks, hours, timer, recent tasks',
  })
  getEmployeeDashboard(@CurrentUser() user: any) {
    return this.service.getEmployeeDashboard(user);
  }

  @Get('manager')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary:
      'Manager dashboard — team task summary, timesheet approvals, workload',
  })
  getManagerDashboard(@CurrentUser() user: any) {
    return this.service.getManagerDashboard(user);
  }
}
