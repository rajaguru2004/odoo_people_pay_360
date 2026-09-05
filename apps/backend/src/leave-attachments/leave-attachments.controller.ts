import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { LeaveAttachmentsService } from './leave-attachments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

@ApiTags('Leave Attachments')
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
  @ApiParam({ name: 'leaveRequestId', description: 'Leave request UUID' })
  findByLeaveRequest(
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
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Attach a file to a leave request',
    description: 'PDF or JPG/PNG, up to 10 MB.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiParam({ name: 'leaveRequestId', description: 'Leave request UUID' })
  upload(
    @Param('leaveRequestId', ParseUUIDPipe) leaveRequestId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: Principal,
  ) {
    return this.service.upload(leaveRequestId, file, user);
  }

  @Delete(':id')
  @Roles(
    UserRole.ADMIN,
    UserRole.HR_MANAGER,
    UserRole.MANAGER,
    UserRole.EMPLOYEE,
  )
  @ApiOperation({ summary: 'Remove an attachment' })
  @ApiParam({ name: 'leaveRequestId', description: 'Leave request UUID' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.remove(id, user);
  }
}
