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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

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

  @Get('employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: "One employee's enrolments" })
  findByEmployee(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.service.findByEmployee(employeeId);
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
