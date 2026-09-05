import {
  Controller,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { getBranchContext } from '../common/branch/branch-context';
import { StorageService } from './storage.service';
import {
  SECURE_DOWNLOAD_RESOLVERS,
  type SecureDownloadResolver,
} from './secure-download.registry';

/**
 * The only way to read a private file.
 *
 * Objects in the public bucket are world-readable by link (an allow-all
 * `s3:GetObject` policy, see StorageService.ensureBucketExists), so anything
 * sensitive is stored privately and reached only through here: authenticate,
 * let the owning domain authorize, audit, then hand over a short-lived
 * presigned URL — or stream the bytes when running on local storage, which has
 * nothing to sign against.
 */
@ApiTags('Secure Files')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('secure-files')
export class SecureDownloadController {
  private readonly logger = new Logger(SecureDownloadController.name);
  private readonly byKind: Map<string, SecureDownloadResolver>;

  constructor(
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @Optional()
    @Inject(SECURE_DOWNLOAD_RESOLVERS)
    resolvers: SecureDownloadResolver[] = [],
  ) {
    this.byKind = new Map((resolvers ?? []).map((r) => [r.kind, r]));
  }

  @Get(':kind/:id')
  @Roles('ADMIN', 'HR_MANAGER', 'MANAGER', 'EMPLOYEE')
  @ApiOperation({ summary: 'Download a private file the caller is entitled to' })
  async download(
    @CurrentUser() user: any,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const resolver = this.byKind.get(kind);
    if (!resolver) throw new NotFoundException(`Unknown file kind "${kind}"`);

    // The resolver throws on a forbidden request; null means genuinely absent.
    const file = await resolver.resolve(id, user);
    if (!file) throw new NotFoundException('File not found');

    await this.audit.log({
      userId: user?.id,
      action: 'SECURE_FILE_DOWNLOADED',
      resourceType: kind,
      resourceId: id,
      newData: { fileName: file.fileName, ownerEmployeeId: file.ownerEmployeeId },
      branchId: getBranchContext()?.effectiveBranchId ?? null,
    });

    // Streamed through the API rather than redirected to a presigned URL.
    //
    // The caller is an XHR carrying a Bearer token (the browser cannot attach
    // one to a plain tab navigation), so a 302 to object storage would need the
    // bucket to allow cross-origin XHR — a CORS failure mode for no benefit at
    // this volume. Streaming also means the audit row above always corresponds
    // to bytes actually served, which a redirect cannot guarantee.
    let buffer: Buffer;
    let mimeType: string;
    try {
      ({ buffer, mimeType } = await this.storage.readPrivateFile(file.ref));
    } catch (err) {
      // Surface the storage cause instead of a bare 500 — a missing object and
      // a misconfigured bucket look identical from the client otherwise.
      this.logger.error(
        `Secure download failed for ${kind}/${id} (${file.ref}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new NotFoundException('File is no longer available in storage');
    }
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', this.contentDisposition(file.fileName));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(buffer);
  }

  /**
   * RFC 6266 / RFC 5987 Content-Disposition.
   *
   * HTTP header values are Latin-1. A generated letter is named from its
   * template — "Salary Certificate — SALARY-2026-00005.pdf" carries an em dash,
   * and the Arabic templates carry Arabic — so passing the raw name to
   * setHeader throws `Invalid character in header content` and the download
   * 500s. Emit an ASCII-safe `filename` for old clients plus a UTF-8
   * `filename*` that every current browser prefers.
   */
  private contentDisposition(fileName: string): string {
    const fallback = fileName
      // eslint-disable-next-line no-control-regex
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '');
    const encoded = encodeURIComponent(fileName);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  }
}
