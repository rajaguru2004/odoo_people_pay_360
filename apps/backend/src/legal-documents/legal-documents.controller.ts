import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { LegalDocumentsService } from './legal-documents.service';
import { CreateLegalDocumentDto } from './dto/create-legal-document.dto';
import { UpdateLegalDocumentDto } from './dto/update-legal-document.dto';
import { ListLegalDocumentsDto } from './dto/list-legal-documents.dto';
import { RenewLegalDocumentDto } from './dto/renew-legal-document.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Legal Documents')
@ApiBearerAuth('JWT-auth')
@Controller('legal-documents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LegalDocumentsController {
  constructor(private readonly legalDocuments: LegalDocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'List legal documents' })
  findAll(@Query() query: ListLegalDocumentsDto) {
    return this.legalDocuments.findAll(query);
  }

  // `summary` and `expiring` are declared before `:id`. Express matches in
  // declaration order, so with `:id` first the literal segment would reach
  // ParseUUIDPipe and both endpoints would answer 400.
  @Get('summary')
  @ApiOperation({ summary: 'Counters above the visa report' })
  getSummary() {
    return this.legalDocuments.summary();
  }

  @Get('expiring')
  @ApiOperation({ summary: 'Documents lapsing inside the given window' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  expiring(@Query('days', new ParseIntPipe({ optional: true })) days?: number) {
    return this.legalDocuments.expiring(days);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one document with its renewal chain' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.legalDocuments.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Record a legal document' })
  create(@Body() dto: CreateLegalDocumentDto) {
    return this.legalDocuments.create(dto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Update a legal document' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLegalDocumentDto,
  ) {
    return this.legalDocuments.update(id, dto);
  }

  @Post(':id/renew')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({
    summary: 'Renew a legal document',
    description: 'Supersedes the current row and returns its replacement.',
  })
  renew(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenewLegalDocumentDto,
  ) {
    return this.legalDocuments.renew(id, dto);
  }

  @Patch(':id/cancel')
  @Roles(UserRole.ADMIN, UserRole.HR_MANAGER)
  @ApiOperation({ summary: 'Cancel a legal document' })
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.legalDocuments.cancel(id);
  }
}
