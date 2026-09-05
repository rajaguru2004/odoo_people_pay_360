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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { EmployeeRecoveriesService } from './employee-recoveries.service';

@ApiTags('Employee recoveries')
@ApiBearerAuth('JWT-auth')
@Controller('employee-recoveries')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('EmployeeRecovery')
export class EmployeeRecoveriesController {
  constructor(private readonly service: EmployeeRecoveriesService) {}

  @Get('kinds')
  @Roles('ADMIN', 'HR_MANAGER')
  kinds() {
    return this.service.kinds();
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Raise a recovery',
    description:
      'Asset damage, an unreturned asset, a training bond or a notice ' +
      'shortfall. Recovered last and never below the take-home floor.',
  })
  create(@Body() dto: Record<string, unknown>, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  findByEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @CurrentUser() user: any,
  ) {
    return this.service
      .findByEmployee(employeeId, user)
      .then((r) => r);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.findOne(id, user).then((data) => ({ success: true, data }));
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: any,
  ) {
    return this.service.update(id, dto, user);
  }

  @Patch(':id/waive')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Forgive the outstanding balance',
    description:
      'The only thing that erases a balance, and it demands a reason. ADMIN ' +
      'only, mirroring the garnishment waiver.',
  })
  waive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.service.waive(id, dto?.reason, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Cancel a recovery',
    description:
      'A flag flip, never a delete: runs already generated under it reference ' +
      'it, and deleting would leave those payslips with a deduction nothing ' +
      'explains.',
  })
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.cancel(id, user);
  }
}
