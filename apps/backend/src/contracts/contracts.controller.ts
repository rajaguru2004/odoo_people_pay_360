import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ContractsService } from './contracts.service';
import { TerminationRequestService } from './termination-request.service';
import { CreateContractDto } from './dto/create-contract.dto';
import {
  UpdateContractDto,
  RenewContractDto,
  TerminateContractDto,
} from './dto/update-contract.dto';
import { CreateTerminationRequestDto } from './dto/create-termination-request.dto';
import { ApproveTerminationDto } from './dto/approve-termination.dto';
import { RejectTerminationDto } from './dto/reject-termination.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { PrismaService } from '../prisma/prisma.service';
import { AuditResource } from '../audit/audit-resource.decorator';

@ApiTags('Contracts')
@ApiBearerAuth('JWT-auth')
@Controller('contracts')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('Contract')
export class ContractsController {
  constructor(
    private readonly contractsService: ContractsService,
    private readonly terminationService: TerminationRequestService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get all contracts',
    description: 'List contracts with filters',
  })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'EXPIRED', 'TERMINATED'],
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Contracts retrieved successfully' })
  findAll(
    @Query()
    query: {
      employeeId?: string;
      status?: string;
      search?: string;
      page?: string;
      limit?: string;
    },
  ) {
    return this.contractsService.findAll(query);
  }

  @Get('expiring')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get expiring contracts',
    description: 'Get contracts expiring within X days',
  })
  @ApiQuery({ name: 'days', required: false, type: Number, example: 30 })
  @ApiResponse({ status: 200, description: 'Expiring contracts retrieved' })
  getExpiringContracts(@Query('days') days?: string) {
    const daysNum = days ? Number(days) : 30;
    return this.contractsService.getExpiringContracts(daysNum);
  }

  @Get('statistics')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get contract statistics',
    description: 'Get counts of total/active/expired/expiring contracts',
  })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  getStatistics() {
    return this.contractsService.getStatistics();
  }

  @Get('employee/:employeeId')
  // EMPLOYEE for their OWN contracts only, enforced below. A contract is the
  // document that defines someone's pay; being unable to read your own was the
  // same shape of omission as GET /employees/:id.
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Get contracts by employee',
    description: 'Get all contracts for an employee',
  })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Contracts retrieved' })
  async findByEmployee(
    @CurrentUser() user: any,
    @Param('employeeId') employeeId: string,
  ) {
    if (user?.role === 'EMPLOYEE' && user?.employeeId !== employeeId) {
      throw new ForbiddenException('You can only view your own contracts.');
    }
    // MANAGER: can only view contracts for own dept employees
    if (user?.role === 'MANAGER') {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { departmentId: true },
      });
      if (!emp || !isDeptInManagerScope(user, emp.departmentId)) {
        throw new ForbiddenException(
          'You do not have permission to view employees outside your department.',
        );
      }
    }
    return this.contractsService.findByEmployee(employeeId);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'Get contract by ID' })
  @ApiParam({ name: 'id', description: 'Contract UUID' })
  @ApiResponse({ status: 200, description: 'Contract found' })
  @ApiResponse({ status: 404, description: 'Contract not found' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string) {
    // MANAGER: verify contract belongs to employee in their dept
    if (user?.role === 'MANAGER') {
      const contract = await this.prisma.contract.findUnique({
        where: { id },
        select: { employee: { select: { departmentId: true } } },
      });
      if (
        !contract ||
        !isDeptInManagerScope(user, contract.employee.departmentId)
      ) {
        throw new ForbiddenException(
          'You do not have permission to view contracts outside your department.',
        );
      }
    }
    return this.contractsService.findOne(id);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Create contract',
    description: 'Create a new contract for employee',
  })
  @ApiResponse({ status: 201, description: 'Contract created successfully' })
  @ApiResponse({
    status: 409,
    description: 'Employee already has active contract',
  })
  create(@Body() createContractDto: CreateContractDto) {
    return this.contractsService.create(createContractDto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Update contract' })
  @ApiParam({ name: 'id', description: 'Contract UUID' })
  @ApiResponse({ status: 200, description: 'Contract updated successfully' })
  update(
    @Param('id') id: string,
    @Body() updateContractDto: UpdateContractDto,
  ) {
    return this.contractsService.update(id, updateContractDto);
  }

  @Post(':id/renew')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Renew contract',
    description: 'Create new contract from existing one',
  })
  @ApiParam({ name: 'id', description: 'Contract UUID' })
  @ApiResponse({ status: 201, description: 'Contract renewed successfully' })
  renew(@Param('id') id: string, @Body() renewDto: RenewContractDto) {
    return this.contractsService.renew(id, renewDto);
  }

  @Post(':id/terminate')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Terminate contract',
    description: 'End contract with reason',
  })
  @ApiParam({ name: 'id', description: 'Contract UUID' })
  @ApiResponse({ status: 200, description: 'Contract terminated successfully' })
  terminate(
    @Param('id') id: string,
    @Body() terminateDto: TerminateContractDto,
    @CurrentUser() user: any,
  ) {
    return this.contractsService.terminate(id, terminateDto, {
      id: user.id,
      role: user.role,
    });
  }

  // Termination Request Endpoints

  @Post('termination-requests')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Create termination request',
    description: 'Create a new termination request with approval workflow',
  })
  @ApiResponse({ status: 201, description: 'Termination request created' })
  @ApiResponse({
    status: 400,
    description: 'Invalid request or insufficient notice period',
  })
  createTerminationRequest(
    @Body() dto: CreateTerminationRequestDto,
    @CurrentUser() user: any,
  ) {
    return this.terminationService.createTerminationRequest({
      ...dto,
      requestedBy: user.id,
      noticeDate: new Date(dto.noticeDate),
      terminationDate: new Date(dto.terminationDate),
    });
  }

  @Get('termination-requests/pending')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get pending termination requests',
    description: 'Get all pending termination requests for approval',
  })
  @ApiResponse({ status: 200, description: 'Pending requests retrieved' })
  getPendingTerminations(@CurrentUser() user: any) {
    return this.terminationService.getPendingTerminations(user.id);
  }

  @Get('termination-requests/history')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get termination request history',
    description: 'Get all approved/rejected termination requests',
  })
  @ApiResponse({ status: 200, description: 'Termination history retrieved' })
  getTerminationHistory() {
    return this.terminationService.getTerminationHistory();
  }

  @Get('termination-requests/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get termination request by ID',
    description: 'Get details of a specific termination request',
  })
  @ApiParam({ name: 'id', description: 'Termination request UUID' })
  @ApiResponse({ status: 200, description: 'Termination request found' })
  @ApiResponse({ status: 404, description: 'Termination request not found' })
  getTerminationRequest(@Param('id') id: string) {
    return this.terminationService.getTerminationRequest(id);
  }

  @Get(':id/termination-requests')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Get termination requests by contract',
    description: 'Get all termination requests for a specific contract',
  })
  @ApiParam({ name: 'id', description: 'Contract UUID' })
  @ApiResponse({ status: 200, description: 'Termination requests retrieved' })
  getTerminationRequestsByContract(@Param('id') contractId: string) {
    return this.terminationService.getTerminationRequestsByContract(contractId);
  }

  @Post('termination-requests/:id/approve')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Approve termination request',
    description:
      'Approve a pending termination request and terminate the contract',
  })
  @ApiParam({ name: 'id', description: 'Termination request UUID' })
  @ApiResponse({ status: 200, description: 'Termination request approved' })
  @ApiResponse({ status: 400, description: 'Request not pending or invalid' })
  approveTermination(
    @Param('id') id: string,
    @Body() dto: ApproveTerminationDto,
    @CurrentUser() user: any,
  ) {
    return this.terminationService.approveTermination(
      id,
      { ...dto, approverId: user.id },
      { id: user.id, role: user.role },
    );
  }

  @Post('termination-requests/:id/reject')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Reject termination request',
    description:
      'Reject a pending termination request and keep contract active',
  })
  @ApiParam({ name: 'id', description: 'Termination request UUID' })
  @ApiResponse({ status: 200, description: 'Termination request rejected' })
  @ApiResponse({ status: 400, description: 'Request not pending or invalid' })
  rejectTermination(
    @Param('id') id: string,
    @Body() dto: RejectTerminationDto,
    @CurrentUser() user: any,
  ) {
    return this.terminationService.rejectTermination(id, {
      ...dto,
      approverId: user.id,
    });
  }
}
