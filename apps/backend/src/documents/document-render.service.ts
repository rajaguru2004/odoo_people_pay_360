import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PdfRenderOptions, PdfService } from '../pdf/pdf.service';
import { BrandAssetService } from './brand-asset.service';
import { compileDocumentTemplate, renderDocumentTemplate } from './handlebars/env';

/**
 * Bottom band reserved for the repeating footer, in millimetres.
 *
 * This exists because Chromium gives exactly two mechanisms and they are
 * mutually exclusive: a root background bleeds to the paper edge and repeats
 * per page, but only with `margin: 0`; and `displayHeaderFooter` gives you
 * `<span class="pageNumber">`, but only inside a reserved margin band — and
 * Chromium is the only thing that knows the page count, since CSS paged-media
 * margin boxes are unimplemented.
 *
 * So: letterhead artwork goes in the root background with zero top and side
 * margins, and the bottom band is reserved for the footer template. Each
 * mechanism does the thing it is actually good at, and the admin never has to
 * choose between a bleeding letterhead and page numbers.
 */
const FOOTER_BAND_MM = 14;

export interface RenderEnvelope {
  bodyHtml: string;
  styleCss?: string | null;
  footerHtml?: string | null;
  pageFormat?: string | null;
  orientation?: string | null;
  locale?: string | null;
  /** Letterhead artwork, already inlined as data: URIs by the caller. */
  letterhead?: {
    firstPageDataUri?: string | null;
    continuationDataUri?: string | null;
    safeTopMm: number;
    safeRightMm: number;
    safeBottomMm: number;
    safeLeftMm: number;
  } | null;
  /** Burned-in watermark. Used by live preview so a screenshot cannot pass as issued. */
  watermark?: string | null;
}

const PAGE_MM: Record<string, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  Letter: { w: 216, h: 279 },
  Legal: { w: 216, h: 356 },
};

@Injectable()
export class DocumentRenderService {
  private readonly logger = new Logger(DocumentRenderService.name);
  /**
   * Compiled-template cache.
   *
   * Bounded, unlike the unbounded Map this replaces in the letters path: a
   * process that renders a thousand distinct drafts should not hold a thousand
   * compiled templates forever.
   */
  private readonly cache = new Map<string, HandlebarsTemplateDelegate>();
  private static readonly CACHE_MAX = 200;

  constructor(
    private readonly pdf: PdfService,
    private readonly brand: BrandAssetService,
  ) {}

  private compiled(source: string, cacheKey?: string): HandlebarsTemplateDelegate {
    if (!cacheKey) return compileDocumentTemplate(source);
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    const t = compileDocumentTemplate(source);
    if (this.cache.size >= DocumentRenderService.CACHE_MAX) {
      // Oldest-first eviction. Insertion order is Map's iteration order.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, t);
    return t;
  }

  /**
   * Compose the full page around an admin's body.
   *
   * The admin owns `bodyHtml` and `styleCss` and nothing else. The base CSS is
   * prepended and cannot be removed — which is what stops an admin deleting the
   * Arabic font stack and turning every Arabic document into tofu boxes — and
   * the admin's CSS is appended last so it can restyle without being able to
   * take the floor away.
   *
   * Fonts are named by FAMILY, never loaded with @font-face: `page.setContent`
   * gives the document an about:blank origin, from which a `file://`
   * subresource cannot load, so fontconfig in the image is the only route.
   */
  composeHtml(
    env: RenderEnvelope,
    context: Record<string, unknown>,
    cacheKey?: string,
  ): string {
    const rtl = (env.locale ?? 'en').startsWith('ar');
    const format = env.pageFormat && PAGE_MM[env.pageFormat] ? env.pageFormat : 'A4';
    const landscape = (env.orientation ?? 'PORTRAIT') === 'LANDSCAPE';
    const dims = PAGE_MM[format];
    const pageW = landscape ? dims.h : dims.w;
    const pageH = landscape ? dims.w : dims.h;

    const lh = env.letterhead;
    const safe = {
      top: lh?.safeTopMm ?? 20,
      right: lh?.safeRightMm ?? 18,
      bottom: lh?.safeBottomMm ?? 20,
      left: lh?.safeLeftMm ?? 18,
    };

    // Continuation art on the ROOT background, which Chromium paints per page
    // when printBackground is on. First-page art is a positioned layer over it.
    const rootBg = lh?.continuationDataUri
      ? `html{background-image:url("${lh.continuationDataUri}");background-size:${pageW}mm ${pageH}mm;background-repeat:repeat-y;}`
      : '';
    const firstPage = lh?.firstPageDataUri
      ? `<div class="lh-first" style="background-image:url('${lh.firstPageDataUri}')"></div>`
      : '';

    const watermark = env.watermark
      ? `<div class="doc-watermark">${escapeHtml(env.watermark)}</div>`
      : '';

    const bodyTemplate = `<!doctype html>
<html dir="${rtl ? 'rtl' : 'ltr'}" lang="${escapeAttr(env.locale ?? 'en')}">
<head><meta charset="utf-8">
<style>
/* ── BASE. Always first, never removable. ─────────────────────────────── */
@page { size: ${format} ${landscape ? 'landscape' : 'portrait'}; margin: 0; }
:root {
  --brand-primary: #1f3a5f;
  --doc-rule: #d7dce3;
  --doc-muted: #6b7280;
  --doc-zebra: #f6f8fa;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: 'Liberation Sans', 'Helvetica Neue', Arial, sans-serif;
  color: #111827;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
/* The Arabic stack lives in the BASE block on purpose: admin CSS is appended
   after this, so it can restyle but cannot delete the families without which
   Arabic renders as empty boxes. */
html[dir="rtl"] body {
  font-family: 'Noto Sans Arabic', 'Noto Naskh Arabic', 'Amiri', Arial, sans-serif;
}
${rootBg}
.lh-first {
  position: absolute; top: 0; left: 0;
  width: ${pageW}mm; height: ${pageH}mm;
  background-size: ${pageW}mm ${pageH}mm; background-repeat: no-repeat;
  z-index: -1;
}
/* The safe area keeps body text off the letterhead's own logo and footer
   strip. Bottom also clears the band reserved for the page footer. */
.doc-body {
  padding: ${safe.top}mm ${safe.right}mm ${safe.bottom}mm ${safe.left}mm;
}
table { border-collapse: collapse; }
img { max-width: 100%; }
h1, h2, h3 { break-after: avoid; }
tr { break-inside: avoid; }
.doc-watermark {
  position: fixed; top: 45%; left: 0; width: 100%;
  text-align: center; font-size: 64pt; font-weight: 700;
  color: rgba(220, 38, 38, 0.16); transform: rotate(-24deg);
  z-index: 1000; pointer-events: none; letter-spacing: 4pt;
}
/* ── ADMIN CSS, last so it can restyle but not remove the floor. ───────── */
${env.styleCss ?? ''}
</style></head>
<body>
${firstPage}${watermark}
<div class="doc-body">
${env.bodyHtml}
</div>
</body></html>`;

    // Cached by key so a 500-payslip bulk run compiles the envelope ONCE
    // rather than once per employee. Safe because a published version is
    // immutable, so the key can never go stale.
    try {
      return renderDocumentTemplate(this.compiled(bodyTemplate, cacheKey), context);
    } catch (err) {
      // A template that cannot be parsed is the AUTHOR's problem, not a server
      // fault, and it has to say so. This surfaced as a bare 500 "Internal
      // server error" on every preview of a template whose draft held a
      // half-typed field — which told the person looking at it nothing, and
      // left no way to discover which block was at fault.
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      this.logger.warn(`Template failed to compile: ${detail}`);
      throw new BadRequestException(
        `This template cannot be rendered yet: ${detail}. Check any field you were part-way through typing — a field name must be written in full, like {{employeeName}}.`,
      );
    }
  }

  /**
   * Render an envelope to PDF bytes.
   *
   * `cacheKey` should be a PUBLISHED version id, which is safe to cache
   * forever because a published version is immutable — the class of
   * cache-invalidation bug that key-by-updatedAt invites cannot arise. Drafts
   * pass `versionId:updatedAt`.
   */
  async render(
    env: RenderEnvelope,
    context: Record<string, unknown>,
    opts: PdfRenderOptions & { cacheKey?: string } = {},
  ): Promise<Buffer> {
    const html = this.composeHtml(env, context, opts.cacheKey);

    const footer = env.footerHtml
      ? renderDocumentTemplate(this.compiled(env.footerHtml, opts.cacheKey && `${opts.cacheKey}:f`), context)
      : '';
    // Page numbers come from Chromium, because nothing else knows the count.
    const footerTemplate = `<div style="width:100%;font-size:7pt;color:#6b7280;padding:0 18mm;display:flex;justify-content:space-between">
      <span>${footer}</span>
      <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>`;

    return this.pdf.renderHtml(html, {
      format: (env.pageFormat as PdfRenderOptions['format']) ?? 'A4',
      landscape: (env.orientation ?? 'PORTRAIT') === 'LANDSCAPE',
      printBackground: true,
      // Zero top/side margin so letterhead artwork bleeds to the paper edge;
      // the content inset is the safe-area padding instead.
      margin: { top: '0mm', right: '0mm', left: '0mm', bottom: `${FOOTER_BAND_MM}mm` },
      footerHtml: footerTemplate,
      headerHtml: '<span></span>',
      timeoutMs: opts.timeoutMs,
    });
  }

  /** Whether PDF rendering can run at all here. */
  async isAvailable(): Promise<boolean> {
    return this.pdf.isAvailable();
  }

  /** The brand logo, inlined so it can paint on a no-network page. */
  async logoDataUri(): Promise<string> {
    return this.brand.logoDataUri();
  }
}

function escapeHtml(v: string): string {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(v: string): string {
  return escapeHtml(v).replace(/"/g, '&quot;');
}
