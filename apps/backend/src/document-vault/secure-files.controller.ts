import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { access } from 'fs/promises';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DocumentVaultService } from './document-vault.service';
import { LettersService } from '../letters/letters.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Principal } from '../auth/auth.service';

/** What a resolved private file looks like, whichever kind it came from. */
interface SecureFile {
  absolutePath: string;
  fileName: string;
  mimeType: string;
}

/**
 * The one door to a private file.
 *
 * Files that must not be readable by link live outside the statically served
 * `uploads/` directory, so this route is the only way to reach them and it
 * checks the caller before it streams a byte. Adding a downloadable kind means
 * adding a resolver to the map below — the URL shape stays
 * `/secure-files/{kind}/{id}`.
 */
@ApiTags('Document Vault')
@ApiBearerAuth('JWT-auth')
@Controller('secure-files')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SecureFilesController {
  constructor(
    private readonly vault: DocumentVaultService,
    private readonly letters: LettersService,
  ) {}

  private resolvers(): Record<
    string,
    (id: string, user: Principal) => Promise<SecureFile | null>
  > {
    return {
      'employee-document': (id, user) => this.vault.fileFor(id, user),
      letter: (id, user) => this.letters.fileFor(id, user),
    };
  }

  @Get(':kind/:id')
  @ApiOperation({ summary: 'Download a private file the caller is entitled to' })
  async download(
    @CurrentUser() user: Principal,
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const resolve = this.resolvers()[kind];
    if (!resolve) throw new NotFoundException('Unknown file kind');

    // The resolver throws Forbidden for a caller who may not have it, and
    // returns null when there is no file — which is a 404, not a 403: a
    // reference to nothing discloses nothing.
    const file = await resolve(id, user);
    if (!file) throw new NotFoundException('File not found');

    await access(file.absolutePath).catch(() => {
      throw new NotFoundException('File not found');
    });

    // No-store, because the whole point of this door is that the file does not
    // sit in a shared cache where the next reader can pick it up.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.fileName)}"`,
    );
    createReadStream(file.absolutePath).pipe(res);
  }
}
