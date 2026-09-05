import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Delete,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ReimbursementsService } from './reimbursements.service';
import { CreateReimbursementDto } from './dto/create-reimbursement.dto';
import { ApproveReimbursementDto } from './dto/approve-reimbursement.dto';
import { RejectReimbursementDto } from './dto/reject-reimbursement.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Reimbursements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reimbursements')
@AuditResource('Reimbursement')
export class ReimbursementsController {
  constructor(private readonly reimbursementsService: ReimbursementsService) {}

  @Post()
  @Roles('HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Create reimbursement request (admins administer, they do not submit)' })
  create(@CurrentUser() user: any, @Body() createDto: CreateReimbursementDto) {
    return this.reimbursementsService.create(user.employeeId, createDto);
  }

  @Get('stats')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Claim queue summary',
    description:
      'Counts and amounts for the module hub. Branch-scoped through the same ' +
      'Prisma extension as the list endpoints.',
  })
  stats() {
    return this.reimbursementsService.stats();
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List reimbursement requests' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED'],
  })
  @ApiQuery({ name: 'employeeId', required: false })
  findAll(
    @Query('status') status?: string,
    @Query('employeeId') employeeId?: string,
  ) {
    return this.reimbursementsService.findAll(status, employeeId);
  }

  @Get('pending')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Pending reimbursements for the current approver' })
  findPending(@CurrentUser() user: any) {
    return this.reimbursementsService.findPending(user);
  }

  @Get('my-requests')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'My reimbursement requests' })
  findMyRequests(@CurrentUser() user: any) {
    return this.reimbursementsService.findByEmployee(user.employeeId);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Reimbursement request details' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    return this.reimbursementsService.findOne(id, user);
  }

  @Post(':id/approve')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Approve reimbursement request' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Body() approveDto?: ApproveReimbursementDto,
  ) {
    return this.reimbursementsService.approve(id, user, approveDto);
  }

  @Post(':id/reject')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Reject reimbursement request' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
    @Body() rejectDto: RejectReimbursementDto,
  ) {
    return this.reimbursementsService.reject(id, user, rejectDto);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Cancel reimbursement request' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    return this.reimbursementsService.cancel(id, user.employeeId);
  }
}
