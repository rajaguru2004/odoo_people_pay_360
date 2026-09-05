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
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { ListEmployeesDto } from './dto/list-employees.dto';
import { PeopleHubQueryDto } from './dto/people-hub-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Employees')
@ApiBearerAuth('JWT-auth')
@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @ApiOperation({ summary: 'List employees' })
  findAll(@Query() query: ListEmployeesDto) {
    return this.employeesService.findAll(query);
  }

  // Declared before `:id`. Express matches in declaration order, so with `:id`
  // first the literal `hub-summary` segment would be handed to ParseUUIDPipe
  // and the People hub would answer 400 on every load.
  @Get('hub-summary')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'People hub aggregate',
    description:
      'Headcount, lifecycle, contracts, terminations and the movement trend.',
  })
  hubSummary(@Query() query: PeopleHubQueryDto) {
    return this.employeesService.getPeopleHubSummary(query.months ?? 12);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one employee' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.findOne(id);
  }

  @Get(':id/team')
  @ApiOperation({ summary: 'Everyone this employee supervises' })
  findTeam(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.findTeam(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Create an employee' })
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Update an employee' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(id, dto);
  }

  @Patch(':id/terminate')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Terminate an employee',
    description: 'Soft exit — payslips keep resolving to this record.',
  })
  terminate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('exitDate') exitDate?: string,
  ) {
    return this.employeesService.terminate(id, exitDate);
  }
}
