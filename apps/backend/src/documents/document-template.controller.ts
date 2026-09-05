import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { DocumentTemplateService } from './document-template.service';
import { DocumentRenderService } from './document-render.service';
import { CompanyIdentityService } from './company-identity.service';
import { LetterheadService } from './letterhead.service';
import { compileAnyDocument } from './compile-dispatch';
import { compileDocumentForEditor, grapesDocFromSeed } from './grapes-seed';
import { SystemSettingsService } from '../system-settings/system-settings.service';
import { DocumentTemplateDoc } from './document-doc.model';
import {
  DOCUMENT_TYPES,
  documentTypesForRole,
  getDocumentType,
  sampleContext,
} from './document-types';
import { sanitizeTemplateHtml } from './html-sanitizer';
import {
  DuplicateTemplateDto,
  PreviewSampleDto,
  PublishVersionDto,
  SaveDraftDto,
} from './dto/document-template.dto';

/**
 * Managing document templates.
 *
 * Read is ADMIN + HR_MANAGER; every WRITE is ADMIN only. That split is
 * deliberate and matches the existing letter-template gate: publishing changes
 * what goes out to banks and embassies, so HR can look and an administrator
 * ships.
 */
@ApiTags('Document templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents')
@AuditResource('DocumentTemplate')
export class DocumentTemplateController {
  constructor(
    private readonly templates: DocumentTemplateService,
    private readonly render: DocumentRenderService,
    private readonly identity: CompanyIdentityService,
    private readonly letterheads: LetterheadService,
    private readonly settingsReader: SystemSettingsService,
  ) {}

  @Get('types')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'The document catalogue this role may see' })
  types(@CurrentUser() user: any) {
    // Filtered, not disabled: a MANAGER should not learn that a payroll
    // register exists.
    return documentTypesForRole(user.role).map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      category: t.category,
      cardinality: t.cardinality,
      subjectType: t.subjectType,
      selfService: t.selfService,
      sensitivity: t.sensitivity,
      defaultLocales: t.defaultLocales,
    }));
  }

  @Get('types/:key/manifest')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Merge fields available to a document type' })
  manifest(@Param('key') key: string) {
    const type = getDocumentType(key);
    if (!type) throw new NotFoundException(`Unknown document type "${key}"`);

    const groups = new Map<string, typeof type.variables[number][]>();
    for (const v of type.variables) {
      if (!groups.has(v.group)) groups.set(v.group, []);
      groups.get(v.group)!.push(v);
    }

    return {
      documentType: type.key,
      name: type.name,
      groups: [...groups.entries()].map(([group, vars]) => ({
        group,
        tokens: vars.map((v) => ({
          path: v.name,
          label: v.label,
          type: v.type,
          sampleValue: v.sample,
          alwaysPresent: v.alwaysPresent !== false,
          columns: v.columns ?? null,
        })),
      })),
      collections: type.variables
        .filter((v) => v.type === 'table')
        .map((v) => ({
          path: v.name,
          label: v.label,
          fields: v.columns ?? [],
          sampleRows: v.sample,
        })),
      sample: sampleContext(type),
    };
  }

  @Get('templates')
  @Roles('ADMIN', 'HR_MANAGER')
  list(@CurrentUser() user: any, @Query('typeKey') typeKey?: string, @Query('locale') locale?: string) {
    return this.templates.list(user, { typeKey, locale });
  }

  @Get('templates/:id')
  @Roles('ADMIN', 'HR_MANAGER')
  get(@Param('id') id: string, @CurrentUser() user: any) {
    return this.templates.get(id, user);
  }

  @Post('templates/:id/duplicate')
  @Roles('ADMIN')
  duplicate(@Param('id') id: string, @Body() dto: DuplicateTemplateDto, @CurrentUser() user: any) {
    return this.templates.duplicate(id, dto, user);
  }

  @Post('templates/:id/versions')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Open a new draft, optionally cloned from an older version (this is rollback)',
  })
  createDraft(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Query('from') fromVersionId?: string,
  ) {
    return this.templates.createDraft(id, fromVersionId ?? null, user);
  }

  @Put('versions/:id')
  @Roles('ADMIN')
  saveDraft(@Param('id') id: string, @Body() dto: SaveDraftDto, @CurrentUser() user: any) {
    return this.templates.saveDraft(
      id,
      {
        doc: dto.doc as unknown as DocumentTemplateDoc,
        expectedUpdatedAt: dto.expectedUpdatedAt,
        changeNote: dto.changeNote,
        letterheadId: dto.letterheadId,
      },
      user,
    );
  }

  @Post('versions/:id/publish')
  @Roles('ADMIN')
  publish(@Param('id') id: string, @Body() dto: PublishVersionDto, @CurrentUser() user: any) {
    return this.templates.publish(id, dto.expectedContentHash, user);
  }

  @Delete('versions/:id')
  @Roles('ADMIN')
  discard(@Param('id') id: string, @CurrentUser() user: any) {
    return this.templates.discardDraft(id, user);
  }

  /**
   * Preview against SAMPLE data. Never touches a real record.
   *
   * Two output modes on two routes rather than one route with a query flag:
   * HTML comes back as JSON, PDF as bytes, and mixing the two response shapes
   * behind a parameter is how a caller forgets which one it is holding.
   */
  @Post('preview/html')
  @Roles('ADMIN', 'HR_MANAGER')
  @ApiOperation({ summary: 'Exact compiled markup, with sample data. Needs no Chromium.' })
  async previewHtml(@Body() dto: PreviewSampleDto, @CurrentUser() user: any) {
    const { doc, type } = await this.resolvePreviewDoc(dto, user);
    const compiled = compileAnyDocument(doc);
    const sanitized = sanitizeTemplateHtml(compiled.bodyHtml);
    const identity = await this.identity.resolve(null);

    const html = this.render.composeHtml(
      {
        bodyHtml: sanitized.html,
        styleCss: compiled.styleCss,
        footerHtml: compiled.footerHtml,
        pageFormat: doc.page.size,
        orientation: doc.page.orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT',
        locale: doc.locale,
        letterhead: await this.previewLetterhead(doc, dto.letterheadId),
      },
      {
        ...sampleContext(type),
        ...identity,
        companyLogoUrl: await this.render.logoDataUri(),
      },
    );

    return { html, removed: sanitized.removed };
  }

  @Post('preview/pdf')
  @Roles('ADMIN', 'HR_MANAGER')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'A real PDF, with sample data' })
  async previewPdf(@Body() dto: PreviewSampleDto, @CurrentUser() user: any, @Res() res: Response) {
    if (!(await this.render.isAvailable())) {
      // Named remedies, not a bare refusal: this message once reached a user as
      // "the operation could not be completed", which told them nothing.
      throw new ServiceUnavailableException(
        'PDF rendering is unavailable on this deployment. Either the pdf_enabled setting is off, or no Chromium binary is installed in the image. The HTML preview still shows exact content and styling.',
      );
    }
    const { doc, type } = await this.resolvePreviewDoc(dto, user);
    const compiled = compileAnyDocument(doc);
    const sanitized = sanitizeTemplateHtml(compiled.bodyHtml);
    const identity = await this.identity.resolve(null);

    const pdf = await this.render.render(
      {
        bodyHtml: sanitized.html,
        styleCss: compiled.styleCss,
        footerHtml: compiled.footerHtml,
        pageFormat: doc.page.size,
        orientation: doc.page.orientation === 'landscape' ? 'LANDSCAPE' : 'PORTRAIT',
        locale: doc.locale,
        letterhead: await this.previewLetterhead(doc, dto.letterheadId),
        // Burned in so a screenshot of a preview cannot be passed off as an
        // issued document.
        watermark: 'PREVIEW',
      },
      {
        ...sampleContext(type),
        ...identity,
        companyLogoUrl: await this.render.logoDataUri(),
      },
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="preview-${type.key}.pdf"`);
    res.send(pdf);
  }

  /**
   * Seed for converting a v1 draft into the visual editor.
   *
   * Built from docJson, NEVER from the stored compiled bodyHtml — that string
   * carries {{#if}}/{{#each}} helpers interleaved with markup which have no
   * chip representation and would be mangled on the first save. `dropped[]`
   * names what has no visual equivalent, shown BEFORE conversion.
   */
  @Get('versions/:id/visual-seed')
  @Roles('ADMIN')
  async visualSeed(@Param('id') id: string, @CurrentUser() user: any) {
    // The reader for document_visual_editor_enabled (CLAUDE.md §4: a flag with
    // no reader is a defect). Off ⇒ the conversion door does not exist.
    if (
      (await this.settingsReader.getSetting('document_visual_editor_enabled', 'false')) !== 'true'
    ) {
      throw new NotFoundException(
        'The visual editor is turned off on this deployment (document_visual_editor_enabled).',
      );
    }
    const version = await this.templates.getVersionForPreview(id, user);
    const v1 = version.docJson as unknown as DocumentTemplateDoc | null;
    if (!v1 || (v1 as { schemaVersion?: number }).schemaVersion !== 1) {
      throw new BadRequestException(
        'Only a classic block draft can be converted to the visual editor.',
      );
    }
    const seed = compileDocumentForEditor(v1);
    return { doc: grapesDocFromSeed(v1, seed), dropped: seed.dropped };
  }

  /**
   * Letterhead to draw behind a preview.
   *
   * Resolved from the explicit id when the editor sends one, otherwise from
   * the document's own page setup, so what the designer sees is what a real
   * render would put behind the content.
   */
  private async previewLetterhead(doc: DocumentTemplateDoc, letterheadId?: string) {
    if (letterheadId) return this.letterheads.dataUriFor(letterheadId);
    if (doc.page?.letterhead?.source === 'none') return null;
    if (doc.page?.letterhead?.customAssetId) {
      return this.letterheads.dataUriFor(doc.page.letterhead.customAssetId);
    }
    // Fall back to the company letterhead, which is what generation would use.
    const [company] = await this.letterheads.list('LETTERHEAD');
    return company ? this.letterheads.dataUriFor(company.id) : null;
  }

  /** Either the posted unsaved doc, or the stored version's doc. */
  private async resolvePreviewDoc(dto: PreviewSampleDto, user: any) {
    if (dto.doc) {
      const doc = dto.doc as unknown as DocumentTemplateDoc;
      const type = getDocumentType(dto.typeKey ?? doc.documentType);
      if (!type) {
        throw new BadRequestException('Preview needs a known document type.');
      }
      return { doc, type };
    }
    if (!dto.versionId) {
      throw new BadRequestException('Provide either a versionId or a document to preview.');
    }
    const version = await this.templates.getVersionForPreview(dto.versionId, user);
    const doc = version.docJson as unknown as DocumentTemplateDoc;
    if (!doc) {
      throw new BadRequestException(
        'This template was written by hand rather than in the builder, so there is nothing to preview from.',
      );
    }
    const type = getDocumentType(version.typeKey);
    if (!type) throw new NotFoundException(`Unknown document type "${version.typeKey}"`);
    return { doc, type };
  }
}

/** Re-exported so the module file does not need to know the catalogue shape. */
export const DOCUMENT_TYPE_COUNT = DOCUMENT_TYPES.length;
