import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';
import { ApprovalEngineService } from './approval-engine.service';
import { ApprovalWorkflowService } from './approval-workflow.service';
import { isApprovalRequestType } from './approval-kind.registry';
import { UpsertWorkflowDto } from './dto/upsert-workflow.dto';
import { SetWorkflowActiveDto } from './dto/set-active.dto';
import { ListApprovalHistoryDto } from './dto/list-history.dto';

/** Every role that can hold a step, plus EMPLOYEE — a supervisor holds no more. */
const CHAIN_PARTICIPANTS = [
  UserRole.ADMIN,
  UserRole.HR_MANAGER,
  UserRole.MANAGER,
  UserRole.EMPLOYEE,
] as const;

@ApiTags('Approval Workflows')
@ApiBearerAuth('JWT-auth')
@Controller('approval-workflows')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApprovalWorkflowController {
  constructor(
    private readonly workflows: ApprovalWorkflowService,
    private readonly engine: ApprovalEngineService,
  ) {}

  // The literal segments are declared before `:id` — Express matches in
  // declaration order, and with a parameterised route first `kinds` would reach
  // ParseUUIDPipe and answer 400.
  @Get('kinds')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Request types a chain can govern' })
  kinds() {
    return this.workflows.listKinds();
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'List every configured approval workflow' })
  list() {
    return this.workflows.list();
  }

  @Put()
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Create or replace the active workflow for a request type',
    description:
      'The previous active workflow is deactivated rather than edited, so a chain that governed an existing request stays readable.',
  })
  upsert(@Body() dto: UpsertWorkflowDto, @CurrentUser() user: Principal) {
    return this.workflows.upsert(dto, user.id);
  }

  @Patch(':id/active')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Enable or disable a workflow' })
  @ApiParam({ name: 'id', description: 'Workflow UUID' })
  setActive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetWorkflowActiveDto,
    @CurrentUser() user: Principal,
  ) {
    return this.workflows.setActive(id, dto.isActive, user.id);
  }

  @Get('pending/me')
  @Roles(...CHAIN_PARTICIPANTS)
  @ApiOperation({ summary: 'Live approval steps awaiting the current user' })
  pendingForMe(@CurrentUser() user: Principal) {
    return this.engine.pendingForUser(user);
  }

  @Get('can-approve')
  @Roles(...CHAIN_PARTICIPANTS)
  @ApiOperation({
    summary: 'Whether the caller is an approver under the active chains',
    description:
      'Drives navigation visibility, so it stays true while the inbox happens to be empty.',
  })
  canApprove(@CurrentUser() user: Principal) {
    return this.engine.canApprove(user);
  }

  @Get('inbox')
  @Roles(...CHAIN_PARTICIPANTS)
  @ApiOperation({ summary: 'Pending requests the caller can act on' })
  inbox(@CurrentUser() user: Principal) {
    return this.engine.inboxForUser(user);
  }

  @Get('history')
  @Roles(...CHAIN_PARTICIPANTS)
  @ApiOperation({
    summary: 'Requests this user has already decided, newest first',
  })
  history(
    @Query() query: ListApprovalHistoryDto,
    @CurrentUser() user: Principal,
  ) {
    return this.engine.historyForUser(user, query.limit ?? 50);
  }

  @Get('trail/:type/:requestId')
  @Roles(...CHAIN_PARTICIPANTS)
  @ApiOperation({
    summary:
      'The approval trail for a request, plus whether the caller may act',
  })
  @ApiParam({ name: 'type', description: 'LEAVE | OVERTIME | TRAINING' })
  @ApiParam({ name: 'requestId', description: 'Domain request UUID' })
  trail(
    @Param('type') type: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @CurrentUser() user: Principal,
  ) {
    if (!isApprovalRequestType(type)) {
      throw new BadRequestException(`Unknown approval request type "${type}"`);
    }
    return this.engine.trailFor(type, requestId, user);
  }
}
