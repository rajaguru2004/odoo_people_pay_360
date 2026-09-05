import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { OvertimePolicyService } from './overtime-policy.service';
import { CreateOvertimePolicyDto } from './dto/create-overtime-policy.dto';
import { UpdateOvertimePolicyDto } from './dto/update-overtime-policy.dto';
import { AssignOvertimePolicyDto } from './dto/assign-overtime-policy.dto';

@ApiTags('Overtime Policies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('overtime-policies')
@AuditResource('OvertimePolicy')
export class OvertimePolicyController {
  constructor(private readonly service: OvertimePolicyService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List overtime policies' })
  list() {
    return this.service.list();
  }

  @Post()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create an overtime policy' })
  create(@CurrentUser() user: any, @Body() dto: CreateOvertimePolicyDto) {
    return this.service.create(dto, user?.id);
  }

  @Patch('assign')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Assign employment type / policy override to an employee' })
  assign(@CurrentUser() user: any, @Body() dto: AssignOvertimePolicyDto) {
    return this.service.assign(dto, user?.id);
  }

  @Get('resolve/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Resolve the effective overtime policy for an employee' })
  resolve(@Param('employeeId') employeeId: string) {
    return this.service.resolveForEmployee(employeeId);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Get an overtime policy' })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Update an overtime policy' })
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateOvertimePolicyDto,
  ) {
    return this.service.update(id, dto, user?.id);
  }

  @Patch(':id/default')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Set an overtime policy as the company default' })
  setDefault(@CurrentUser() user: any, @Param('id') id: string) {
    return this.service.setDefault(id, user?.id);
  }

  @Patch(':id/active')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Activate / deactivate an overtime policy' })
  setActive(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
  ) {
    return this.service.setActive(id, isActive, user?.id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete an overtime policy' })
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.service.remove(id, user?.id);
  }
}
