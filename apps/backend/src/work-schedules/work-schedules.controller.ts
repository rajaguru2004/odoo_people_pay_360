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
import { UserRole } from '@prisma/client';
import { WorkSchedulesService } from './work-schedules.service';
import { CreateWorkScheduleDto } from './dto/create-work-schedule.dto';
import { UpdateWorkScheduleDto } from './dto/update-work-schedule.dto';
import { ListWorkSchedulesDto } from './dto/list-work-schedules.dto';
import { BulkWorkScheduleDto } from './dto/bulk-work-schedule.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Work Schedules')
@ApiBearerAuth('JWT-auth')
@Controller('work-schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WorkSchedulesController {
  constructor(private readonly workSchedulesService: WorkSchedulesService) {}

  @Get()
  @ApiOperation({
    summary: 'List rostered shifts',
    description:
      'Only days that deviate from the branch calendar have a row at all.',
  })
  findAll(@Query() query: ListWorkSchedulesDto) {
    return this.workSchedulesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one rostered shift' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.workSchedulesService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Roster one shift' })
  create(@Body() dto: CreateWorkScheduleDto) {
    return this.workSchedulesService.create(dto);
  }

  @Post('bulk')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Lay a shift pattern over a date range',
    description:
      'Reports every day it created, replaced or left alone rather than failing the batch.',
  })
  bulk(@Body() dto: BulkWorkScheduleDto) {
    return this.workSchedulesService.bulk(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Edit a rostered shift' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkScheduleDto,
  ) {
    return this.workSchedulesService.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Remove a rostered shift',
    description: 'The day reverts to the branch calendar.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.workSchedulesService.remove(id);
  }
}
