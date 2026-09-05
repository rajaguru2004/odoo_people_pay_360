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
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { GrievancesService } from './grievances.service';
import { CreateGrievanceDto } from './dto/create-grievance.dto';
import { UpdateGrievanceDto } from './dto/update-grievance.dto';
import { AddGrievanceNoteDto } from './dto/add-grievance-note.dto';
import { isGrievanceHandler } from './grievance-visibility.util';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Grievances')
@ApiBearerAuth('JWT-auth')
@Controller('grievances')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GrievancesController {
  constructor(private readonly grievances: GrievancesService) {}

  @Get('stats')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Open cases, and how long the oldest has waited',
    description: 'Age matters more than the count — see the service note.',
  })
  stats() {
    return this.grievances.stats();
  }

  @Get()
  @ApiOperation({
    summary: 'The grievances the caller may see',
    description:
      'Outside HR: only your own and any assigned to you. Nobody ever sees a ' +
      'grievance raised against themselves.',
  })
  @ApiQuery({ name: 'status', required: false })
  findAll(@CurrentUser() user: Principal, @Query('status') status?: string) {
    return this.grievances.findAll({ status }, user);
  }

  @Post()
  @ApiOperation({ summary: 'Raise a grievance' })
  @ApiQuery({
    name: 'employeeId',
    required: false,
    description: 'HR raising one on somebody else’s behalf',
  })
  create(
    @CurrentUser() user: Principal,
    @Body() dto: CreateGrievanceDto,
    @Query('employeeId') employeeIdOverride?: string,
  ) {
    const employeeId =
      employeeIdOverride && isGrievanceHandler(user)
        ? employeeIdOverride
        : user?.employeeId;
    return this.grievances.create(employeeId, dto, user);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One grievance and its trail',
    description: "Internal handler notes are omitted for the complainant.",
  })
  findOne(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.grievances.findOne(id, user);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Change status, handler or resolution' })
  update(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGrievanceDto,
  ) {
    return this.grievances.update(id, dto, user);
  }

  @Post(':id/notes')
  @ApiOperation({ summary: 'Add a note to the trail' })
  addNote(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddGrievanceNoteDto,
  ) {
    return this.grievances.addNote(id, dto, user);
  }

  @Post(':id/withdraw')
  @ApiOperation({ summary: 'Withdraw your own grievance' })
  withdraw(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.grievances.withdraw(id, user);
  }
}
