import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuditResource } from '../audit/audit-resource.decorator';
import { LetterheadService } from './letterhead.service';
// `import type` because emitDecoratorMetadata would otherwise try to emit a
// runtime reference for a shape that only exists at compile time.
import type { UploadedImage } from './letterhead.service';
import { LETTERHEAD_MAX_BYTES } from './constants';

/**
 * Company letterhead and signature artwork.
 *
 * ADMIN only throughout. A letterhead is the artwork that makes a document
 * look authentic to a bank, so who may replace it is the same question as who
 * may publish a template.
 */
@ApiTags('Document templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents/assets')
@AuditResource('DocumentAsset')
export class LetterheadController {
  constructor(private readonly letterheads: LetterheadService) {}

  @Get()
  @Roles('ADMIN', 'HR_MANAGER')
  list(@Query('kind') kind?: string) {
    return this.letterheads.list(kind);
  }

  @Post()
  @Roles('ADMIN')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a letterhead (PNG or JPEG, A4 at 150 DPI or better)' })
  @UseInterceptors(
    FileInterceptor('file', {
      // memoryStorage because StorageService takes a Buffer. The size limit is
      // enforced HERE as well as in the service: without it multer would read
      // an arbitrarily large body into the heap before anything could refuse it.
      storage: memoryStorage(),
      limits: { fileSize: LETTERHEAD_MAX_BYTES },
    }),
  )
  upload(
    @UploadedFile() file: UploadedImage,
    @Body() body: Record<string, string>,
    @CurrentUser() user: any,
  ) {
    const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
    return this.letterheads.upload(
      file,
      {
        name: body.name,
        scope: (body.scope as 'COMPANY' | 'BRANCH') ?? 'COMPANY',
        branchId: body.branchId,
        kind: (body.kind as 'LETTERHEAD' | 'SIGNATURE' | 'SEAL') ?? 'LETTERHEAD',
        safeTopMm: num(body.safeTopMm),
        safeRightMm: num(body.safeRightMm),
        safeBottomMm: num(body.safeBottomMm),
        safeLeftMm: num(body.safeLeftMm),
      },
      user,
    );
  }

  @Put(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Adjust the content-safe area, in millimetres' })
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: any,
  ) {
    return this.letterheads.updateSafeArea(
      id,
      {
        name: body.name as string | undefined,
        safeTopMm: body.safeTopMm as number | undefined,
        safeRightMm: body.safeRightMm as number | undefined,
        safeBottomMm: body.safeBottomMm as number | undefined,
        safeLeftMm: body.safeLeftMm as number | undefined,
      },
      user,
    );
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.letterheads.remove(id, user);
  }
}
