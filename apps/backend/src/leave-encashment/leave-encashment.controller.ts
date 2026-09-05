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
import { LeaveEncashmentService } from './leave-encashment.service';

/**
 * Leave encashment, and the year-end carry-forward.
 *
 * Literal paths are declared before `:id` throughout, or `policies` and
 * `carry-forward` would be read as request ids.
 */
@ApiTags('Leave encashment')
@ApiBearerAuth('JWT-auth')
@Controller('leave-encashment')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('LeaveEncashmentRequest')
export class LeaveEncashmentController {
  constructor(private readonly service: LeaveEncashmentService) {}

  @Get('policies')
  @Roles('ADMIN', 'HR_MANAGER')
  listPolicies() {
    return this.service.listPolicies();
  }

  @Post('policies')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Set the policy for one leave type',
    description:
      'Omit branchId for the company-wide default. A branch policy overrides it.',
  })
  setPolicy(@Body() dto: Record<string, unknown>, @CurrentUser() user: any) {
    return this.service.setPolicy(dto, user?.id);
  }

  @Get('my-requests')
  myRequests(@CurrentUser() user: any) {
    // No id parameter, so this route cannot be pointed at anyone else.
    return this.service.listFor(user?.employeeId, user);
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  listFor(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.listFor(employeeId, user);
  }

  @Get('employee/:employeeId/quote')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'What could be encashed, and what limits it',
    description:
      'Read-only. Answers the number before anybody commits to anything, so a ' +
      'form can show it rather than refusing after submission.',
  })
  quote(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query('leaveTypeKey') leaveTypeKey: string,
    @Query('year') year: string,
    @CurrentUser() user: any,
    @Query('days') days?: string,
  ) {
    return this.service.quote(
      employeeId,
      leaveTypeKey,
      Number(year) || new Date().getUTCFullYear(),
      user,
      days === undefined ? undefined : Number(days),
    );
  }

  @Post('requests')
  @Roles('ADMIN', 'HR_MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Request encashment',
    description:
      'ADMIN and HR_MANAGER may set employeeId to file on someone’s behalf — ' +
      'which is what filing for a leaver requires. An EMPLOYEE may only file ' +
      'for themselves.',
  })
  request(@Body() dto: Record<string, unknown>, @CurrentUser() user: any) {
    return this.service.request(dto, user);
  }

  @Post('requests/:id/approve')
  @Roles('ADMIN', 'HR_MANAGER')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.approve(id, user);
  }

  @Post('requests/:id/reject')
  @Roles('ADMIN', 'HR_MANAGER')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { reason: string },
    @CurrentUser() user: any,
  ) {
    return this.service.reject(id, dto?.reason, user);
  }

  @Get('carry-forward/runs')
  @Roles('ADMIN', 'HR_MANAGER')
  listRuns(@Query('branchId') branchId?: string) {
    return this.service.listCarryForwardRuns(branchId);
  }

  @Post('carry-forward')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Move unused balance into the next year',
    description:
      'One branch and one year at a time — deliberately no all-branch sweep. ' +
      'Running it twice for the same years is refused rather than doubling ' +
      'every carried balance.',
  })
  carryForward(
    @Body() dto: { branchId: string; fromYear: number; toYear?: number },
    @CurrentUser() user: any,
  ) {
    return this.service.runCarryForward(dto, user);
  }

  @Post('carry-forward/:runId/reverse')
  @Roles('ADMIN')
  reverseCarryForward(
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.reverseCarryForward(runId, user);
  }
}
