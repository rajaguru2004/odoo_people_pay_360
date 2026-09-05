import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseUUIDPipe,
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
import { AdvanceLoanAttachmentsService } from './advance-loan-attachments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { LoanReadOnlyGuard } from './loan-readonly.guard';

/**
 * Documents attached to one advance/loan request.
 *
 * The loan id is bound as `:id` rather than `:requestId`, and the attachment as
 * `:attachmentId`, ON PURPOSE: AuditInterceptor takes its `resourceId` from
 * `request.params.id`, so this naming is what makes the row it writes name the
 * LOAN. Bound the other way round, an upload was filed against the attachment's
 * own id and a delete against nothing a reader could resolve — which is half of
 * why §10 (attachment writes are not audited at all) mattered. The URL shape is
 * unchanged; only the placeholder names are.
 *
 * @AuditResource gives the interceptor its who/when/where envelope for both
 * writes; the service additionally writes a row naming WHICH file moved, which
 * the interceptor cannot know (multipart bodies are consumed by Multer, and a
 * DELETE has no body at all).
 *
 * LoanReadOnlyGuard: adding or removing the evidence behind a loan is a write,
 * so a caller the auditor settings declare read-only is refused (§8). The GET
 * is untouched.
 */
@ApiTags('Advance & Loan Attachments')
@ApiBearerAuth('JWT-auth')
@Controller('advance-loans/:id/attachments')
@UseGuards(JwtAuthGuard, RolesGuard, LoanReadOnlyGuard)
@AuditResource('AdvanceLoan')
export class AdvanceLoanAttachmentsController {
  constructor(private readonly service: AdvanceLoanAttachmentsService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get all attachments for an advance/loan request' })
  @ApiParam({ name: 'id', description: 'Advance/Loan request UUID' })
  findByRequest(
    @Param('id', ParseUUIDPipe) requestId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.findByRequest(requestId, user);
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload a file attachment to an advance/loan request' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiParam({ name: 'id', description: 'Advance/Loan request UUID' })
  upload(
    @Param('id', ParseUUIDPipe) requestId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    return this.service.uploadAndCreate(requestId, file, user);
  }

  @Delete(':attachmentId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Delete an advance/loan attachment' })
  @ApiParam({ name: 'id', description: 'Advance/Loan request UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  remove(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.remove(attachmentId, user);
  }
}
