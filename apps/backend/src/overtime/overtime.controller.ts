import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
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
import { OvertimeService } from './overtime.service';
import { CreateOvertimeDto } from './dto/create-overtime.dto';
import { ApproveOvertimeDto } from './dto/approve-overtime.dto';
import { RejectOvertimeDto } from './dto/reject-overtime.dto';
import { ListOvertimeDto } from './dto/list-overtime.dto';

@ApiTags('Overtime')
@ApiBearerAuth('JWT-auth')
@Controller('overtime')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OvertimeController {
  constructor(private readonly service: OvertimeService) {}

  @Post()
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'File overtime for yourself' })
  create(@CurrentUser() user: Principal, @Body() dto: CreateOvertimeDto) {
    return this.service.create(user.employeeId, dto, user);
  }

  @Post('employee/:employeeId')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Record overtime on behalf of an employee',
    description:
      'Filing for somebody else is an HR privilege: the hours become their pay.',
  })
  createForEmployee(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: CreateOvertimeDto,
  ) {
    return this.service.create(employeeId, dto, user);
  }

  /**
   * The list answers BY NAME — who worked late, and how much they were paid for
   * it — so it is a management view. An employee reading it would be reading
   * about their colleagues, which is why the self routes below exist instead.
   */
  @Get()
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
  )
  @ApiOperation({ summary: 'List overtime requests' })
  findAll(@CurrentUser() user: Principal, @Query() query: ListOvertimeDto) {
    return this.service.findAll(query, user);
  }

  // Every literal precedes `:id`. `GET /overtime/pending` after `GET
  // /overtime/:id` is parsed as a uuid and answers 400 for the whole queue.
  @Get('pending')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
  )
  @ApiOperation({ summary: 'The approval queue' })
  findPending(@CurrentUser() user: Principal, @Query() query: ListOvertimeDto) {
    return this.service.findAll({ ...query, status: 'PENDING' }, user);
  }

  @Get('stats')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
  )
  @ApiOperation({ summary: 'Queue health and approved hours' })
  stats(@CurrentUser() user: Principal) {
    return this.service.stats(user);
  }

  /**
   * Open to every role. The narrowing is done in the service from the principal
   * rather than by `@Roles`, because whether a row may be read depends on WHOSE
   * it is and a decorator cannot see that.
   */
  @Get('my-requests')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'My own overtime' })
  findMine(@CurrentUser() user: Principal, @Query() query: ListOvertimeDto) {
    if (!user.employeeId) {
      // An ADMIN account need not be linked to an employee record. An empty
      // page is the honest answer; a 500 from `employeeId: undefined` is not.
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

  @Get('report/:year/:month')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
  @ApiOperation({ summary: 'Monthly overtime report' })
  report(
    @CurrentUser() user: Principal,
    @Param('year', ParseIntPipe) year: number,
    @Param('month', ParseIntPipe) month: number,
  ) {
    return this.service.getMonthlyReport(month, year, user);
  }

  @Get('employee/:employeeId/hours/:year/:month')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER, UserRole.PAYROLL_OFFICER)
  @ApiOperation({
    summary: 'Approved overtime hours for one employee in one month',
    description: 'The four payable buckets, which is what a payroll run reads.',
  })
  approvedHours(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('year', ParseIntPipe) year: number,
    @Param('month', ParseIntPipe) month: number,
  ) {
    return this.service.getApprovedOvertimeHours(employeeId, month, year);
  }

  @Get('employee/:employeeId')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.PAYROLL_OFFICER,
    UserRole.MANAGER,
  )
  @ApiOperation({ summary: 'One employee overtime history' })
  findByEmployee(
    @CurrentUser() user: Principal,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: ListOvertimeDto,
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
  @ApiOperation({
    summary: 'One overtime request, with the live payable breakdown',
  })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.findOne(id, user, { withPreview: true });
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
    summary: 'Approve an overtime request, optionally with corrections',
  })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
    @Body() dto?: ApproveOvertimeDto,
  ) {
    return this.service.approve(id, user, dto);
  }

  @Post(':id/edit-preview')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'Dry-run a correction: what it would produce. Writes nothing.',
  })
  editPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
    @Body() dto: ApproveOvertimeDto,
  ) {
    return this.service.previewApproverEdit(id, dto, user);
  }

  @Post(':id/reject')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Reject an overtime request' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
    @Body() dto: RejectOvertimeDto,
  ) {
    return this.service.reject(id, user, dto);
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
