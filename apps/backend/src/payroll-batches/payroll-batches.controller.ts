import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { PayrollBatchesService } from './payroll-batches.service';
import { CreateBatchDto } from './dto/create-batch.dto';
import { UpdateBatchDto } from './dto/update-batch.dto';
import { AddBatchMembersDto } from './dto/add-members.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Payroll Batches')
@ApiBearerAuth('JWT-auth')
@Controller('payroll-batches')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'HR_MANAGER')
@AuditResource('PayrollBatch')
export class PayrollBatchesController {
  constructor(private readonly service: PayrollBatchesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all payroll batches' })
  async findAll() {
    return { success: true, data: await this.service.findAll() };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get payroll batch by ID' })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.service.findOne(id) };
  }

  @Post()
  @ApiOperation({ summary: 'Create a new payroll batch' })
  async create(@Body() dto: CreateBatchDto, @CurrentUser() user: any) {
    return {
      success: true,
      message: 'Payroll batch created successfully',
      data: await this.service.create(dto, user.id)
    };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a payroll batch' })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBatchDto) {
    return {
      success: true,
      message: 'Payroll batch updated successfully',
      data: await this.service.update(id, dto)
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a payroll batch' })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.remove(id);
    return {
      success: true,
      message: 'Payroll batch deleted successfully'
    };
  }

  @Post(':id/members')
  @ApiOperation({ summary: 'Add employees to a payroll batch' })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  async addMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddBatchMembersDto,
  ) {
    return {
      success: true,
      message: 'Members added successfully',
      data: await this.service.addMembers(id, dto.employeeIds)
    };
  }

  @Delete(':id/members/:empId')
  @ApiOperation({ summary: 'Remove an employee from a payroll batch' })
  @ApiParam({ name: 'id', description: 'Batch UUID' })
  @ApiParam({ name: 'empId', description: 'Employee UUID' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('empId', ParseUUIDPipe) empId: string,
  ) {
    return {
      success: true,
      message: 'Member removed successfully',
      data: await this.service.removeMember(id, empId)
    };
  }
}
