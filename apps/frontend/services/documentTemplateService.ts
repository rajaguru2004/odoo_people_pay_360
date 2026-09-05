import axiosInstance from '@/lib/axios';
import { saveBlob, unwrapBlob } from '@/lib/fileDownload';
import {
  AnyTemplateDoc,
  GrapesTemplateDoc,
  DocumentAssetSummary,
  DocumentTemplateDetail,
  DocumentTemplateDoc,
  DocumentTemplateSummary,
  DocumentTypeSummary,
  DocumentVersionDetail,
  GeneratedDocumentSummary,
  GenerateResult,
  TokenManifest,
} from '@/types/document-template';

/**
 * The document template engine's client.
 *
 * Two response shapes to keep straight, and `lib/axios.ts` is the reason:
 * a `responseType: 'blob'` call gets the WHOLE AxiosResponse back, everything
 * else gets `response.data`. Every blob method here unwraps explicitly through
 * `unwrapBlob` rather than relying on the caller to remember.
 *
 * That is also why HTML preview is a separate method returning JSON rather
 * than the same endpoint with a format flag: mixing the two response styles
 * behind one parameter is exactly how the rule gets forgotten.
 */
class DocumentTemplateService {
  // ── Catalogue ─────────────────────────────────────────────────────────────

  async types(): Promise<DocumentTypeSummary[]> {
    return axiosInstance.get('/documents/types');
  }

  async manifest(typeKey: string): Promise<TokenManifest> {
    return axiosInstance.get(`/documents/types/${typeKey}/manifest`);
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  async list(params: { typeKey?: string; locale?: string } = {}): Promise<DocumentTemplateSummary[]> {
    return axiosInstance.get('/documents/templates', { params });
  }

  async get(id: string): Promise<DocumentTemplateDetail> {
    return axiosInstance.get(`/documents/templates/${id}`);
  }

  async duplicate(
    id: string,
    body: { scope: 'COMPANY' | 'BRANCH'; branchId?: string; name?: string; locale?: string },
  ): Promise<DocumentTemplateDetail> {
    return axiosInstance.post(`/documents/templates/${id}/duplicate`, body);
  }

  /** Open a new draft. Passing `fromVersionId` is how a rollback is performed. */
  async createDraft(id: string, fromVersionId?: string): Promise<DocumentVersionDetail> {
    return axiosInstance.post(
      `/documents/templates/${id}/versions${fromVersionId ? `?from=${fromVersionId}` : ''}`,
    );
  }

  async saveDraft(
    versionId: string,
    body: {
      doc: AnyTemplateDoc;
      expectedUpdatedAt?: string;
      changeNote?: string;
      letterheadId?: string | null;
    },
  ): Promise<DocumentVersionDetail> {
    return axiosInstance.put(`/documents/versions/${versionId}`, body);
  }

  async publish(versionId: string, expectedContentHash?: string): Promise<DocumentTemplateDetail> {
    return axiosInstance.post(`/documents/versions/${versionId}/publish`, {
      expectedContentHash,
    });
  }

  /** Seed for converting a v1 draft to the visual editor (flag-gated server-side). */
  async visualSeed(versionId: string): Promise<{ doc: GrapesTemplateDoc; dropped: string[] }> {
    return axiosInstance.get(`/documents/versions/${versionId}/visual-seed`);
  }

  async discardDraft(versionId: string): Promise<{ success: boolean }> {
    return axiosInstance.delete(`/documents/versions/${versionId}`);
  }

  // ── Preview ───────────────────────────────────────────────────────────────

  /**
   * Exact compiled markup with sample data. Needs no Chromium, which is what
   * makes it the preview that always works.
   */
  async previewHtml(body: {
    doc?: AnyTemplateDoc;
    versionId?: string;
    typeKey?: string;
    letterheadId?: string;
  }): Promise<{ html: string; removed: string[] }> {
    return axiosInstance.post('/documents/preview/html', body);
  }

  /** A real PDF. Returns the whole AxiosResponse's blob, already unwrapped. */
  async previewPdf(body: {
    doc?: AnyTemplateDoc;
    versionId?: string;
    typeKey?: string;
    letterheadId?: string;
  }): Promise<Blob> {
    const res = await axiosInstance.post('/documents/preview/pdf', body, {
      responseType: 'blob',
    });
    return unwrapBlob(res);
  }

  // ── Generation ────────────────────────────────────────────────────────────

  async generate(body: {
    typeKey: string;
    locale?: string;
    employeeId?: string;
    subjectId?: string;
    params?: Record<string, unknown>;
  }): Promise<GenerateResult> {
    return axiosInstance.post('/documents/generate', body);
  }

  async mine(typeKey?: string): Promise<GeneratedDocumentSummary[]> {
    return axiosInstance.get('/documents/mine', { params: typeKey ? { typeKey } : {} });
  }

  /**
   * Download a generated document through the authenticated door.
   *
   * Never `window.open`: the JWT lives in local storage, so a plain tab
   * navigation carries no Authorization header and the route answers 401.
   */
  async download(documentId: string, fileName: string): Promise<void> {
    const res = await axiosInstance.get(`/secure-files/generated-document/${documentId}`, {
      responseType: 'blob',
    });
    saveBlob(unwrapBlob(res), fileName);
  }

  /** Generate then immediately save — what the download button does. */
  async generateAndDownload(body: {
    typeKey: string;
    locale?: string;
    employeeId?: string;
    subjectId?: string;
    params?: Record<string, unknown>;
  }): Promise<GenerateResult> {
    const result = await this.generate(body);
    await this.download(result.documentId, result.fileName);
    return result;
  }

  // ── Letterheads ───────────────────────────────────────────────────────────

  async listAssets(kind = 'LETTERHEAD'): Promise<DocumentAssetSummary[]> {
    return axiosInstance.get('/documents/assets', { params: { kind } });
  }

  /**
   * Upload a letterhead.
   *
   * The Content-Type header MUST be overridden here. `lib/axios.ts` sets
   * `application/json` in the instance defaults, which axios then applies to
   * every request — including one whose body is FormData. The request goes out
   * declared as JSON, multer finds no multipart body, and the server answers
   * "No file was uploaded" with nothing in the log to suggest the file was ever
   * attached. Every other upload in this codebase overrides it the same way.
   */
  async uploadAsset(
    file: File,
    fields: Partial<Record<'name' | 'scope' | 'branchId' | 'kind', string>> = {},
  ): Promise<DocumentAssetSummary & { warning: string | null }> {
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
    return axiosInstance.post('/documents/assets', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  }

  async updateAsset(
    id: string,
    body: Partial<Record<'name' | 'safeTopMm' | 'safeRightMm' | 'safeBottomMm' | 'safeLeftMm', unknown>>,
  ): Promise<DocumentAssetSummary> {
    return axiosInstance.put(`/documents/assets/${id}`, body);
  }

  async deleteAsset(id: string): Promise<{ success: boolean; message: string }> {
    return axiosInstance.delete(`/documents/assets/${id}`);
  }

  /** Letterhead artwork as an object URL, fetched with the JWT attached. */
  async assetPreviewUrl(id: string): Promise<string> {
    const res = await axiosInstance.get(`/secure-files/document-asset/${id}`, {
      responseType: 'blob',
    });
    return URL.createObjectURL(unwrapBlob(res));
  }

  // ── Renderer health ───────────────────────────────────────────────────────

  async health(): Promise<{
    pdfEnabled: boolean;
    chromiumPath: string | null;
    browserLaunchOk: boolean;
    fonts: { latin: boolean; arabic: boolean; missing: string[] };
    lastRenderError: string | null;
  }> {
    return axiosInstance.get('/documents/health');
  }
}

export const documentTemplateService = new DocumentTemplateService();
export default documentTemplateService;
