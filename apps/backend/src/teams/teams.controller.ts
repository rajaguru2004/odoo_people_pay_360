import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { TeamsService } from './teams.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { AddTeamMemberDto } from './dto/add-team-member.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Teams')
@ApiBearerAuth('JWT-auth')
@Controller('teams')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Team')
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Get all teams',
    description: 'List all active teams',
  })
  @ApiQuery({
    name: 'departmentId',
    required: false,
    description: 'Filter by department',
  })
  @ApiResponse({ status: 200, description: 'Teams retrieved successfully' })
  findAll(
    @CurrentUser() user: any,
    @Query('departmentId') departmentId?: string,
  ) {
    return this.teamsService.findAll(user, departmentId);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Get team by ID',
    description: 'Get detailed team information with members',
  })
  @ApiParam({ name: 'id', description: 'Team UUID' })
  @ApiResponse({ status: 200, description: 'Team found' })
  @ApiResponse({ status: 404, description: 'Team not found' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.teamsService.findOne(id, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Create team', description: 'Create a new team' })
  @ApiResponse({ status: 201, description: 'Team created successfully' })
  @ApiResponse({ status: 409, description: 'Team code already exists' })
  create(@CurrentUser() user: any, @Body() createTeamDto: CreateTeamDto) {
    return this.teamsService.create(createTeamDto, user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Update team',
    description: 'Update team information',
  })
  @ApiParam({ name: 'id', description: 'Team UUID' })
  @ApiResponse({ status: 200, description: 'Team updated successfully' })
  @ApiResponse({ status: 404, description: 'Team not found' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() updateTeamDto: UpdateTeamDto,
  ) {
    return this.teamsService.update(id, updateTeamDto, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Delete team',
    description: 'Soft delete team (must have no members)',
  })
  @ApiParam({ name: 'id', description: 'Team UUID' })
  @ApiResponse({ status: 200, description: 'Team deleted successfully' })
  @ApiResponse({ status: 400, description: 'Cannot delete team with members' })
  @ApiResponse({ status: 404, description: 'Team not found' })
  delete(@CurrentUser() user: any, @Param('id') id: string) {
    return this.teamsService.delete(id, user);
  }

  // Team Member Management
  @Post(':id/members')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Add team member',
    description: 'Add an employee to the team',
  })
  @ApiParam({ name: 'id', description: 'Team UUID' })
  @ApiResponse({ status: 201, description: 'Member added successfully' })
  @ApiResponse({ status: 409, description: 'Employee is already a member' })
  addMember(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() addMemberDto: AddTeamMemberDto,
  ) {
    return this.teamsService.addMember(id, addMemberDto, user);
  }

  @Delete(':id/members/:memberId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Remove team member',
    description: 'Remove an employee from the team',
  })
  @ApiParam({ name: 'id', description: 'Team UUID' })
  @ApiParam({ name: 'memberId', description: 'Team member UUID' })
  @ApiResponse({ status: 200, description: 'Member removed successfully' })
  @ApiResponse({ status: 404, description: 'Team member not found' })
  removeMember(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ) {
    return this.teamsService.removeMember(id, memberId, user);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get employee teams',
    description: 'Get all teams an employee belongs to',
  })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Teams retrieved successfully' })
  getEmployeeTeams(@Param('employeeId') employeeId: string) {
    return this.teamsService.getEmployeeTeams(employeeId);
  }
}
