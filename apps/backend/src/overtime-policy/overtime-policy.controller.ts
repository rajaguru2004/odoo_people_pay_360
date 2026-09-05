import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { OvertimePolicyService } from './overtime-policy.service';
import { CreateOvertimePolicyDto } from './dto/create-overtime-policy.dto';
import { UpdateOvertimePolicyDto } from './dto/update-overtime-policy.dto';
import { AssignOvertimePolicyDto } from './dto/assign-overtime-policy.dto';
import { SetPolicyActiveDto } from './dto/set-policy-active.dto';

@ApiTags('Overtime Policies')
@ApiBearerAuth('JWT-auth')
@Controller('overtime-policies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OvertimePolicyController {
  constructor(private readonly service: OvertimePolicyService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'List overtime policies' })
  list() {
    return this.service.list();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create an overtime policy' })
  create(@Body() dto: CreateOvertimePolicyDto) {
    return this.service.create(dto);
  }

  // Declared before `:id` — Express matches in declaration order, and with the
  // parameterised route first the literal segment reaches ParseUUIDPipe.
  @Patch('assign')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Assign an employment type or a policy override to an employee',
  })
  assign(@Body() dto: AssignOvertimePolicyDto) {
    return this.service.assign(dto);
  }

  @Get('resolve/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({
    summary: 'Resolve the effective overtime policy for an employee',
    description: 'Reports which tier of the inheritance chain decided it.',
  })
  resolve(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return this.service.resolveForEmployee(employeeId);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Get an overtime policy' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update an overtime policy' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOvertimePolicyDto,
  ) {
    return this.service.update(id, dto);
  }

  @Patch(':id/default')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Set an overtime policy as the company default' })
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.setDefault(id);
  }

  @Patch(':id/active')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Activate or deactivate an overtime policy' })
  setActive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPolicyActiveDto,
  ) {
    return this.service.setActive(id, dto.isActive);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete an overtime policy' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}
