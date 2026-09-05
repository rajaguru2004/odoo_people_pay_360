import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../decorators/public.decorator';
import { renderVerifyPage } from './verify-page.html';

/**
 * Serves the verification page from the API's own origin.
 *
 * The page used to live in the Next portal and call the API cross-origin, which
 * meant the browser had to know the API address before its first request. There
 * is nowhere safe to keep that: a build-time variable is wrong as soon as the
 * portal moves, and putting the address in the link would let a crafted url aim
 * the page — and the verification token with it — at any host.
 *
 * Serving it here removes the question entirely. The page's calls are
 * same-origin, so the link is correct wherever the API is deployed, driven only
 * by the API address configured in WhatsApp settings.
 *
 * Kept at `/verify/:token` rather than under the JSON controller's prefix so
 * the link stays short enough to read in a chat.
 */
@ApiExcludeController()
@Controller('verify')
export class VerifyPageController {
  @Public()
  @Get(':token')
  @Header('Content-Type', 'text/html; charset=utf-8')
  // The document carries a single-use capability: no cache may keep it, and no
  // crawler should index it.
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  page(@Param('token') token: string, @Res() res: Response): void {
    // Deliberately NOT validated here. Rendering is not consuming, and a page
    // that only appeared for a live token would confirm which tokens exist.
    // The script asks, and an invalid one is answered the same way as a typo.
    res.send(renderVerifyPage(token));
  }
}
