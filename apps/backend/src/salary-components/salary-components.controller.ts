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
import { SalaryComponentsService } from './salary-components.service';
import { CreateSalaryComponentDto } from './dto/create-salary-component.dto';
import { UpdateSalaryComponentDto } from './dto/update-salary-component.dto';
import { ListSalaryComponentsDto } from './dto/list-salary-components.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Payroll')
@ApiBearerAuth('JWT-auth')
@Controller('salary-components')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
export class SalaryComponentsController {
  constructor(private readonly service: SalaryComponentsService) {}

  @Get()
  @ApiOperation({ summary: 'List salary components' })
  findAll(@Query() query: ListSalaryComponentsDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one salary component' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({ summary: 'Create a salary component' })
  create(@Body() dto: CreateSalaryComponentDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({ summary: 'Update a salary component' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSalaryComponentDto,
  ) {
    return this.service.update(id, dto);
  }

  // No DELETE. A component behind a payslip line must keep resolving, so it is
  // retired rather than removed.
  @Post(':id/deactivate')
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({ summary: 'Retire a salary component' })
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.deactivate(id);
  }

  @Post(':id/activate')
  @Roles(UserRole.ADMIN, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'Put a retired salary component back in the catalogue',
  })
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.activate(id);
  }
}
