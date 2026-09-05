/**
 * The block document the visual builder reads and writes.
 *
 * This is the SOURCE OF TRUTH for an admin-authored template. The Handlebars
 * HTML stored alongside it is derived — compiled from this, then sanitized, on
 * every draft save.
 *
 * The frontend never emits Handlebars. It emits this, and the server compiles
 * it, which keeps the sanitization boundary on the server and means the
 * client-side canvas is explicitly an approximation rather than a second
 * implementation of the output format.
 *
 * Shared verbatim with apps/frontend/types/document-template.ts. Changing a
 * shape here without changing it there produces a template that saves and then
 * renders as something else.
 */

export type Align = 'start' | 'center' | 'end' | 'justify';
export type Mm = number;

/** A brand reference resolves at render time, so a rebrand updates every template. */
export type BrandRef =
  | '@brand.primary'
  | '@brand.primaryDark'
  | '@brand.primaryLight'
  | '@brand.accent'
  | '@brand.accentDark'
  | '@brand.font'
  | '@brand.logo'
  | '@brand.name';

export type ColorValue = BrandRef | string;

export interface PageSetup {
  size: 'A4' | 'A5' | 'Letter' | 'Legal';
  orientation: 'portrait' | 'landscape';
  margin: { top: Mm; right: Mm; bottom: Mm; left: Mm };
  letterhead?: {
    source: 'company' | 'branch' | 'none' | 'custom';
    customAssetId?: string;
    /** Continuation pages use the asset's continuation artwork when false. */
    firstPageOnly: boolean;
  };
}

export interface ThemeBinding {
  /** Default true: styling resolves through references, so a rebrand propagates. */
  followBrand: boolean;
  primary?: ColorValue;
  accent?: ColorValue;
  /**
   * PDF-safe families only. A Google font cannot load on a no-network render
   * page, so the builder offers only what the image installs.
   */
  fontFamily?: string;
  baseFontSizePt?: number;
  lineHeight?: number;
}

export type Condition =
  | { op: 'always' }
  | {
      op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty' | 'truthy';
      path: string;
      value?: string | number | boolean;
    }
  | { op: 'and' | 'or'; all: Condition[] };

export interface BlockCommon {
  id: string;
  visibleWhen?: Condition;
  spacingAfterMm?: Mm;
  /** Catalogue-critical blocks an admin may restyle but not delete. */
  locked?: boolean;
}

export interface TableColumn {
  key: string;
  header: string;
  align?: Align;
  /** Applied by the compiler as a helper call: money | num | date | none. */
  format?: 'money' | 'num' | 'date' | 'none';
  widthPct?: number;
}

export type Block = BlockCommon &
  (
    | { type: 'text'; props: { html: string; align?: Align; sizePt?: number } }
    | { type: 'heading'; props: { html: string; level: 1 | 2 | 3; align?: Align; underline?: boolean } }
    | { type: 'logo'; props: { source: 'brand' | 'custom'; assetId?: string; maxHeightMm: Mm; align: Align } }
    | { type: 'spacer'; props: { heightMm: Mm } }
    | { type: 'divider'; props: { thicknessPt?: number; color?: ColorValue } }
    | {
        type: 'keyValue';
        props: {
          rows: { label: string; value: string }[];
          labelWidthPct?: number;
          hideEmptyRows?: boolean;
        };
      }
    | {
        type: 'dataTable';
        props: {
          bind: string;
          columns: TableColumn[];
          showHeader?: boolean;
          zebra?: boolean;
          totalsRow?: { label: string; column: string };
          emptyText?: string;
        };
      }
    | {
        type: 'signature';
        props: {
          slotKey?: string;
          name?: string;
          designation?: string;
          showImage?: boolean;
          showStamp?: boolean;
          align?: Align;
        };
      }
    | { type: 'pageBreak'; props: Record<string, never> }
    | { type: 'rawHtml'; props: { html: string } }
  );

export interface DocumentTemplateDoc {
  /** Bumped only by a migration. The compiler refuses a version it postdates. */
  schemaVersion: 1;
  documentType: string;
  locale: string;
  dir: 'ltr' | 'rtl';
  page: PageSetup;
  theme: ThemeBinding;
  body: Block[];
  /** Repeating page footer. Page numbers are added by the renderer. */
  footer?: { html: string; showPageNumbers: boolean };
}

export const DOC_SCHEMA_VERSION = 1 as const;

/**
 * The GrapesJS visual-editor dialect — schemaVersion 2.
 *
 * A SECOND authoring surface, not a replacement: v1 block documents keep the
 * block builder and `compileDocument`; v2 documents come from the GrapesJS
 * canvas and go through `compileGrapesDocument`. Everything downstream of the
 * sanitizer is shared.
 *
 * Every top-level field except `body`→`grapes` matches v1 DELIBERATELY, so the
 * preview routes and the render envelope read `page`, `locale`, `dir`, `theme`
 * and `footer` off either dialect without branching.
 */
export interface GrapesTemplateDoc {
  schemaVersion: 2;
  kind: 'grapes';
  documentType: string;
  locale: string;
  dir: 'ltr' | 'rtl';
  page: PageSetup;
  theme: ThemeBinding;
  grapes: {
    /**
     * `editor.getProjectData()` — the EDITOR's source of truth, restored via
     * `loadProjectData` so chips and component types rehydrate losslessly.
     * Opaque to the server: stored, echoed back, never parsed, never rendered.
     */
    project: unknown;
    /** `editor.getHtml()` at save time — the transform's input, never trusted. */
    html: string;
    /** `editor.getCss()` — scrubbed into styleCss. */
    css: string;
  };
  footer?: { html: string; showPageNumbers: boolean };
}

export type AnyTemplateDoc = DocumentTemplateDoc | GrapesTemplateDoc;

export function isGrapesDoc(doc: unknown): doc is GrapesTemplateDoc {
  const d = doc as GrapesTemplateDoc | null;
  return Boolean(d && d.schemaVersion === 2 && d.kind === 'grapes');
}

export function defaultPageSetup(): PageSetup {
  return {
    size: 'A4',
    orientation: 'portrait',
    margin: { top: 20, right: 18, bottom: 20, left: 18 },
    letterhead: { source: 'company', firstPageOnly: true },
  };
}

export function defaultTheme(): ThemeBinding {
  return {
    followBrand: true,
    primary: '@brand.primary',
    baseFontSizePt: 11,
    lineHeight: 1.6,
  };
}
