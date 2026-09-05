import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { EmployeeTransfersService } from './employee-transfers.service';

/**
 * Branch transfers.
 *
 * Approve and apply are ADMIN-only because a transfer crosses the branch
 * isolation axis — the one boundary every other guard in this system is built
 * to hold — and because applying one changes which branch's payroll pays
 * somebody.
 */
@ApiTags('Employee transfers')
@ApiBearerAuth('JWT-auth')
@Controller('employee-transfers')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('EmployeeTransfer')
export class EmployeeTransfersController {
  constructor(private readonly service: EmployeeTransfersService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  list(@Query('branchId') branchId?: string, @Query('status') status?: string) {
    return this.service.list(branchId, status);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  forEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.findForEmployee(employeeId, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Request a transfer',
    description:
      'A reason is required. `PATCH /employees/:id { branchId }` remains refused ' +
      'on purpose — this is a different route, not a looser form.',
  })
  request(@Body() dto: Record<string, unknown>, @CurrentUser() user: any) {
    return this.service.request(dto, user);
  }

  @Post(':id/approve')
  @Roles('ADMIN')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.approve(id, user);
  }

  @Post(':id/reject')
  @Roles('ADMIN')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.service.reject(id, dto?.reason, user);
  }

  @Post(':id/apply')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Move the employee',
    description:
      'Refused while a non-LOCKED payroll exists for the effective period in ' +
      'either branch: applying then would move who owns a run that is still open.',
  })
  apply(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.apply(id, user);
  }

  @Post(':id/cancel')
  @Roles('ADMIN', 'HR_MANAGER')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.cancel(id, user);
  }
}
