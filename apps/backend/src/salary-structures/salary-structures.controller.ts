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
import { SalaryStructuresService } from './salary-structures.service';
import { CreateSalaryStructureDto } from './dto/create-salary-structure.dto';
import { UpdateSalaryStructureDto } from './dto/update-salary-structure.dto';
import { ListSalaryStructuresDto } from './dto/list-salary-structures.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Payroll')
@ApiBearerAuth('JWT-auth')
@Controller('salary-structures')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
export class SalaryStructuresController {
  constructor(private readonly service: SalaryStructuresService) {}

  @Get()
  @ApiOperation({
    summary: 'The assignment register',
    description:
      'Who is on a salary structure, with the line count and the summed gross.',
  })
  findAll(@Query() query: ListSalaryStructuresDto) {
    return this.service.findAll(query);
  }

  // Declared before `:id`. Express matches in declaration order, so with `:id`
  // first the literal segment would be handed to ParseUUIDPipe and every
  // request for an employee's structure would 400.
  @Get('employee/:employeeId')
  @ApiOperation({ summary: "One employee's salary structure" })
  findByEmployee(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.service.findByEmployee(employeeId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one salary structure with its lines' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({ summary: 'Assign a salary structure to an employee' })
  create(@Body() dto: CreateSalaryStructureDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'Update a salary structure',
    description:
      'Supplying `lines` REPLACES the whole set rather than merging.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSalaryStructureDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Delete a salary structure',
    description: 'Refused once the employee has any payslip.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
