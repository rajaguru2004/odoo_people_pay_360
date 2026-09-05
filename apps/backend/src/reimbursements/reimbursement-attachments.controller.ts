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
import { ReimbursementAttachmentsService } from './reimbursement-attachments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Reimbursement Attachments')
@ApiBearerAuth('JWT-auth')
@Controller('reimbursements/:reimbursementId/attachments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReimbursementAttachmentsController {
  constructor(private readonly service: ReimbursementAttachmentsService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get all attachments for a reimbursement request' })
  @ApiParam({ name: 'reimbursementId', description: 'Reimbursement UUID' })
  findByReimbursement(
    @Param('reimbursementId') reimbursementId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.findByReimbursement(reimbursementId, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload a file attachment to a reimbursement request' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiParam({ name: 'reimbursementId', description: 'Reimbursement UUID' })
  upload(
    @Param('reimbursementId') reimbursementId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    return this.service.uploadAndCreate(reimbursementId, file, user);
  }

  @Delete(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Delete a reimbursement attachment' })
  @ApiParam({ name: 'reimbursementId', description: 'Reimbursement UUID' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user);
  }
}
