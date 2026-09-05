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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { GrievancesService } from './grievances.service';
import { CreateGrievanceDto } from './dto/create-grievance.dto';
import { UpdateGrievanceDto } from './dto/update-grievance.dto';
import { AddGrievanceNoteDto } from './dto/add-grievance-note.dto';

@ApiTags('Grievances')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('grievances')
@AuditResource('Grievance')
export class GrievancesController {
  constructor(private readonly grievances: GrievancesService) {}

  @Get('stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Open grievances, and how long the oldest has waited',
    description: 'Age matters more than count here — see the service comment.',
  })
  stats() {
    return this.grievances.stats();
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Grievances the caller may see. Non-HR see only their own and any assigned to them; nobody ever sees a grievance raised against themselves.',
  })
  findAll(@CurrentUser() user: any, @Query('status') status?: string) {
    return this.grievances.findAll({ status }, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Raise a grievance' })
  create(
    @CurrentUser() user: any,
    @Body() dto: CreateGrievanceDto,
    @Query('employeeId') employeeIdOverride?: string,
  ) {
    const employeeId =
      employeeIdOverride && ['ADMIN', 'HR_MANAGER'].includes(user?.role)
        ? employeeIdOverride
        : user.employeeId;
    return this.grievances.create(employeeId, dto, user);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Grievance detail with its trail. Internal handler notes are omitted for the complainant.',
  })
  findOne(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.grievances.findOne(id, user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update status, assignment or resolution' })
  update(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGrievanceDto,
  ) {
    return this.grievances.update(id, dto, user);
  }

  @Post(':id/notes')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Add a note to the trail' })
  addNote(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddGrievanceNoteDto,
  ) {
    return this.grievances.addNote(id, dto, user);
  }

  @Post(':id/withdraw')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Withdraw your own grievance' })
  withdraw(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.grievances.withdraw(id, user);
  }
}
