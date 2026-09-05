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
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';
import { LeaveRequestsService } from './leave-requests.service';
import { LeaveHubService } from './leave-hub.service';
import {
  CreateLeaveRequestDto,
  DecideLeaveRequestDto,
} from './dto/create-leave-request.dto';
import { RejectLeaveRequestDto } from './dto/reject-leave-request.dto';
import { ListLeaveRequestsDto } from './dto/list-leave-requests.dto';
import { LeaveHubSummaryDto } from './dto/hub-summary.dto';

@ApiTags('Leave requests')
@ApiBearerAuth('JWT-auth')
@Controller('leave-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveRequestsController {
  constructor(
    private readonly service: LeaveRequestsService,
    private readonly hub: LeaveHubService,
  ) {}

  /**
   * Every literal route is declared BEFORE `:id`. `GET /leave-requests/pending`
   * after `GET /leave-requests/:id` is parsed as a uuid and answers 400 — for
   * the whole queue, not just one row.
   */
  @Get('hub-summary')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({
    summary:
      'Everything the Leave & Overtime landing page draws, in one request',
    description:
      "The selected period's request counts (all four statuses, CANCELLED " +
      'included), leave days prorated to the part of each request inside the ' +
      'window, the year balance the window ends in, the overtime worked, and ' +
      'the same window one step back for every delta on the page. A rate is ' +
      'null, never 0%, when there was nothing to divide by.',
  })
  hubSummary(
    @CurrentUser() user: Principal,
    @Query() query: LeaveHubSummaryDto,
  ) {
    return this.hub.getHubSummary(query.period ?? 'month', query.anchor, user);
  }

  @Get('team-balances')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({
    summary: 'What the people you are responsible for have left',
  })
  teamBalances(@CurrentUser() user: Principal) {
    return this.service.getTeamBalances(user);
  }

  @Get('pending')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'The approval queue' })
  findPending(
    @CurrentUser() user: Principal,
    @Query() query: ListLeaveRequestsDto,
  ) {
    return this.service.findAll({ ...query, status: 'PENDING' }, user);
  }

  @Get('stats')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'Queue health' })
  stats(@CurrentUser() user: Principal) {
    return this.service.stats(user);
  }

  /**
   * Open to every role. The narrowing happens in the service from the principal,
   * because whether a row may be read depends on WHOSE it is and a decorator
   * cannot see that.
   */
  @Get('my-requests')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'My own leave' })
  findMine(
    @CurrentUser() user: Principal,
    @Query() query: ListLeaveRequestsDto,
  ) {
    if (!user.employeeId) {
      // An ADMIN account need not be linked to an employee record. An empty page
      // is the honest answer; a 500 from `employeeId: undefined` is not.
      return {
        success: true,
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 1 },
      };
    }
    return this.service.findAll(
      { ...query, employeeId: user.employeeId },
      user,
    );
  }

  /**
   * The list answers BY NAME — who is off, and why. That is a management view,
   * which is why an employee is refused it while still being entitled to their
   * own history above.
   */
  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'List leave requests' })
  findAll(
    @CurrentUser() user: Principal,
    @Query() query: ListLeaveRequestsDto,
  ) {
    return this.service.findAll(query, user);
  }

  @Get('employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.MANAGER)
  @ApiOperation({ summary: 'One employee leave history' })
  findByEmployee(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: ListLeaveRequestsDto,
  ) {
    return this.service.findAll({ ...query, employeeId }, user);
  }

  @Get(':id')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'One leave request' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.findOne(id, user);
  }

  @Post()
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'File a leave request' })
  create(@Body() dto: CreateLeaveRequestDto, @CurrentUser() user: Principal) {
    return this.service.create(dto, user);
  }

  /**
   * EMPLOYEE is admitted so a SUPERVISOR — who usually holds no elevated role —
   * can decide the requests they are named on. Eligibility is enforced in the
   * service against `Employee.supervisorId`, not by the route guard.
   */
  @Post(':id/approve')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'Approve a leave request',
    description:
      'Deducts the balance, marks it approved and writes an ON_LEAVE ' +
      'attendance row for every working day — in one transaction. The response ' +
      'reports any day that already had attendance and was left alone.',
  })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideLeaveRequestDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.approve(id, user, dto?.comment);
  }

  @Post(':id/reject')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Reject a leave request' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLeaveRequestDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.reject(id, user, dto.comment);
  }

  @Delete(':id')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Withdraw your own pending request' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.cancel(id, user);
  }
}
