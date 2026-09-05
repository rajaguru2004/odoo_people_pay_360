import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';
import { LeaveAttachmentsService } from './leave-attachments.service';
import { CreateLeaveAttachmentDto } from './dto/create-leave-attachment.dto';

/**
 * Registered under the leave request that owns the files.
 *
 * This controller is listed BEFORE `LeaveRequestsController` in the module's
 * `controllers` array so `/leave-requests/:id/attachments` is matched before
 * `/leave-requests/:id` can claim the prefix.
 */
@ApiTags('Leave attachments')
@ApiBearerAuth('JWT-auth')
@Controller('leave-requests/:leaveRequestId/attachments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveAttachmentsController {
  constructor(private readonly service: LeaveAttachmentsService) {}

  @Get()
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Files attached to a leave request' })
  findAll(
    @Param('leaveRequestId', ParseUUIDPipe) leaveRequestId: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.findByLeaveRequest(leaveRequestId, user);
  }

  @Post()
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({
    summary: 'Register a file against a leave request',
    description:
      'Metadata only. The binary upload is deferred until the platform has a ' +
      'storage module — see docs/interconnections-leave-overtime.md.',
  })
  create(
    @Param('leaveRequestId', ParseUUIDPipe) leaveRequestId: string,
    @Body() dto: CreateLeaveAttachmentDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.create(leaveRequestId, dto, user);
  }

  @Delete(':id')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Remove an attachment (soft)' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.remove(id, user);
  }
}
