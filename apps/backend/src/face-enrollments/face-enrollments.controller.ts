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

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Enrol a face template' })
  create(@Body() dto: CreateFaceEnrollmentDto) {
    return this.service.create(dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Delete a face enrolment' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
