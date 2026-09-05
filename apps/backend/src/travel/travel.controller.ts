import {
  Body,
  Controller,
  Delete,
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
import { TravelService } from './travel.service';
import { CreateTravelRequestDto } from './dto/create-travel-request.dto';
import { QueryTravelDto } from './dto/query-travel.dto';
import { DecideTravelDto } from './dto/decide-travel.dto';

@ApiTags('Travel')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('travel-requests')
@AuditResource('TravelRequest')
export class TravelController {
  constructor(private readonly travel: TravelService) {}

  // Literal segments before `:id`, or they are swallowed as ids.

  @Get('stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Travel summary: pending, on trip today, upcoming' })
  stats() {
    return this.travel.stats();
  }

  @Get('my-requests')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: "The current user's own travel requests" })
  myRequests(@CurrentUser() user: any) {
    if (!user?.employeeId) return { success: true, data: [] };
    return this.travel.findByEmployee(user.employeeId);
  }

  @Get('on-trip')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({
    summary: 'Approved trips overlapping a window — who is away (team calendar)',
  })
  onTrip(
    @CurrentUser() user: any,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const departmentIds =
      user?.role === 'MANAGER' ? (user.managedDepartmentIds ?? []) : undefined;
    return this.travel.findOnTrip(
      from ? new Date(from) : new Date(),
      to ? new Date(to) : new Date(Date.now() + 30 * 86_400_000),
      departmentIds,
    );
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'List travel requests' })
  findAll(@CurrentUser() user: any, @Query() query: QueryTravelDto) {
    return this.travel.findAll(query, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Raise a trip request. On final approval this spawns a per-diem reimbursement, an advance in the loans ledger, and a visa alert for uncovered international travel.',
  })
  create(
    @CurrentUser() user: any,
    @Body() dto: CreateTravelRequestDto,
    @Query('employeeId') employeeIdOverride?: string,
  ) {
    // HR may raise a trip on someone's behalf; everyone else raises their own.
    const employeeId =
      employeeIdOverride && ['ADMIN', 'HR_MANAGER'].includes(user?.role)
        ? employeeIdOverride
        : user.employeeId;
    return this.travel.create(employeeId, dto, user);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Trip detail, including the claims it spawned' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.travel.findOne(id, user);
  }

  @Post(':id/approve')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Approve. EMPLOYEE is allowed because a configured chain can route a step to a supervisor, who carries no approver role.',
  })
  approve(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideTravelDto,
  ) {
    return this.travel.decide(id, user, 'APPROVE', dto);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Reject a travel request' })
  reject(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideTravelDto,
  ) {
    return this.travel.decide(id, user, 'REJECT', dto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Cancel a trip and withdraw the claims it spawned (never anything already in payroll)',
  })
  cancel(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.travel.cancel(id, user);
  }
}
