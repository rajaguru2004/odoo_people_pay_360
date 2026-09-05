import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  ParseIntPipe,
  ForbiddenException,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { SalaryComponentsService } from './salary-components.service';
import { CreateSalaryComponentDto } from './dto/create-salary-component.dto';
import { UpdateSalaryComponentDto } from './dto/update-salary-component.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Salary Components')
@Controller('salary-components')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
@AuditResource('SalaryComponent')
export class SalaryComponentsController {
  constructor(
    private readonly salaryComponentsService: SalaryComponentsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Create new salary component',
    description:
      'Create salary component for employee (basic salary, allowance, bonus)',
  })
  @ApiResponse({ status: 201, description: 'Created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid data' })
  create(@Body() createDto: CreateSalaryComponentDto) {
    return this.salaryComponentsService.create(createDto);
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get list of salary components',
    description: 'Get list of all salary components with filters',
  })
  @ApiQuery({ name: 'employeeId', required: false, type: String })
  @ApiQuery({ name: 'componentType', required: false, type: String })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List retrieved successfully' })
  findAll(
    @Query('employeeId') employeeId?: string,
    @Query('componentType') componentType?: string,
    @Query('isActive') isActive?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.salaryComponentsService.findAll(
      employeeId,
      componentType,
      isActive !== undefined ? isActive === 'true' : undefined,
      page,
      limit,
    );
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Get salary components by employee',
    description: 'Get all active salary components for an employee',
  })
  @ApiResponse({ status: 200, description: 'Retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Employee not found' })
  async findByEmployee(
    @CurrentUser() user: any,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    // MANAGER: can only view salary components for own dept employees
    if (user?.role === 'MANAGER') {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { departmentId: true },
      });
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to view employees outside your department.',
        );
      }
    }
    return this.salaryComponentsService.findByEmployee(employeeId);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get salary component details',
    description: 'Get detailed information for a salary component',
  })
  @ApiResponse({ status: 200, description: 'Retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.salaryComponentsService.findOne(id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Update salary component',
    description: 'Update salary component information',
  })
  @ApiResponse({ status: 200, description: 'Updated successfully' })
  @ApiResponse({ status: 404, description: 'Not found' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateSalaryComponentDto,
  ) {
    return this.salaryComponentsService.update(id, updateDto);
  }

  @Post(':id/deactivate')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Deactivate salary component',
    description: 'Mark salary component as no longer active',
  })
  @ApiResponse({ status: 200, description: 'Deactivated successfully' })
  @ApiResponse({ status: 404, description: 'Not found' })
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.salaryComponentsService.deactivate(id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Delete salary component',
    description: 'Permanently delete salary component (Admin only)',
  })
  @ApiResponse({ status: 200, description: 'Deleted successfully' })
  @ApiResponse({ status: 404, description: 'Not found' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.salaryComponentsService.remove(id);
  }
}
