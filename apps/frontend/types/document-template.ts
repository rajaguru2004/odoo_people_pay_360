/**
 * Document template types.
 *
 * The block-document shapes below mirror
 * `apps/backend/src/documents/document-doc.model.ts` exactly. They are the
 * contract between the builder and the compiler: the frontend emits this JSON
 * and the SERVER compiles it to Handlebars and sanitizes the result. The
 * frontend never produces template HTML, which is what keeps the sanitization
 * boundary on the server rather than in a browser the user controls.
 *
 * Changing a shape here without changing it there produces a template that
 * saves and then renders as something else.
 */

export type Align = 'start' | 'center' | 'end' | 'justify';
export type Mm = number;

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
    firstPageOnly: boolean;
  };
}

export interface ThemeBinding {
  followBrand: boolean;
  primary?: ColorValue;
  accent?: ColorValue;
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

export interface TableColumn {
  key: string;
  header: string;
  align?: Align;
  format?: 'money' | 'num' | 'date' | 'none';
  widthPct?: number;
}

export interface BlockCommon {
  id: string;
  visibleWhen?: Condition;
  spacingAfterMm?: Mm;
  /** Catalogue-critical blocks: restyle yes, delete no. */
  locked?: boolean;
}

export type BlockType =
  | 'text'
  | 'heading'
  | 'logo'
  | 'spacer'
  | 'divider'
  | 'keyValue'
  | 'dataTable'
  | 'signature'
  | 'pageBreak'
  | 'rawHtml';

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
  schemaVersion: 1;
  documentType: string;
  locale: string;
  dir: 'ltr' | 'rtl';
  page: PageSetup;
  theme: ThemeBinding;
  body: Block[];
  footer?: { html: string; showPageNumbers: boolean };
}

export const DOC_SCHEMA_VERSION = 1 as const;

/**
 * The GrapesJS visual-editor dialect — schemaVersion 2. Mirrors
 * `apps/backend/src/documents/document-doc.model.ts` verbatim, same contract
 * as the v1 shape above.
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
    /** editor.getProjectData() — the editor's source of truth, opaque to the server. */
    project: unknown;
    /** editor.getHtml() at save — the server transform's input, never trusted. */
    html: string;
    /** editor.getCss() — scrubbed into styleCss server-side. */
    css: string;
  };
  footer?: { html: string; showPageNumbers: boolean };
}

export type AnyTemplateDoc = DocumentTemplateDoc | GrapesTemplateDoc;

export function isGrapesDoc(doc: unknown): doc is GrapesTemplateDoc {
  const d = doc as GrapesTemplateDoc | null;
  return Boolean(d && d.schemaVersion === 2 && d.kind === 'grapes');
}

// ── API shapes ──────────────────────────────────────────────────────────────

export type DocumentTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type DocumentScope = 'COMPANY' | 'BRANCH';

export interface DocumentTypeSummary {
  key: string;
  name: string;
  description: string;
  category: string;
  cardinality: 'single' | 'bulk';
  subjectType: string;
  selfService: boolean;
  sensitivity: 'INTERNAL' | 'PERSONAL' | 'PAY' | 'RESTRICTED';
  defaultLocales: string[];
}

export interface DocumentTemplateSummary {
  id: string;
  typeKey: string;
  typeName: string;
  locale: string;
  name: string;
  description: string | null;
  scope: DocumentScope;
  branchId: string | null;
  branchName: string | null;
  origin: 'SYSTEM' | 'CUSTOM';
  isCustomized: boolean;
  publishedVersionId: string | null;
  publishedVersionNo: number | null;
  publishedAt: string | null;
  hasDraft: boolean;
  draftVersionId: string | null;
  versionCount: number;
  updatedAt: string;
}

export interface DocumentVersionSummary {
  id: string;
  versionNo: number;
  status: DocumentTemplateStatus;
  changeNote: string | null;
  contentHash: string;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersionDetail {
  id: string;
  versionNo: number;
  status: DocumentTemplateStatus;
  doc: DocumentTemplateDoc | null;
  bodyHtml: string;
  styleCss: string | null;
  footerHtml: string | null;
  pageFormat: string;
  orientation: string;
  /** The letterhead pinned to this version, if any. */
  letterheadId?: string | null;
  contentHash: string;
  updatedAt: string;
  /** Tags the sanitizer stripped, so the UI can say so rather than silently changing the design. */
  removed?: string[];
}

export interface DocumentTemplateDetail extends Omit<DocumentTemplateSummary, 'hasDraft' | 'draftVersionId' | 'versionCount' | 'publishedVersionNo' | 'publishedAt'> {
  versions: DocumentVersionSummary[];
  draft: DocumentVersionDetail | null;
  published: DocumentVersionDetail | null;
}

export interface TokenDef {
  path: string;
  label: string;
  type: string;
  sampleValue: unknown;
  alwaysPresent: boolean;
  columns: { name: string; label: string; type: string }[] | null;
}

export interface TokenManifest {
  documentType: string;
  name: string;
  groups: { group: string; tokens: TokenDef[] }[];
  collections: {
    path: string;
    label: string;
    fields: { name: string; label: string; type: string }[];
    sampleRows: unknown;
  }[];
  sample: Record<string, unknown>;
}

export interface DocumentAssetSummary {
  id: string;
  kind: 'LETTERHEAD' | 'SIGNATURE' | 'SEAL';
  name: string;
  scope: DocumentScope;
  branchId: string | null;
  branchName: string | null;
  mimeType: string;
  fileSize: number;
  widthPx: number | null;
  heightPx: number | null;
  /** The content-safe area, in millimetres — where body text may go. */
  safeTopMm: number;
  safeRightMm: number;
  safeBottomMm: number;
  safeLeftMm: number;
  isActive: boolean;
  createdAt: string;
  /** Authenticated only; the artwork is never public. */
  previewPath: string;
}

export interface GeneratedDocumentSummary {
  id: string;
  typeKey: string;
  typeName: string;
  locale: string;
  fileName: string;
  serialNumber: string | null;
  generatedAt: string;
  downloadPath: string;
}

export interface GenerateResult {
  documentId: string;
  fileName: string;
  serialNumber: string | null;
  downloadPath: string;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  code:
    | 'MALFORMED_TOKEN'
    | 'UNKNOWN_TOKEN'
    | 'UNBOUND_COLLECTION'
    | 'EMPTY_BLOCK'
    | 'NO_COLUMNS'
    | 'OPTIONAL_NO_FALLBACK'
    | 'UNKNOWN_CONDITION_PATH';
  blockId: string | null;
  message: string;
  detail?: string;
}
