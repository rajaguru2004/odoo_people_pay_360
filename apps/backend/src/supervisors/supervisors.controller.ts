import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SupervisorsService } from './supervisors.service';
import {
  AssignSupervisorDto,
  BulkAssignSupervisorDto,
  CreateSupervisorTeamDto,
  UpdateSupervisorTeamDto,
} from './dto/assign-supervisor.dto';

@ApiTags('Supervisors')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('supervisors')
export class SupervisorsController {
  constructor(private readonly supervisors: SupervisorsService) {}

  @Post('assign')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Assign or reassign an employee to a supervisor' })
  assign(@CurrentUser() user: any, @Body() dto: AssignSupervisorDto) {
    return this.supervisors.assign(dto.employeeId, dto.supervisorId, user);
  }

  @Post('bulk-assign')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Assign many employees to one supervisor' })
  bulkAssign(@CurrentUser() user: any, @Body() dto: BulkAssignSupervisorDto) {
    return this.supervisors.bulkAssign(dto.employeeIds, dto.supervisorId, user);
  }

  @Delete('assignment/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Detach an employee from its supervisor' })
  unassign(@CurrentUser() user: any, @Param('employeeId') employeeId: string) {
    return this.supervisors.unassign(employeeId, user);
  }

  @Get('my-team')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Employees the current user supervises' })
  myTeam(@CurrentUser() user: any) {
    if (!user?.employeeId) {
      return { success: true, count: 0, data: [] };
    }
    return this.supervisors.reports(user.employeeId);
  }

  @Get('reports/:supervisorId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'List employees supervised by a supervisor' })
  reports(@Param('supervisorId') supervisorId: string) {
    return this.supervisors.reports(supervisorId);
  }

  @Get('of/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: "Get an employee's assigned supervisor" })
  supervisorOf(@Param('employeeId') employeeId: string) {
    return this.supervisors.supervisorOf(employeeId);
  }

  // ── Supervisor teams (named group + supervisor + members) ──────────────
  @Get('teams')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List supervisor teams' })
  listTeams() {
    return this.supervisors.listTeams();
  }

  @Get('teams/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Get a supervisor team' })
  getTeam(@Param('id') id: string) {
    return this.supervisors.getTeam(id);
  }

  @Post('teams')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Create a supervisor team (name + supervisor + members)' })
  createTeam(@CurrentUser() user: any, @Body() dto: CreateSupervisorTeamDto) {
    return this.supervisors.createTeam(dto, user);
  }

  @Patch('teams/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update a supervisor team' })
  updateTeam(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateSupervisorTeamDto,
  ) {
    return this.supervisors.updateTeam(id, dto, user);
  }

  @Delete('teams/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete a supervisor team' })
  deleteTeam(@CurrentUser() user: any, @Param('id') id: string) {
    return this.supervisors.deleteTeam(id, user);
  }
}
