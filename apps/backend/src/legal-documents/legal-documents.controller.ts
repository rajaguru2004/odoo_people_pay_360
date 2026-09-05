import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { LegalDocumentsService } from './legal-documents.service';
import { LegalDocumentAttachmentsService } from './legal-document-attachments.service';
import { CreateLegalDocumentDto } from './dto/create-legal-document.dto';
import {
  UpdateLegalDocumentDto,
  RenewLegalDocumentDto,
  CancelLegalDocumentDto,
} from './dto/update-legal-document.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { isDeptInManagerScope } from '../common/services/manager-scope.util';
import { AuditResource } from '../audit/audit-resource.decorator';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Legal Documents')
@ApiBearerAuth('JWT-auth')
@Controller('legal-documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@AuditResource('EmployeeLegalDocument')
export class LegalDocumentsController {
  constructor(
    private readonly service: LegalDocumentsService,
    private readonly attachmentsService: LegalDocumentAttachmentsService,
    private readonly prisma: PrismaService,
  ) {}

  /** EMPLOYEE may only see their own records; MANAGER only their department's. */
  private async assertReadAccess(user: any, employeeId: string) {
    if (user?.role === 'EMPLOYEE') {
      if (user.employeeId !== employeeId) {
        throw new ForbiddenException('You can only view your own documents.');
      }
      return;
    }
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
  }

  @Get()
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER')
  @ApiOperation({ summary: 'List legal documents', description: 'List/filter legal documents (default category VISA)' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'category', required: false, enum: ['VISA'] })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'EXPIRED', 'RENEWED', 'CANCELLED'] })
  @ApiQuery({ name: 'country', required: false })
  @ApiQuery({ name: 'documentType', required: false })
  @ApiQuery({ name: 'expiringInDays', required: false, type: Number })
  @ApiQuery({ name: 'isCurrent', required: false, type: Boolean })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Legal documents retrieved' })
  findAll(
    @Query()
    query: {
      employeeId?: string;
      category?: string;
      status?: string;
      country?: string;
      documentType?: string;
      expiringInDays?: string;
      isCurrent?: string;
      search?: string;
      page?: string;
      limit?: string;
    },
  ) {
    return this.service.findAll(query);
  }

  @Get('expiring')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Get expiring legal documents', description: 'Documents expiring within X days (default 30)' })
  @ApiQuery({ name: 'days', required: false, type: Number, example: 30 })
  @ApiResponse({ status: 200, description: 'Expiring documents retrieved' })
  getExpiring(@Query('days') days?: string) {
    const daysNum = days ? Number(days) : 30;
    return this.service.getExpiring(Number.isFinite(daysNum) ? daysNum : 30);
  }

  @Get('summary')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Get status summary', description: 'Counts by lifecycle status for dashboard cards' })
  @ApiResponse({ status: 200, description: 'Summary retrieved' })
  getSummary() {
    return this.service.getSummary();
  }

  @Get('employee/:employeeId')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get legal documents by employee', description: 'Employees can only view their own' })
  @ApiParam({ name: 'employeeId', description: 'Employee UUID' })
  @ApiResponse({ status: 200, description: 'Documents retrieved' })
  async findByEmployee(
    @CurrentUser() user: any,
    @Param('employeeId') employeeId: string,
  ) {
    await this.assertReadAccess(user, employeeId);
    return this.service.findByEmployee(employeeId);
  }

  @Get(':id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Get legal document by ID', description: 'Includes renewal chain and attachments' })
  @ApiParam({ name: 'id', description: 'Legal document UUID' })
  @ApiResponse({ status: 200, description: 'Document found' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async findOne(@CurrentUser() user: any, @Param('id') id: string) {
    const result = await this.service.findOne(id);
    await this.assertReadAccess(user, (result.data as any).employeeId);
    return result;
  }

  @Post()
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Create legal document (visa)' })
  @ApiResponse({ status: 201, description: 'Document created' })
  create(@CurrentUser() user: any, @Body() dto: CreateLegalDocumentDto) {
    return this.service.create(dto, user?.id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Correct legal document', description: 'Correction edit — use /renew for renewals' })
  @ApiParam({ name: 'id', description: 'Legal document UUID' })
  @ApiResponse({ status: 200, description: 'Document updated' })
  update(@Param('id') id: string, @Body() dto: UpdateLegalDocumentDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/renew')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({
    summary: 'Renew legal document',
    description: 'Creates a new record chained to the old one; old record becomes RENEWED. History preserved.',
  })
  @ApiParam({ name: 'id', description: 'Legal document UUID to renew' })
  @ApiResponse({ status: 201, description: 'Document renewed' })
  renew(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: RenewLegalDocumentDto,
  ) {
    return this.service.renew(id, dto, user?.id);
  }

  @Post(':id/cancel')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Cancel legal document' })
  @ApiParam({ name: 'id', description: 'Legal document UUID' })
  @ApiResponse({ status: 200, description: 'Document cancelled' })
  cancel(@Param('id') id: string, @Body() dto: CancelLegalDocumentDto) {
    return this.service.cancel(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Delete legal document', description: 'Hard delete — audit log captures the removed data' })
  @ApiParam({ name: 'id', description: 'Legal document UUID' })
  @ApiResponse({ status: 200, description: 'Document deleted' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  // ── Attachments ─────────────────────────────────────────────────────────

  @Get(':id/attachments')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'List attachments for a legal document' })
  @ApiParam({ name: 'id', description: 'Legal document UUID' })
  async findAttachments(@CurrentUser() user: any, @Param('id') id: string) {
    const doc = await this.service.findOne(id);
    await this.assertReadAccess(user, (doc.data as any).employeeId);
    return this.attachmentsService.findByDocument(id);
  }

  @Post(':id/attachments')
  @Roles('ADMIN', 'HR_MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload attachment to a legal document' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiParam({ name: 'id', description: 'Legal document UUID' })
  uploadAttachment(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    return this.attachmentsService.uploadAndCreate(id, file, user);
  }

  @Delete(':id/attachments/:attachmentId')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Delete an attachment' })
  @ApiParam({ name: 'id', description: 'Legal document UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  removeAttachment(@Param('attachmentId') attachmentId: string) {
    return this.attachmentsService.remove(attachmentId);
  }
}
