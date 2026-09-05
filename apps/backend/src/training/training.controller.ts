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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { TrainingService } from './training.service';
import { TrainingNeedsService } from './training-needs.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { CreateSessionDto } from './dto/create-session.dto';
import { NominateDto } from './dto/nominate.dto';
import { DecideNominationDto } from './dto/decide-nomination.dto';
import { RecordAttendanceDto } from './dto/record-attendance.dto';

@ApiTags('Training')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('training')
@AuditResource('TrainingNomination')
export class TrainingController {
  constructor(
    private readonly training: TrainingService,
    private readonly needs: TrainingNeedsService,
  ) {}

  // ── Course catalogue ──────────────────────────────────────────────────────

  @Get('stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Courses, sessions and nominations at a glance' })
  stats() {
    return this.training.stats();
  }

  @Get('courses')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Course catalogue' })
  listCourses(@Query('activeOnly') activeOnly?: string) {
    return this.training.listCourses(activeOnly === 'true');
  }

  @Post('courses')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Add a course to the catalogue' })
  createCourse(@CurrentUser() user: any, @Body() dto: CreateCourseDto) {
    return this.training.createCourse(dto, user.id);
  }

  @Patch('courses/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update a course' })
  updateCourse(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Partial<CreateCourseDto>,
  ) {
    return this.training.updateCourse(id, dto, user.id);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  @Get('sessions')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Scheduled training sessions' })
  listSessions(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.training.listSessions({ status, from, to });
  }

  @Post('sessions')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Schedule a session of a course' })
  createSession(@CurrentUser() user: any, @Body() dto: CreateSessionDto) {
    return this.training.createSession(dto, user.id);
  }

  // ── Appraisal-derived needs (the differentiator) ──────────────────────────

  @Get('needs/from-run/:runId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary:
      'Derive training needs from a completed AI appraisal run. Returns suggestions a human confirms — it never nominates anyone.',
  })
  needsFromRun(
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query('all') all?: string,
  ) {
    return this.needs.deriveFromRun(runId, {
      // Default narrows to COACH/PIP — the results that actually signal a need.
      onlyDevelopmentRecommendations: all !== 'true',
    });
  }

  // ── Nominations ───────────────────────────────────────────────────────────

  @Get('my-training')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: "The current user's own training record" })
  myTraining(@CurrentUser() user: any) {
    if (!user?.employeeId) return { success: true, data: [] };
    return this.training.findByEmployee(user.employeeId);
  }

  @Get('nominations')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'List nominations' })
  listNominations(
    @CurrentUser() user: any,
    @Query('sessionId') sessionId?: string,
    @Query('status') status?: string,
  ) {
    return this.training.listNominations({ sessionId, status }, user);
  }

  @Post('nominations')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary:
      'Nominate an employee. Pass source=APPRAISAL + appraisalResultId to keep the provenance of an appraisal-derived need.',
  })
  nominate(@CurrentUser() user: any, @Body() dto: NominateDto) {
    return this.training.nominate(dto, user);
  }

  @Post('nominations/:id/approve')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Approve a nomination' })
  approve(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideNominationDto,
  ) {
    return this.training.decide(id, user, 'APPROVE', dto);
  }

  @Post('nominations/:id/reject')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Reject a nomination' })
  reject(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideNominationDto,
  ) {
    return this.training.decide(id, user, 'REJECT', dto);
  }

  @Post('nominations/:id/attendance')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary:
      'Record attendance, score and certificate. Certificate expiry is derived from the course validity window and feeds the reminder engine.',
  })
  recordAttendance(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordAttendanceDto,
  ) {
    return this.training.recordAttendance(id, dto, user.id);
  }

  @Delete('nominations/:id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Cancel a nomination and withdraw any claim it raised' })
  cancel(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.training.cancelNomination(id, user);
  }
}
