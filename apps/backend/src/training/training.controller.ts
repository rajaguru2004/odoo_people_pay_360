import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { TrainingService } from './training.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { CreateSessionDto } from './dto/create-session.dto';
import { NominateDto } from './dto/nominate.dto';
import { DecideNominationDto } from './dto/decide-nomination.dto';
import { RecordAttendanceDto } from './dto/record-attendance.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Training')
@ApiBearerAuth('JWT-auth')
@Controller('training')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TrainingController {
  constructor(private readonly training: TrainingService) {}

  @Get('stats')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Courses, sessions and nominations at a glance' })
  stats() {
    return this.training.stats();
  }

  // ── Course catalogue ───────────────────────────────────────────────────────

  @Get('courses')
  @ApiOperation({ summary: 'The course catalogue' })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  listCourses(@Query('activeOnly') activeOnly?: string) {
    return this.training.listCourses(activeOnly === 'true');
  }

  @Post('courses')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Add a course to the catalogue' })
  createCourse(@Body() dto: CreateCourseDto) {
    return this.training.createCourse(dto);
  }

  @Patch('courses/:id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Edit a course' })
  updateCourse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourseDto,
  ) {
    return this.training.updateCourse(id, dto);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  @Get('sessions')
  @ApiOperation({ summary: 'Scheduled sessions' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  listSessions(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.training.listSessions({ status, from, to });
  }

  @Post('sessions')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Schedule a session of a course' })
  createSession(@Body() dto: CreateSessionDto) {
    return this.training.createSession(dto);
  }

  // ── Nominations ────────────────────────────────────────────────────────────

  @Get('my-training')
  @ApiOperation({ summary: "The caller's own training record" })
  myTraining(@CurrentUser() user: Principal) {
    if (!user?.employeeId) return [];
    return this.training.findByEmployee(user.employeeId);
  }

  @Get('nominations')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'Nominations, narrowed to a manager’s departments' })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'status', required: false })
  listNominations(
    @CurrentUser() user: Principal,
    @Query('sessionId') sessionId?: string,
    @Query('status') status?: string,
  ) {
    return this.training.listNominations({ sessionId, status }, user);
  }

  @Post('nominations')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'Nominate an employee for a session' })
  nominate(@CurrentUser() user: Principal, @Body() dto: NominateDto) {
    return this.training.nominate(dto, user);
  }

  @Post('nominations/:id/approve')
  @ApiOperation({ summary: 'Approve a nomination' })
  approve(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideNominationDto,
  ) {
    return this.training.decide(id, user, 'APPROVE', dto);
  }

  @Post('nominations/:id/reject')
  @ApiOperation({ summary: 'Reject a nomination' })
  reject(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideNominationDto,
  ) {
    return this.training.decide(id, user, 'REJECT', dto);
  }

  @Post('nominations/:id/attendance')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Record attendance, score and certificate',
    description:
      'The certificate expiry is derived from the course validity window and the attendance date.',
  })
  recordAttendance(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordAttendanceDto,
  ) {
    return this.training.recordAttendance(id, dto, user.id);
  }

  @Delete('nominations/:id')
  @ApiOperation({ summary: 'Cancel a nomination' })
  cancel(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.training.cancelNomination(id, user);
  }
}
