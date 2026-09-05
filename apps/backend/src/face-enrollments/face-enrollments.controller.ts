import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { FaceEnrollmentsService } from './face-enrollments.service';
import { CreateFaceEnrollmentDto } from './dto/create-face-enrollment.dto';
import { ListFaceEnrollmentsDto } from './dto/list-face-enrollments.dto';
import { VerifyFaceDto } from './dto/verify-face.dto';
import { RegisterFaceDto } from './dto/register-face.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Face Enrolments')
@ApiBearerAuth('JWT-auth')
@Controller('face-enrollments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FaceEnrollmentsController {
  constructor(private readonly service: FaceEnrollmentsService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'List face enrolments',
    description: 'The stored descriptor is never part of the response.',
  })
  findAll(@Query() query: ListFaceEnrollmentsDto) {
    return this.service.findAll(query);
  }

  // Declared before `employee/:employeeId` and any other parameterised route:
  // Express matches in declaration order, and `status` is a literal segment
  // that must not be read as an employee id.
  @Get('status')
  @ApiOperation({
    summary: 'Am I enrolled?',
    description:
      "The signed-in employee's own enrolment status. Counts and dates only — no template, and nothing about anybody else.",
  })
  status(@CurrentUser() user: Principal) {
    return this.service.statusFor(user.employeeId);
  }

  // Literal segments, declared before `employee/:employeeId` for the same
  // reason `status` is: Express matches in order and would read either as a
  // parameterised path otherwise.
  @Get('me')
  @ApiOperation({
    summary: "The signed-in employee's own enrolments",
    description:
      'Ids, reference photos, quality and dates. The template is not part of the response.',
  })
  mine(@CurrentUser() user: Principal) {
    return this.service.mine(user.employeeId);
  }

  @Get('counts')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'How many templates each employee holds',
    description:
      'Counted in the database, so the enrolment table reports a true total rather than the length of a page.',
  })
  counts() {
    return this.service.countsByEmployee();
  }

  @Get('employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: "One employee's enrolments" })
  findByEmployee(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.service.findByEmployee(employeeId);
  }

  /**
   * Open to every signed-in caller because it is the door a terminal punch goes
   * through, and the person at the terminal is an employee. It leaks nothing
   * about somebody else: an unsuccessful probe is told only that it failed.
   */
  @Post('verify')
  @ApiOperation({
    summary: 'Verify a face against the enrolled templates',
    description:
      'Takes a probe descriptor and answers with a match and a confidence. The stored templates are never part of the response, and a failed match does not name the closest candidate.',
  })
  verify(@Body() dto: VerifyFaceDto) {
    return this.service.verify(dto);
  }

  /**
   * Open to every signed-in caller because enrolling YOURSELF is the whole
   * point of the self-service screen. Enrolling somebody else needs ADMIN or
   * HR_MANAGER, which the service checks — the decorator cannot, because the
   * answer depends on whose record the body names.
   */
  @Post('register')
  @ApiOperation({
    summary: 'Enrol from a captured photo',
    description:
      'The server computes the template from the frame. The browser has no recogniser, and a template built by a different model than the one that matches it recognises nobody.',
  })
  register(@Body() dto: RegisterFaceDto, @CurrentUser() user: Principal) {
    return this.service.register(dto, user);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Enrol a pre-computed face template',
    description:
      'For a terminal that ran the recogniser itself. A browser sends a photo to /register instead.',
  })
  create(@Body() dto: CreateFaceEnrollmentDto) {
    return this.service.create(dto);
  }

  /** Ownership is checked in the service — see the note on `removeFor`. */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a face enrolment',
    description:
      "HR may delete anybody's; everybody else may delete only their own.",
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.removeFor(id, user);
  }
}
