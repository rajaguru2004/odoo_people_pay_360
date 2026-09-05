import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { DocumentGenerationService } from './document-generation.service';
import { GenerateDocumentDto } from './dto/generate-document.dto';

/**
 * Generating documents.
 *
 * The response carries a DOWNLOAD PATH, never the bytes. Two reasons: the
 * bytes then travel through the one authenticated door that already audits
 * every download and encodes non-ASCII filenames correctly; and a generated
 * document is a durable record with an id, not a transient response body, so
 * the same document can be fetched again later without regenerating it.
 */
@ApiTags('Documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents')
@AuditResource('GeneratedDocument')
export class DocumentGenerationController {
  constructor(private readonly generation: DocumentGenerationService) {}

  @Post('generate')
  // Deliberately wide at the decorator and narrowed per TYPE inside: which
  // roles may generate depends on the document, and encoding twenty-two
  // different role sets in a decorator is not possible. The service refuses
  // before touching any data.
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Generate one document and file it' })
  generate(@Body() dto: GenerateDocumentDto, @CurrentUser() user: any) {
    return this.generation.generateOne(
      {
        typeKey: dto.typeKey,
        locale: dto.locale,
        employeeId: dto.employeeId ?? null,
        subjectId: dto.subjectId ?? null,
        params: dto.params ?? {},
      },
      user,
    );
  }

  @Get('mine')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Documents generated about the caller' })
  mine(@CurrentUser() user: any, @Query('typeKey') typeKey?: string) {
    // Derived from the token, never from a path or query parameter — the one
    // shape of this route that cannot be turned into someone else's documents.
    return this.generation.listForEmployee(user.employeeId ?? null, typeKey);
  }
}
