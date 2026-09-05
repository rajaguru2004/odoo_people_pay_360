/**
 * GrapesJS init options as PLAIN DATA — node-testable without a DOM.
 *
 * Every decision in here is a guardrail, not a preference:
 *
 * - `storageManager: false` — persistence is ours (saveDraft, 2s debounce,
 *   optimistic lock). GrapesJS must never talk to a server on its own.
 * - `avoidInlineStyle: false` — THE load-bearing line. GrapesJS's default
 *   styling writes `#ixxx { … }` rules keyed on generated ids; the sanitizer
 *   strips `id` attributes, so every such rule would orphan and the document
 *   would silently unstyle. Inline `style=""` survives and gets scrubbed.
 * - Asset manager effectively off — the only image path is the brand-logo
 *   block; an admin can never enter an image URL (renderer has no network, so
 *   a remote image is a broken image at best and an exfil channel at worst).
 * - Curated StyleManager — no position/float/transform/z-index, the
 *   properties that break Chromium print pagination silently. The server
 *   scrubs the same list, so this is UX; the server is the security.
 * - `log: []` — GrapesJS is chatty, and the Playwright `problems` fixture
 *   fails a test on ANY console message.
 */

export interface EditorConfigOptions {
  /** DOM element id the editor mounts into. */
  containerId: string;
  /** Page metrics from the doc — drives the canvas sheet size. */
  pageSize: 'A4' | 'A5' | 'Letter' | 'Legal';
  orientation: 'portrait' | 'landscape';
  dir: 'ltr' | 'rtl';
}

const PAGE_MM: Record<string, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  Letter: { w: 216, h: 279 },
  Legal: { w: 216, h: 356 },
};

export function pageDimensionsMm(opts: Pick<EditorConfigOptions, 'pageSize' | 'orientation'>): {
  widthMm: number;
  heightMm: number;
} {
  const dims = PAGE_MM[opts.pageSize] ?? PAGE_MM.A4;
  return opts.orientation === 'landscape'
    ? { widthMm: dims.h, heightMm: dims.w }
    : { widthMm: dims.w, heightMm: dims.h };
}

/** PDF-safe families — the ones the render image installs. Anything else
 *  cannot load on the no-network render page and silently falls back. */
export const PDF_SAFE_FONTS = [
  "'Liberation Sans', Arial, sans-serif",
  "'Liberation Serif', 'Times New Roman', serif",
  "'DejaVu Sans', sans-serif",
  "'Noto Sans Arabic', 'Noto Naskh Arabic', Arial, sans-serif",
];

export function buildEditorConfig(opts: EditorConfigOptions): Record<string, unknown> {
  const { widthMm, heightMm } = pageDimensionsMm(opts);
  return {
    container: `#${opts.containerId}`,
    height: '100%',
    fromElement: false,
    // Persistence is OURS. GrapesJS never talks to a server.
    storageManager: false,
    // Styling as inline style="" — id-keyed CSS dies at the sanitizer.
    avoidInlineStyle: false,
    // Console must stay silent: the Playwright problems fixture fails on any
    // console output, and GrapesJS logs through its own logger by default.
    log: [],
    // No free image path. The brand-logo block is the only image.
    assetManager: { upload: false, assets: [], showUrlInput: false },
    // Blocks come from registerEssBlocks(); nothing built-in.
    blockManager: { blocks: [] },
    // Curated sectors only — the server scrubs the same blocked list.
    styleManager: {
      sectors: [
        {
          name: 'Text',
          open: true,
          properties: [
            { property: 'font-family', type: 'select', options: PDF_SAFE_FONTS.map((f) => ({ id: f, label: f.split(',')[0].replace(/'/g, '') })) },
            { property: 'font-size', units: ['pt'], default: '11pt' },
            { property: 'font-weight' },
            { property: 'color' },
            { property: 'text-align' },
            { property: 'line-height' },
          ],
        },
        {
          name: 'Spacing',
          open: false,
          properties: [
            { property: 'margin', properties: [{ property: 'margin-top' }, { property: 'margin-right' }, { property: 'margin-bottom' }, { property: 'margin-left' }] },
            { property: 'padding', properties: [{ property: 'padding-top' }, { property: 'padding-right' }, { property: 'padding-bottom' }, { property: 'padding-left' }] },
          ],
        },
        {
          name: 'Decoration',
          open: false,
          properties: [{ property: 'background-color' }, { property: 'border' }, { property: 'border-radius' }],
        },
      ],
    },
    // The one "device": a paper sheet, mm-sized.
    deviceManager: {
      devices: [{ id: 'sheet', name: 'Sheet', width: `${widthMm}mm` }],
    },
    canvas: {
      // Nothing external loads in the canvas frame either.
      styles: [],
      scripts: [],
    },
    // Panels are OUR React toolbar; GrapesJS's own chrome stays empty.
    panels: { defaults: [] },
    // mm sheet body styling is injected by the component on canvas:frame:load
    // (canvas CSS is not exported, so the letterhead ghost can never leak).
    protectedCss: '',
  };
}

/** CSS injected into the canvas FRAME (not exported): sheet sizing, page-break
 *  guides, chip styling. */
export function buildCanvasFrameCss(opts: {
  widthMm: number;
  heightMm: number;
  safe: { top: number; right: number; bottom: number; left: number };
  letterheadDataUrl?: string | null;
  dir: 'ltr' | 'rtl';
  chipCss: string;
}): string {
  const bg = opts.letterheadDataUrl
    ? `background-image: url("${opts.letterheadDataUrl}"); background-size: ${opts.widthMm}mm ${opts.heightMm}mm; background-repeat: repeat-y;`
    : '';
  return `
body {
  width: ${opts.widthMm}mm;
  min-height: ${opts.heightMm}mm;
  margin: 0 auto;
  box-sizing: border-box;
  padding: ${opts.safe.top}mm ${opts.safe.right}mm ${opts.safe.bottom}mm ${opts.safe.left}mm;
  background-color: #ffffff;
  ${bg}
  direction: ${opts.dir};
  font-family: 'Liberation Sans', Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.6;
  color: #111827;
}
/* Approximate page boundary — Chromium decides real breaks at print. */
body::after {
  content: '';
  position: absolute;
  left: 0; right: 0; top: ${opts.heightMm}mm;
  border-top: 1px dashed rgba(220, 38, 38, 0.4);
  pointer-events: none;
}
${opts.chipCss}
`;
}
