import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BankChangeService } from './bank-change.service';
import {
  CreateBankChangeRequestDto,
  DecideBankChangeDto,
  MigrateBankDetailDto,
} from './dto/bank-change.dto';

@ApiTags('Bank Change Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('bank-change-requests')
export class BankChangeController {
  constructor(private readonly service: BankChangeService) {}

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Submit a bank detail change request' })
  create(@CurrentUser() user: any, @Body() dto: CreateBankChangeRequestDto) {
    return this.service.create(dto, user);
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'List bank change requests (self for non-privileged)' })
  list(@CurrentUser() user: any, @Query('status') status?: string) {
    return this.service.listRequests(status, user);
  }

  @Get('me/current')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: "Caller's current (masked) bank detail + pending flag" })
  current(@CurrentUser() user: any) {
    return this.service.currentForEmployee(user.employeeId);
  }

  @Get('employee/:employeeId/current')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: "An employee's current (masked) bank detail + pending flag" })
  currentFor(@Param('employeeId') employeeId: string) {
    return this.service.adminCurrentForEmployee(employeeId);
  }

  @Get('migration/candidates')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Employees with legacy free-text bank data, unmigrated' })
  migrationCandidates() {
    return this.service.migrationCandidates();
  }

  @Post('migration')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'HR: verify + write a bank detail from a legacy record' })
  migrate(@CurrentUser() user: any, @Body() dto: MigrateBankDetailDto) {
    return this.service.migrate(dto, user);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get a bank change request (masked)' })
  get(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getRequest(id, user);
  }

  @Post(':id/approve')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Approve the active step of a bank change request' })
  approve(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: DecideBankChangeDto,
  ) {
    return this.service.decide(id, user, 'APPROVE', dto.comment);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Reject a bank change request' })
  reject(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: DecideBankChangeDto,
  ) {
    return this.service.decide(id, user, 'REJECT', dto.comment);
  }

  @Post(':id/cancel')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Cancel (withdraw) a pending request' })
  cancel(@CurrentUser() user: any, @Param('id') id: string) {
    return this.service.cancel(id, user);
  }
}
