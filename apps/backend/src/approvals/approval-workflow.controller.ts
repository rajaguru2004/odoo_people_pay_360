import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApprovalWorkflowService } from './approval-workflow.service';
import { ApprovalEngineService } from './approval-engine.service';
import { UpsertWorkflowDto } from './dto/upsert-workflow.dto';
import { SetWorkflowActiveDto } from './dto/set-active.dto';
import { isApprovalRequestType } from './approval-kind.registry';

@ApiTags('Approval Workflows')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('approval-workflows')
export class ApprovalWorkflowController {
  constructor(
    private readonly workflows: ApprovalWorkflowService,
    private readonly engine: ApprovalEngineService,
  ) {}

  @Get('kinds')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Request types that can be governed by an approval chain',
  })
  kinds() {
    return this.workflows.listKinds();
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'List all configured approval workflows' })
  list() {
    return this.workflows.list();
  }

  @Put()
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Create/replace the active workflow for a request type' })
  upsert(@CurrentUser() user: any, @Body() dto: UpsertWorkflowDto) {
    return this.workflows.upsert(dto, user.id);
  }

  @Patch(':id/active')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Enable/disable a workflow' })
  setActive(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetWorkflowActiveDto,
  ) {
    return this.workflows.setActive(id, dto.isActive, user.id);
  }

  @Get('pending/me')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Active approval steps awaiting the current user' })
  async pendingForMe(@CurrentUser() user: any) {
    return { success: true, data: await this.engine.pendingForUser(user) };
  }

  @Get('can-approve')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Whether the current user is an approver under the active chains',
  })
  async canApprove(@CurrentUser() user: any) {
    return { success: true, data: await this.engine.canApprove(user) };
  }

  @Get('inbox')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Approval inbox: pending requests the user can act on' })
  inbox(@CurrentUser() user: any) {
    return this.engine.inboxForUser(user);
  }

  @Get('history')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary: 'Requests this user has already decided, newest first',
  })
  history(@CurrentUser() user: any, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    return this.engine.historyForUser(
      user,
      Number.isFinite(parsed) && parsed > 0 ? parsed : 50,
    );
  }

  @Get('trail/:type/:requestId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({
    summary:
      'Approval trail for a given request, plus whether the caller may act on the live step',
  })
  async trail(
    @CurrentUser() user: any,
    @Param('type') type: string,
    @Param('requestId') requestId: string,
  ) {
    if (!isApprovalRequestType(type)) {
      throw new BadRequestException(`Unknown approval request type "${type}"`);
    }
    return {
      success: true,
      data: await this.engine.trailFor(type, requestId, user),
    };
  }
}
