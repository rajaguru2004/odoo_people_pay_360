import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { SupervisorsService } from './supervisors.service';
import {
  AssignSupervisorDto,
  BulkAssignSupervisorDto,
} from './dto/assign-supervisor.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

/**
 * The shape the list routes answer with.
 *
 * The count travels beside the rows rather than being read off `data.length`,
 * because a supervisor's team size is printed on screens that never render the
 * list. It rides in `meta`, which the standard envelope already carries — the
 * interceptor passes through anything that already has `success` on it, so a
 * route needs no nested container of its own. A `{ count, data }` object under
 * `data` would make these the only endpoints in the system whose rows sit two
 * levels deep.
 */
function team<T>(rows: T[]) {
  return { success: true as const, data: rows, meta: { count: rows.length } };
}

@ApiTags('Supervisors')
@ApiBearerAuth('JWT-auth')
@Controller('supervisors')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SupervisorsController {
  constructor(private readonly supervisors: SupervisorsService) {}

  // 'my-team' is declared before the parameterised routes so it is never
  // swallowed as an id.
  @Get('my-team')
  @ApiOperation({ summary: 'Everyone the caller supervises' })
  async myTeam(@CurrentUser() user: Principal) {
    // A user account need not be attached to an employee record — an
    // administrator who is not a member of staff is the ordinary reason. They
    // supervise nobody rather than raising an error.
    if (!user?.employeeId) return team([]);
    return team(await this.supervisors.reports(user.employeeId));
  }

  @Post('assign')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Route one employee to a supervisor' })
  assign(@CurrentUser() user: Principal, @Body() dto: AssignSupervisorDto) {
    return this.supervisors.assign(dto.employeeId, dto.supervisorId, user?.id);
  }

  @Post('bulk-assign')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Route several employees to one supervisor' })
  async bulkAssign(
    @CurrentUser() user: Principal,
    @Body() dto: BulkAssignSupervisorDto,
  ) {
    return team(
      await this.supervisors.bulkAssign(
        dto.employeeIds,
        dto.supervisorId,
        user?.id,
      ),
    );
  }

  @Delete('assignment/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Detach an employee from their supervisor' })
  unassign(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    return this.supervisors.unassign(employeeId, user?.id);
  }

  @Get('reports/:supervisorId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'Everyone a named supervisor signs for' })
  async reports(@Param('supervisorId', ParseUUIDPipe) supervisorId: string) {
    return team(await this.supervisors.reports(supervisorId));
  }

  @Get('of/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: "One employee's supervisor" })
  supervisorOf(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.supervisors.supervisorOf(employeeId);
  }
}
