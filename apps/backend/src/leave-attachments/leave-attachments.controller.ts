import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { LeaveAttachmentsService } from './leave-attachments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Leave Attachments')
@ApiBearerAuth('JWT-auth')
@Controller('leave-requests/:leaveRequestId/attachments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveAttachmentsController {
  constructor(private readonly service: LeaveAttachmentsService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get all attachments for a leave request' })
  @ApiParam({ name: 'leaveRequestId', description: 'Leave Request UUID' })
  findByLeaveRequest(
    @Param('leaveRequestId') leaveRequestId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.findByLeaveRequest(leaveRequestId, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload a file attachment to a leave request' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiParam({ name: 'leaveRequestId', description: 'Leave Request UUID' })
  upload(
    @Param('leaveRequestId') leaveRequestId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    return this.service.uploadAndCreate(leaveRequestId, file, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Delete a leave request attachment' })
  @ApiParam({ name: 'leaveRequestId', description: 'Leave Request UUID' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user);
  }
}
