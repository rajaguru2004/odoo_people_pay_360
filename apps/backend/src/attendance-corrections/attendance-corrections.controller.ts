import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AttendanceCorrectionsService } from './attendance-corrections.service';
import { ListCorrectionsDto } from './dto/list-corrections.dto';
import { CreateCorrectionDto } from './dto/create-correction.dto';
import { ReviewCorrectionDto } from './dto/review-correction.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Attendance Corrections')
@ApiBearerAuth('JWT-auth')
@Controller('attendance-corrections')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceCorrectionsController {
  constructor(private readonly service: AttendanceCorrectionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List correction requests',
    description:
      'An EMPLOYEE caller sees only their own, whatever they filter by.',
  })
  findAll(@Query() query: ListCorrectionsDto, @CurrentUser() user: Principal) {
    return this.service.findAll(query, user);
  }

  // Declared before `:id` — Express matches in declaration order, and with
  // `:id` first the literal `stats` segment would reach ParseUUIDPipe.
  @Get('stats')
  @ApiOperation({ summary: 'Queue counts and average time to resolve' })
  stats(@CurrentUser() user: Principal) {
    return this.service.stats(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one correction request' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.findOne(id, user);
  }

  @Post()
  @ApiOperation({
    summary: 'Raise a correction for yourself',
    description: 'Snapshots the current times on the row, if there is one.',
  })
  create(@Body() dto: CreateCorrectionDto, @CurrentUser() user: Principal) {
    return this.service.create(dto, user);
  }

  @Patch(':id/review')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Approve or reject a correction',
    description:
      'Approving writes the requested times onto the attendance row and stamps it MANUAL.',
  })
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewCorrectionDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.review(id, dto, user);
  }

  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Withdraw a pending correction',
    description: 'The employee who raised it, or an administrator.',
  })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.cancel(id, user);
  }
}
