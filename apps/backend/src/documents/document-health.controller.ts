import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PdfDiagnostics, PdfService } from '../pdf/pdf.service';

/** How long a probe result is reused. A probe costs a browser tab. */
const CACHE_TTL_MS = 60_000;

/**
 * Is the document renderer actually working on THIS deployment?
 *
 * This exists because the failure it reports is invisible from everywhere
 * else: a deployment with no Chromium binary, or with the binary but without
 * the Arabic families, serves every other route perfectly and refuses only
 * PDFs — with a message that reads like a policy decision rather than a
 * missing package. An admin had no way to tell those two apart.
 */
@ApiTags('Documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('documents')
export class DocumentHealthController {
  private cached: { at: number; value: PdfDiagnostics } | null = null;

  constructor(private readonly pdf: PdfService) {}

  @Get('health')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Renderer diagnostics: Chromium, fonts and a real probe render',
  })
  async health(): Promise<PdfDiagnostics> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) {
      return this.cached.value;
    }
    const value = await this.pdf.diagnose();
    this.cached = { at: Date.now(), value };
    return value;
  }
}
